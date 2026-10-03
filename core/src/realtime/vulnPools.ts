// Environment-side lifecycle of vulnerability-appearance events (malicious pools) (ADR 0014 §1,2,5,6).
//
// Encapsulates the responsibilities of the environment daemon called from the coordinator (the agent-side
// discovery/verification is separated into examples/agents/lib/poolDiscovery.ts / verifyContract.ts):
//   1. setupVulnFactory : in the setup phase of *every* run, deploy the factory (owned by the pool wallet)
//                         and create the disclosures/ directory. Nothing else.
//   2. stepVulnPools    : at each pool's window, deploy it through the factory; once the deploy lands,
//                         issue disclosures/<addr>.json (source+codehash), fund it via cheatcode (burn bait
//                         into the reserve) and emit pool_created / vulnerability_disclosed into events.jsonl.
//   3. watchVulnSwaps   : every block, scan each pool's Swap logs and emit, as ground-truth, rigged hits
//                         (vulnerability_exploited) / safe pool executions (safe_pool_captured).
//
// Design decisions:
//   - Nothing about a vuln run is visible before its window. The pools used to be deployed at setup
//     through createSimplePool / createRiggedPool: from block 0 anyone could count them, read their
//     addresses, audit them at leisure, and read the answer off the creating transaction's selector
//     (with the skim threshold and fraction as plain arguments). Now the factory and the disclosures/
//     directory exist in every run, vuln or not, its owner is funded identically in every run, and a
//     pool is created at its window by `createPool(initCode)` -- calldata that says no more than the
//     pool's bytecode does once it exists.
//   - The deploy is sent at the window's block and lands in the next one; funding follows when the
//     receipt is in. So a pool appears one block later than its window index, with reserve 0 in its
//     first block (it does not look like an opportunity until funded, as before).
//   - The pool wallet is its own key: the oracle sends from admin every block and the registrar from
//     setup, and two senders on one key race on the nonce. Gas is pinned, because a batch of creates
//     from one key in one block cannot be estimated against the state before the first lands.
//   - The codehash depends on the runtime bytecode with immutable values baked in, so it cannot be computed from
//     the artifact. After deploy, finalize it per-instance via eth_getCode(address) → keccak256 (the agent side
//     matches it with the same computation; ADR 0014 §5).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeEventLog,
  encodeDeployData,
  encodeFunctionData,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { dealErc20 } from "@eris/sdk/chain.js";
import { readForgeArtifact } from "@eris/sdk/forge.js";
import { deployContract } from "@eris/sdk/protocols/deploy.js";
import type { SimConfig } from "../config.js";
import { environmentKey } from "../walletKeys.js";
import type { RunLogger } from "../logger.js";
import { tokenInfo } from "@eris/sdk/markets.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import type { ResolvedVulnPool, VulnSchedule } from "./vulnEvents.js";

const here = dirname(fileURLToPath(import.meta.url));

// Minimal ABI used to call the factory / decode PoolCreated.
export const vulnFactoryAbi = [
  {
    type: "function",
    name: "createPool",
    stateMutability: "nonpayable",
    inputs: [{ name: "initCode", type: "bytes" }],
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

// Gas pinned on each createPool (a pool deploy is well under 1M; the margin is for the factory's
// read-back calls and the allPools push).
const GAS_CREATE_POOL = 3_000_000n;
// Blocks to wait for a submitted deploy before treating it as lost.
const PENDING_TIMEOUT_BLOCKS = 3;
// How many times a deploy that reverted or was lost is retried before the pool is given up on.
const DEPLOY_ATTEMPTS = 3;

/** The environment wallet that owns the factory and deploys the pools. */
export type VulnPoolWallet = { address: Address; privateKey: Hex };

/**
 * The pool wallet, keyed like every other environment wallet (issue #189): from the wallet secret,
 * never from the seed. One per run, vuln or not.
 */
export function deriveVulnPoolWallet(): VulnPoolWallet {
  const privateKey = environmentKey("vuln-pools", "owner");
  return { address: privateKeyToAccount(privateKey).address, privateKey };
}

export type VulnPoolRuntime = {
  meta: ResolvedVulnPool;
  token0: Address; // base
  token1: Address; // USDC (quote)
  rugThresholdUnits: bigint; // rigged skim threshold (denominated in tokenIn=USDC; 0 for safe)
  // pending: before its window / deploying: createPool sent / deployed: on-chain, not yet funded /
  // funded: live (or given up on funding) / failed: the deploy never landed.
  phase: "pending" | "deploying" | "deployed" | "funded" | "failed";
  deploy?: { hash: Hex; blockIndex: number };
  attempts: number;
  pool?: Address;
  codehash?: Hex;
  funded: boolean;
};

export type VulnRuntime = {
  factory: Address;
  factoryDeployBlock: bigint;
  disclosuresDir: string;
  owner: VulnPoolWallet;
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

// The rigged skim threshold (denominated in tokenIn=USDC): a fraction of the USDC an agent is
// funded with. It used to be a fraction of the per-round USDC cap, which is gone -- and a threshold
// has to stay on the scale of a trade someone would actually make, or the pool either skims
// everyone (too low) or no one (too high) and stops discriminating between the agents that checked
// the pool and the agents that did not.
function rugThresholdUnits(config: SimConfig, frac: number): bigint {
  const scaled = BigInt(Math.round(frac * 1_000_000));
  return (config.initialUsdcUnits * scaled) / 1_000_000n;
}

// setup (every run): deploy the factory owned by the pool wallet and create the disclosures/ directory.
// Pools come later, one by one at their windows (stepVulnPools). A run with no vuln events ends up with an
// empty factory and an empty directory -- indistinguishable, before a window, from a run that has them.
export async function setupVulnFactory(
  ctx: SimContext,
  schedule: VulnSchedule,
  config: SimConfig,
  owner: VulnPoolWallet,
  runDir: string,
  logger: RunLogger,
): Promise<VulnRuntime> {
  const factory = await deployContract(ctx, "VulnPoolFactory", [owner.address]);
  const factoryDeployBlock = await ctx.publicClient.getBlockNumber();
  logger.event({
    type: "vuln_factory_deployed",
    address: factory,
    owner: owner.address,
    deployBlock: factoryDeployBlock.toString(),
  });

  const disclosuresDir = join(runDir, "disclosures");
  mkdirSync(disclosuresDir, { recursive: true });

  const usdc = tokenInfo("USDC").address;
  const pools: VulnPoolRuntime[] = schedule.pools().map((meta) => ({
    meta,
    token0: tokenInfo(meta.base).address,
    token1: usdc,
    rugThresholdUnits: meta.rigged
      ? rugThresholdUnits(config, meta.rugThresholdFrac)
      : 0n,
    phase: "pending" as const,
    attempts: 0,
    funded: false,
  }));
  // Read the artifacts once here so a missing build fails at setup, not on the window's block.
  if (pools.length > 0) {
    readForgeArtifact("SimpleAMM");
    readForgeArtifact("RiggedAMM");
  }
  return { factory, factoryDeployBlock, disclosuresDir, owner, pools };
}

// The pool's init code: the contract's creation bytecode plus its constructor arguments. Both kinds
// go through the same factory entry point, so this is the only place the kind is decided.
function poolInitCode(p: VulnPoolRuntime, feeBps: number): Hex {
  if (p.meta.rigged) {
    const { abi, bytecode } = readForgeArtifact("RiggedAMM");
    return encodeDeployData({
      abi,
      bytecode,
      args: [p.token0, p.token1, feeBps, p.rugThresholdUnits, p.meta.rugBps],
    } as never);
  }
  const { abi, bytecode } = readForgeArtifact("SimpleAMM");
  return encodeDeployData({
    abi,
    bytecode,
    args: [p.token0, p.token1, feeBps],
  } as never);
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

/**
 * One block of the vuln schedule: settle the deploys sent earlier (disclose and fund the ones that
 * landed), then send a createPool for every pool whose window has opened. Returns the hashes it sent,
 * for blocks.csv attribution.
 *
 * Window matching is ">=" rather than exact: if the coordinator's onBlock drops a block that arrived
 * while processing, the window block's blockIndex can be skipped (a pool must not wait forever).
 */
export async function stepVulnPools(
  ctx: SimContext,
  runtime: VulnRuntime,
  blockIndex: number,
  blockNumber: number,
  fairByBase: Record<string, number>,
  config: SimConfig,
  opts: { priorityFeeWei: bigint },
  logger: RunLogger,
): Promise<Hex[]> {
  for (const p of runtime.pools) {
    if (p.phase === "deploying")
      await settleDeploy(ctx, runtime, p, blockIndex, logger);
    // Funding failures are isolated per pool (fundPool catches), so one pool's dealErc20 failure does
    // not drag down the others; an unfunded pool is retried on the next block.
    if (p.phase === "deployed")
      await fundPool(
        ctx,
        p,
        blockIndex,
        blockNumber,
        fairByBase,
        config,
        logger,
      );
  }
  const due = runtime.pools.filter(
    (p) => p.phase === "pending" && p.meta.startBlock <= blockIndex,
  );
  if (due.length === 0) return [];
  return sendDeploys(ctx, runtime, due, blockIndex, config, opts, logger);
}

async function sendDeploys(
  ctx: SimContext,
  runtime: VulnRuntime,
  due: VulnPoolRuntime[],
  blockIndex: number,
  config: SimConfig,
  opts: { priorityFeeWei: bigint },
  logger: RunLogger,
): Promise<Hex[]> {
  const account = privateKeyToAccount(runtime.owner.privateKey);
  let nonce = await ctx.publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hashes: Hex[] = [];
  for (const p of due) {
    p.attempts++;
    try {
      const hash = await ctx.walletClient.sendTransaction({
        account,
        chain: ctx.chain,
        to: runtime.factory,
        data: encodeFunctionData({
          abi: vulnFactoryAbi,
          functionName: "createPool",
          args: [poolInitCode(p, config.vulnPoolFeeBps)],
        }),
        gas: GAS_CREATE_POOL,
        nonce: nonce++,
        maxFeePerGas: baseFee + opts.priorityFeeWei,
        maxPriorityFeePerGas: opts.priorityFeeWei,
      });
      p.deploy = { hash, blockIndex };
      p.phase = "deploying";
      hashes.push(hash);
    } catch (error) {
      // Not sent, so the nonce was not used: hand it to the next pool.
      nonce--;
      logger.event({
        type: "vuln_deploy_failed",
        poolIndex: p.meta.poolIndex,
        base: p.meta.base,
        blockIndex,
        attempt: p.attempts,
        error: error instanceof Error ? error.message : String(error),
      });
      if (p.attempts >= DEPLOY_ATTEMPTS) p.phase = "failed";
    }
  }
  return hashes;
}

async function settleDeploy(
  ctx: SimContext,
  runtime: VulnRuntime,
  p: VulnPoolRuntime,
  blockIndex: number,
  logger: RunLogger,
): Promise<void> {
  const deploy = p.deploy;
  if (!deploy) {
    p.phase = "pending";
    return;
  }
  let receipt: Awaited<
    ReturnType<typeof ctx.publicClient.getTransactionReceipt>
  > | null = null;
  try {
    receipt = await ctx.publicClient.getTransactionReceipt({
      hash: deploy.hash,
    });
  } catch {
    receipt = null;
  }
  const pool =
    receipt?.status === "success"
      ? extractPoolAddress(receipt.logs, runtime.factory)
      : undefined;
  if (
    receipt === null &&
    blockIndex - deploy.blockIndex < PENDING_TIMEOUT_BLOCKS
  )
    return;
  if (!pool) {
    logger.event({
      type: "vuln_deploy_failed",
      poolIndex: p.meta.poolIndex,
      base: p.meta.base,
      blockIndex,
      attempt: p.attempts,
      hash: deploy.hash,
      error:
        receipt === null ? "deploy not mined in time" : "createPool reverted",
    });
    p.deploy = undefined;
    p.phase = p.attempts >= DEPLOY_ATTEMPTS ? "failed" : "pending";
    return;
  }
  // per-instance codehash (runtime bytecode after immutables are baked in; ADR 0014 §5).
  const code = (await ctx.publicClient.getCode({ address: pool })) ?? "0x";
  const codehash = keccak256(code as Hex);
  // disclosure record (equivalent to a production explorer; the agent matches the codehash via eth_getCode).
  // The source is neutralized (comments stripped, contract name unified to LiquidityPool) = rigged/safe cannot
  // be told apart without reading the swap logic. The ground-truth (rigged) is held only on the events.jsonl side.
  // Written when the pool exists, not at setup: a disclosure is the pool's existence, and the directory is
  // readable by every agent from block 0.
  const disclosure = {
    address: pool,
    sourceCode: sanitizedSource(p.meta.rigged ? "RiggedAMM" : "SimpleAMM"),
    contractName: "LiquidityPool",
    compiler: "0.8.20",
    codehash,
  };
  writeFileSync(
    join(runtime.disclosuresDir, `${pool.toLowerCase()}.json`),
    `${JSON.stringify(disclosure, null, 2)}\n`,
  );
  p.pool = pool;
  p.codehash = codehash;
  p.deploy = undefined;
  p.phase = "deployed";
}

// Burn reserve into a deployed pool (cheatcode; no mine needed), making the bait-laden opportunity appear on
// this block. fair is per-base (fairByBase). Emits pool_created / vulnerability_disclosed.
async function fundPool(
  ctx: SimContext,
  p: VulnPoolRuntime,
  blockIndex: number,
  blockNumber: number,
  fairByBase: Record<string, number>,
  config: SimConfig,
  logger: RunLogger,
): Promise<void> {
  const { publicClient } = ctx;
  const pool = p.pool as Address;
  try {
    const fair = fairByBase[p.meta.base];
    if (!fair || fair <= 0) {
      // In practice fairPrices includes all bases so this is not hit, but avoid a silent disappearance and leave a diagnostic.
      logger.event({
        type: "vuln_fund_skipped",
        pool,
        base: p.meta.base,
        reason: "fair price missing or non-positive",
        blockIndex,
      });
      p.phase = "funded"; // fair is unchanged within the same block even on retry. Latch to avoid an infinite loop.
      return;
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
      p.phase = "funded";
      return;
    }
    const reserveBaseWei =
      (config.vulnPoolLiquidityUsdcUnits * baseUnit) / priceScaled;
    const reserveQuoteUnits = (reserveBaseWei * poolPriceScaled) / baseUnit;

    await dealErc20(publicClient, p.token0, pool, reserveBaseWei);
    await dealErc20(publicClient, p.token1, pool, reserveQuoteUnits);
    p.funded = true;
    p.phase = "funded";

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
  const funded = runtime.pools.filter(
    (p): p is VulnPoolRuntime & { pool: Address } =>
      p.funded && p.pool !== undefined,
  );
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
