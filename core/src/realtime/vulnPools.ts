// Environment-side lifecycle of vulnerability-appearance events (malicious pools) (ADR 0014 §1,2,5,6).
//
// Encapsulates the responsibilities of the environment daemon called from the coordinator (the agent-side
// discovery/verification is separated into examples/agents/lib/poolDiscovery.ts / verifyContract.ts):
//   1. deployVulnPools  : in the setup phase, deploy the factory + all pools (a mix of honest/rigged) and
//                         issue disclosures/<addr>.json (source+codehash).
//   2. fundVulnPoolsAt  : at each pool's window (startBlock), fund via cheatcode (burn bait into the reserve)
//                         and emit pool_created / vulnerability_disclosed into events.jsonl.
//   3. watchVulnSwaps   : every block, scan each pool's Swap logs and emit, as ground-truth, rigged hits
//                         (vulnerability_exploited) / safe pool executions (safe_pool_captured).
//
// Design decisions:
//   - Do the deploy robustly in setup (before interval mining; auto-mine/sendAndMine) and only "spring up" the
//     funding via a window cheatcode. Injecting the deploy itself during interval mining would race with mining
//     (unlike keeper/oracle, a CREATE requires receipt finalization). Before funding, a pool has reserve=0 and
//     does not look like an opportunity, so the "appearance" as seen by agents coincides with the window funding.
//   - The codehash depends on the runtime bytecode with immutable values baked in, so it cannot be computed from
//     the artifact. After deploy, finalize it per-instance via eth_getCode(address) → keccak256 (the agent side
//     matches it with the same computation; ADR 0014 §5).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeEventLog,
  encodeFunctionData,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { dealErc20, sendAndMine } from "@eris/sdk/chain.js";
import { deployContract } from "@eris/sdk/protocols/deploy.js";
import type { SimConfig } from "../config.js";
import type { RunLogger } from "../logger.js";
import { tokenInfo } from "@eris/sdk/markets.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import type { ResolvedVulnPool, VulnSchedule } from "./vulnEvents.js";

const here = dirname(fileURLToPath(import.meta.url));

// Minimal ABI used to call the factory / decode PoolCreated.
export const vulnFactoryAbi = [
  {
    type: "function",
    name: "createSimplePool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "feeBps", type: "uint24" },
    ],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "createRiggedPool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "feeBps", type: "uint24" },
      { name: "rugThreshold", type: "uint256" },
      { name: "rugBps", type: "uint24" },
    ],
    outputs: [{ type: "address" }],
  },
  {
    type: "event",
    name: "PoolCreated",
    inputs: [
      { name: "pool", type: "address", indexed: true },
      { name: "token0", type: "address", indexed: true },
      { name: "token1", type: "address", indexed: true },
      { name: "feeBps", type: "uint24", indexed: false },
    ],
  },
] as const satisfies Abi;

// The AMM's Swap event (used for hit detection; common to SimpleAMM/RiggedAMM).
export const vulnAmmSwapAbi = [
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "to", type: "address", indexed: true },
      { name: "tokenIn", type: "address", indexed: false },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

export type VulnPoolRuntime = {
  pool: Address;
  meta: ResolvedVulnPool;
  token0: Address; // base
  token1: Address; // USDC (quote)
  rugThresholdUnits: bigint; // rigged skim threshold (denominated in tokenIn=USDC; 0 for safe)
  codehash: Hex;
  funded: boolean;
};

export type VulnRuntime = {
  factory: Address;
  factoryDeployBlock: bigint;
  disclosuresDir: string;
  pools: VulnPoolRuntime[];
};

// The source put in a disclosure is equivalent to "verified source a production explorer serves". Distributing
// comments that reveal design intent ("malicious pool"/"skim" etc.) or the contract names (RiggedAMM/SimpleAMM)
// as-is would let an agent classify via comment grep / contractName without reading the swap logic, making the
// LLM source audit no longer load-bearing (contrary to the intent of ADR 0014 §4). So strip comments and
// neutralize the contract name before distributing (the codehash is computed separately from the real bytecode,
// so consistency is preserved).
function sanitizedSource(name: string): string {
  const raw = readFileSync(
    resolve(here, `../../../contracts/${name}.sol`),
    "utf8",
  );
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/[^\n]*/g, "") // line comments
    .replace(/\b(RiggedAMM|SimpleAMM)\b/g, "LiquidityPool") // neutralize the contract name
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Compute the rigged skim threshold (denominated in tokenIn=USDC) as per-round USDC cap × frac.
function rugThresholdUnits(config: SimConfig, frac: number): bigint {
  const scaled = BigInt(Math.round(frac * 1_000_000));
  return (config.maxAgentUsdcInUnits * scaled) / 1_000_000n;
}

// setup: deploy the factory + all pools and issue disclosures (funding is done at the window).
export async function deployVulnPools(
  ctx: SimContext,
  schedule: VulnSchedule,
  config: SimConfig,
  logger: RunLogger,
): Promise<VulnRuntime> {
  const { publicClient, walletClient, chain, adminPk } = ctx;
  const factory = await deployContract(ctx, "VulnPoolFactory", []);
  const factoryDeployBlock = await publicClient.getBlockNumber();
  logger.event({
    type: "vuln_factory_deployed",
    address: factory,
    deployBlock: factoryDeployBlock.toString(),
  });

  const disclosuresDir = join(logger.runDir, "disclosures");
  mkdirSync(disclosuresDir, { recursive: true });

  const usdc = tokenInfo("USDC").address;
  const feeBps = config.vulnPoolFeeBps;
  const pools: VulnPoolRuntime[] = [];

  for (const meta of schedule.pools()) {
    const base = tokenInfo(meta.base).address;
    const threshold = meta.rigged
      ? rugThresholdUnits(config, meta.rugThresholdFrac)
      : 0n;
    const data = meta.rigged
      ? encodeFunctionData({
          abi: vulnFactoryAbi,
          functionName: "createRiggedPool",
          args: [base, usdc, feeBps, threshold, meta.rugBps],
        })
      : encodeFunctionData({
          abi: vulnFactoryAbi,
          functionName: "createSimplePool",
          args: [base, usdc, feeBps],
        });
    const hash = await sendAndMine(publicClient, walletClient, chain, adminPk, {
      to: factory,
      data,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const pool = extractPoolAddress(receipt.logs, factory);
    if (!pool) throw new Error(`vuln pool #${meta.poolIndex} deploy failed`);

    // per-instance codehash (runtime bytecode after immutables are baked in; ADR 0014 §5).
    const code = (await publicClient.getCode({ address: pool })) ?? "0x";
    const codehash = keccak256(code as Hex);

    // disclosure record (equivalent to a production explorer; the agent matches the codehash via eth_getCode).
    // The source is neutralized (comments stripped, contract name unified to LiquidityPool) = rigged/safe cannot
    // be told apart without reading the swap logic. The ground-truth (rigged) is held only on the events.jsonl side.
    const disclosure = {
      address: pool,
      sourceCode: sanitizedSource(meta.rigged ? "RiggedAMM" : "SimpleAMM"),
      contractName: "LiquidityPool",
      compiler: "0.8.20",
      codehash,
    };
    writeFileSync(
      join(disclosuresDir, `${pool.toLowerCase()}.json`),
      `${JSON.stringify(disclosure, null, 2)}\n`,
    );

    pools.push({
      pool,
      meta,
      token0: base,
      token1: usdc,
      rugThresholdUnits: threshold,
      codehash,
      funded: false,
    });
  }

  return { factory, factoryDeployBlock, disclosuresDir, pools };
}

function extractPoolAddress(
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
  factory: Address,
): Address | undefined {
  for (const log of logs) {
    if (log.address.toLowerCase() !== factory.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: vulnFactoryAbi,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      if (decoded.eventName === "PoolCreated") {
        return (decoded.args as { pool: Address }).pool;
      }
    } catch {
      // ignore non-PoolCreated logs
    }
  }
  return undefined;
}

// window: burn reserve into the pools that "spring up" at this blockIndex (cheatcode), making the bait-laden
// opportunity appear. fair is per-base (fairByBase). Emits pool_created / vulnerability_disclosed.
export async function fundVulnPoolsAt(
  ctx: SimContext,
  runtime: VulnRuntime,
  blockIndex: number,
  blockNumber: number,
  fairByBase: Record<string, number>,
  config: SimConfig,
  logger: RunLogger,
): Promise<void> {
  const { publicClient } = ctx;
  for (const p of runtime.pools) {
    // Fund exactly once at the first processed block at or after startBlock (funded latch). It uses ">=" rather
    // than an exact match because if the coordinator's onBlock drops a block that arrived while processing, the
    // window block's blockIndex can be skipped (prevents that pool from being funded forever).
    if (p.funded || p.meta.startBlock > blockIndex) continue;
    // Isolate exceptions per pool (so one pool's dealErc20 failure does not drag down other pools' funding at the
    // same blockIndex). startBlock is shared within an event, so multiple pools cluster on the same block.
    try {
      const fair = fairByBase[p.meta.base];
      if (!fair || fair <= 0) {
        // In practice fairPrices includes all bases so this is not hit, but avoid a silent disappearance and leave a diagnostic.
        logger.event({
          type: "vuln_fund_skipped",
          pool: p.pool,
          base: p.meta.base,
          reason: "fair price missing or non-positive",
          blockIndex,
        });
        p.funded = true; // fair is unchanged within the same block even on retry. Latch to avoid an infinite loop.
        continue;
      }
      const baseDec = tokenInfo(p.meta.base).decimals;
      const baseUnit = 10n ** BigInt(baseDec);
      // reserve: on the base side, stack liquidity-equivalent (denominated in USDC). On the quote side, stack at
      // the ratio that makes base look baitBps cheaper than fair (poolPrice = fair·(1−bait)) → the agent can buy
      // "cheap base".
      const priceScaled = BigInt(Math.round(fair * 1_000_000));
      // baitBps is already limited to <=9000 at parse time, but double-guard by confirming baitFactor>0.
      const baitFactor = Math.max(0.01, 1 - p.meta.baitBps / 10_000);
      const poolPriceScaled = BigInt(Math.round(fair * baitFactor * 1_000_000));
      if (priceScaled <= 0n || poolPriceScaled <= 0n) {
        p.funded = true;
        continue;
      }
      const reserveBaseWei =
        (config.vulnPoolLiquidityUsdcUnits * baseUnit) / priceScaled;
      const reserveQuoteUnits = (reserveBaseWei * poolPriceScaled) / baseUnit;

      await dealErc20(publicClient, p.token0, p.pool, reserveBaseWei);
      await dealErc20(publicClient, p.token1, p.pool, reserveQuoteUnits);
      p.funded = true;

      const impliedPrice = fair * baitFactor;
      // ground-truth (for scoring): includes rigged / rug parameters.
      logger.event({
        type: "pool_created",
        pool: p.pool,
        base: p.meta.base,
        quote: "USDC",
        rigged: p.meta.rigged,
        feeBps: config.vulnPoolFeeBps,
        baitBps: p.meta.baitBps,
        rugBps: p.meta.rigged ? p.meta.rugBps : 0,
        rugThresholdUnits: p.rugThresholdUnits.toString(),
        eventIndex: p.meta.eventIndex,
        blockNumber,
        blockIndex,
      });
      // Disclosure (the agent does an on-demand lookup of disclosures/<addr>.json; this is the appearance record).
      logger.event({
        type: "vulnerability_disclosed",
        pool: p.pool,
        base: p.meta.base,
        codehash: p.codehash,
        reserveBaseWei: reserveBaseWei.toString(),
        reserveQuoteUnits: reserveQuoteUnits.toString(),
        impliedPrice,
        fair,
        baitBps: p.meta.baitBps,
        blockNumber,
        blockIndex,
      });
    } catch (error) {
      logger.event({
        type: "vuln_fund_failed",
        pool: p.pool,
        base: p.meta.base,
        blockIndex,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// Every block: scan funded pools' Swap logs over [fromBlock,toBlock] and emit hits/executions as ground-truth
// (ADR 0014 §6; judged by actual behavior, not an LLM verdict).
export async function watchVulnSwaps(
  ctx: SimContext,
  runtime: VulnRuntime,
  fromBlock: number,
  toBlock: number,
  logger: RunLogger,
): Promise<void> {
  if (fromBlock > toBlock) return;
  const { publicClient } = ctx;
  const funded = runtime.pools.filter((p) => p.funded);
  if (funded.length === 0) return;
  const byAddress = new Map(funded.map((p) => [p.pool.toLowerCase(), p]));
  const logs = await publicClient.getLogs({
    address: funded.map((p) => p.pool),
    event: vulnAmmSwapAbi[0],
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
  });
  for (const log of logs) {
    const p = byAddress.get(log.address.toLowerCase());
    if (!p) continue;
    const args = log.args as {
      to?: Address;
      tokenIn?: Address;
      amountIn?: bigint;
      amountOut?: bigint;
    };
    const amountIn = args.amountIn ?? 0n;
    const trader = args.to ?? "0x0";
    const buyBase =
      (args.tokenIn ?? "").toLowerCase() === p.token1.toLowerCase();
    if (p.meta.rigged) {
      // Match the skim condition exactly with RiggedAMM.swap: fires when amountIn>rugThreshold regardless of
      // direction. (Adding a buyBase gate would misreport a trade actually skimmed in the base-sell direction as
      // skimmed:false. Since the threshold is denominated in USDC, this also reflects that base sells [wei scale]
      // are effectively always above the threshold and get skimmed.)
      const skimmed = amountIn > p.rugThresholdUnits;
      logger.event({
        type: "vulnerability_exploited",
        pool: p.pool,
        base: p.meta.base,
        trader,
        buyBase,
        amountIn: amountIn.toString(),
        amountOut: (args.amountOut ?? 0n).toString(),
        skimmed,
        rugBps: skimmed ? p.meta.rugBps : 0,
        blockNumber: Number(log.blockNumber ?? 0n),
      });
    } else {
      logger.event({
        type: "safe_pool_captured",
        pool: p.pool,
        base: p.meta.base,
        trader,
        amountIn: amountIn.toString(),
        amountOut: (args.amountOut ?? 0n).toString(),
        blockNumber: Number(log.blockNumber ?? 0n),
      });
    }
  }
}
