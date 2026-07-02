// 脆弱性発生イベント（悪意あるプール）の環境側ライフサイクル（ADR 0014 §1,2,5,6）。
//
// coordinator から呼ばれる環境デーモン側の責務をここに閉じ込める（agent 側の発見/検証は
// examples/agents/lib/poolDiscovery.ts / verifyContract.ts に分離）:
//   1. deployVulnPools  : setup フェーズで factory + 全プール（正直/rigged 混在）を deploy し、
//                         disclosures/<addr>.json（source+codehash）を発行する。
//   2. fundVulnPoolsAt  : 各プールの window（startBlock）で cheatcode 資金供給（reserve に bait を
//                         焼き込む）し、pool_created / vulnerability_disclosed を events.jsonl へ emit。
//   3. watchVulnSwaps   : 毎ブロック各プールの Swap ログを走査し、rigged 被弾（vulnerability_exploited）
//                         / 安全プール約定（safe_pool_captured）を ground-truth で emit する。
//
// 設計判断:
//   - deploy は setup（interval mining 前・auto-mine/sendAndMine）で robust に行い、資金供給だけを
//     window の cheatcode で「湧かせる」。deploy 自体を interval mining 中に差し込むと mine と競合
//     するため（keeper/oracle と違い CREATE は receipt 確定が要る）。プールは資金供給前は reserve=0
//     で機会に見えないので、agent から見た「出現」は window の funding と一致する。
//   - codehash は immutable 値が焼かれた実行時 bytecode に依存するため artifact からは算出できない。
//     deploy 後に eth_getCode(address) → keccak256 で per-instance に確定させる（agent 側も同じ計算で
//     照合する。ADR 0014 §5）。
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
import { dealErc20, sendAndMine } from "../chain.js";
import { deployContract } from "../protocols/deploy.js";
import type { SimConfig } from "../config.js";
import type { RunLogger } from "../logger.js";
import { tokenInfo } from "../markets.js";
import type { SimContext } from "../protocols/types.js";
import type { ResolvedVulnPool, VulnSchedule } from "./vulnEvents.js";

const here = dirname(fileURLToPath(import.meta.url));

// factory の呼び出し / PoolCreated 復号に使う最小 ABI。
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

// AMM の Swap イベント（被弾検知に使う。SimpleAMM/RiggedAMM 共通）。
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
  token1: Address; // USDC（quote）
  rugThresholdUnits: bigint; // rigged の skim 閾値（tokenIn=USDC 建て。safe は 0）
  codehash: Hex;
  funded: boolean;
};

export type VulnRuntime = {
  factory: Address;
  factoryDeployBlock: bigint;
  disclosuresDir: string;
  pools: VulnPoolRuntime[];
};

// disclosure に載せる source は「本番 explorer が配る verified source」相当。設計意図を明かす
// コメント（"悪意あるプール"/"skim" 等）や契約名（RiggedAMM/SimpleAMM）をそのまま配ると、
// agent が swap ロジックを読まずにコメント grep / contractName で classification できてしまい、
// LLM ソース監査が load-bearing でなくなる（ADR 0014 §4 の趣旨に反する）。よってコメントを除去し
// 契約名を中立化してから配布する（codehash は実 bytecode から別途算出するので整合は保たれる）。
function sanitizedSource(name: string): string {
  const raw = readFileSync(
    resolve(here, `../../contracts/${name}.sol`),
    "utf8",
  );
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "") // ブロックコメント
    .replace(/\/\/[^\n]*/g, "") // 行コメント
    .replace(/\b(RiggedAMM|SimpleAMM)\b/g, "LiquidityPool") // 契約名を中立化
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// per-round USDC 上限 × frac で rigged の skim 閾値（tokenIn=USDC 建て）を算出。
function rugThresholdUnits(config: SimConfig, frac: number): bigint {
  const scaled = BigInt(Math.round(frac * 1_000_000));
  return (config.maxAgentUsdcInUnits * scaled) / 1_000_000n;
}

// setup: factory + 全プールを deploy し、disclosures を発行する（資金供給は window で行う）。
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

    // per-instance codehash（immutable 焼込後の実行時 bytecode。ADR 0014 §5）。
    const code = (await publicClient.getCode({ address: pool })) ?? "0x";
    const codehash = keccak256(code as Hex);

    // disclosure レコード（本番 explorer 相当。agent は eth_getCode で codehash 照合する）。
    // source は中立化済み（コメント除去・契約名を LiquidityPool に統一）＝rigged/safe は swap の
    // ロジックを読まないと分からない。ground-truth（rigged）は events.jsonl 側だけが持つ。
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
      // 非 PoolCreated ログは無視
    }
  }
  return undefined;
}

// window: 当該 blockIndex で「湧く」プールに reserve を焼き込み（cheatcode）、bait 込みの機会を
// 出現させる。fair は base ごと（fairByBase）。pool_created / vulnerability_disclosed を emit。
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
    // startBlock 以降の最初の処理ブロックで一度だけ供給する（funded ラッチ）。厳密一致でなく
    // 「>=」にするのは、coordinator の onBlock が processing 中に到来したブロックを取りこぼすと
    // 窓ブロックの blockIndex が飛ぶことがあるため（そのプールが永久に未供給になるのを防ぐ）。
    if (p.funded || p.meta.startBlock > blockIndex) continue;
    // プール単位で例外を隔離する（1 プールの dealErc20 失敗が同じ blockIndex の他プールの供給を
    // 巻き添えにしないため）。startBlock は event 内で共有され複数プールが同一ブロックに集中する。
    try {
      const fair = fairByBase[p.meta.base];
      if (!fair || fair <= 0) {
        // 実運用では fairPrices は全 base を含むため踏まないが、静かな消滅を避け診断を残す。
        logger.event({
          type: "vuln_fund_skipped",
          pool: p.pool,
          base: p.meta.base,
          reason: "fair price missing or non-positive",
          blockIndex,
        });
        p.funded = true; // 再試行しても fair は同一ブロック内で不変。永久ループを避けラッチする。
        continue;
      }
      const baseDec = tokenInfo(p.meta.base).decimals;
      const baseUnit = 10n ** BigInt(baseDec);
      // reserve: base 側は liquidity（USDC 建て）相当を積む。quote 側は base を fair より baitBps
      // 割安に見せる比率（poolPrice = fair·(1−bait)）で積む → agent は「割安な base」を買える。
      const priceScaled = BigInt(Math.round(fair * 1_000_000));
      // baitBps は parse で <=9000 に制限済みだが、二重防御で baitFactor>0 を確認する。
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
      // ground-truth（採点用）: rigged / rug パラメータを含む。
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
      // 開示（agent は disclosures/<addr>.json を on-demand lookup。ここは appearance の記録）。
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

// 毎ブロック: 資金供給済みプールの Swap ログを [fromBlock,toBlock] で走査し、被弾/約定を
// ground-truth で emit する（ADR 0014 §6。LLM verdict でなく実挙動で判定）。
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
      // skim 条件は RiggedAMM.swap と厳密一致させる: 方向に依らず amountIn>rugThreshold で発火。
      // （buyBase ゲートを付けると base 売り方向で実際に skim された取引を skimmed:false と誤報告する。
      // 閾値は USDC 建てなので base 売り〔wei スケール〕は事実上常に閾値超で skim される点も反映される）。
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
