// observation の再構成（ADR 0006 / ADR 0015）。
// direct モードでは agent ランタイム（example/agents/runtime/read.ts）が毎ブロック自分で
// チェーンから AgentObservation を組み立てる。環境(core)の採点・診断も同じ形を使うため、
// 「チェーン状態 + config → AgentObservation」の変換は契約として sdk に置く。
import type { Address } from "viem";
import type { SimConfig } from "./config.js";
import { balanceToInventory } from "./pnl.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  ProtocolId,
  ProtocolObservations,
} from "./types.js";
import { tokenInfo } from "./markets.js";
import type { ProtocolAdapter, SimContext } from "./protocols/types.js";

export async function observationFor(
  ctx: SimContext,
  adapters: ProtocolAdapter[],
  stateById: Map<ProtocolId, unknown>,
  runId: string,
  round: number,
  blockNumber: bigint,
  agentAddress: Address,
  fairPrice: number,
  balances: BalanceSnapshot,
  history: AgentObservation["history"],
  config: SimConfig,
  enabledIds: ProtocolId[],
): Promise<AgentObservation> {
  // protocol ごとの観測は独立した読取なので並列に発行する。agent クライアント（batch=true）では
  // 同一 tick の読取が Multicall3 1 本に自動集約されるため、並列発行がそのまま往復回数の削減になる。
  const protocols: ProtocolObservations = {};
  await Promise.all(
    adapters.map(async (adapter) => {
      const obs = await adapter.observe(
        ctx,
        stateById.get(adapter.id),
        agentAddress,
        fairPrice,
      );
      (protocols as Record<string, unknown>)[adapter.id] = obs;
    }),
  );
  return {
    kind: "observation",
    runId,
    round,
    blockNumber: blockNumber.toString(),
    agentAddress,
    fairPriceUsdcPerWeth: fairPrice,
    oraclePrices: { wethUsd: fairPrice, usdcUsd: 1 },
    // ADR 0013: 全 base の USD 価格・残高。WETH のみのとき fairPricesUsd={WETH:fairPrice} で
    // 既存フィールドと一致（後方互換）。WBTC を見る戦略だけ参照する。
    fairPricesUsd: ctx.fairPrices ?? { WETH: fairPrice },
    ...(balances.bases
      ? {
          baseBalances: Object.fromEntries(
            Object.entries(balances.bases).map(([k, v]) => [k, v.toString()]),
          ),
        }
      : {}),
    // ADR 0013: 各 base の decimals。プロセス分離 agent の base 量換算用（WETH のみなら {WETH:18}）。
    baseDecimals: Object.fromEntries(
      Object.keys(ctx.fairPrices ?? { WETH: fairPrice }).map((b) => [
        b,
        tokenInfo(b).decimals,
      ]),
    ),
    enabledProtocols: enabledIds,
    balances: {
      ethWei: balances.ethWei.toString(),
      wethWei: balances.wethWei.toString(),
      usdcUnits: balances.usdcUnits.toString(),
    },
    inventory: balanceToInventory(balances, fairPrice),
    history: history.slice(-20),
    limits: {
      maxWethInWei: config.maxAgentWethInWei.toString(),
      maxUsdcInUnits: config.maxAgentUsdcInUnits.toString(),
      defaultPriorityFeePerGasWei: config.defaultPriorityFeeWei.toString(),
      // 経済化（ADR 0011 §2）: priority-fee 上限執行を退役するので、agent へ提示する上限も
      // 実質撤廃する（入札は機会価値で自己制限する = realistic priority gas auction）。validateAction の
      // 提出前チェックもこの値を見るため、ここを上げないと高入札が黙って弾かれる。10^18 wei/gas は
      // 事実上無制限の guard（壊れた巨大入札だけ弾く。実 spend は EIP-1559 残高制約で endowment に縛られる）。
      maxPriorityFeePerGasWei: (config.economicGas
        ? 1_000_000_000_000_000_000n
        : config.maxPriorityFeeWei
      ).toString(),
      defaultSlippageBps: 50,
      maxBundleActions: config.maxBundleActions,
      maxLpWethWei: config.maxLpWethWei.toString(),
      maxLpUsdcUnits: config.maxLpUsdcUnits.toString(),
      maxOpenPositions: config.maxOpenPositions,
      maxGmxSizeUsd: config.maxGmxSizeUsd.toString(),
      maxAaveSupplyWethWei: config.maxAaveSupplyWethWei.toString(),
      maxAaveBorrowUsdcUnits: config.maxAaveBorrowUsdcUnits.toString(),
      // ADR 0013: per-base 上限を露出。WETH は既存値、追加 base は config の per-base マップ（既定 0）。
      baseLimits: buildBaseLimits(config),
    },
    protocols,
  };
}

// ADR 0013: base シンボル -> per-round 上限のマップを config から組む。WETH は既存の WETH 専用
// 上限を流用し（byte 互換）、追加 base は MAX_AGENT/MAX_LP/MAX_AAVE_SUPPLY の per-base 値（既定 0）。
function buildBaseLimits(
  config: SimConfig,
): NonNullable<AgentObservation["limits"]["baseLimits"]> {
  const out: NonNullable<AgentObservation["limits"]["baseLimits"]> = {};
  const bases = new Set<string>([
    "WETH",
    ...Object.keys(config.maxAgentBaseIn),
    ...Object.keys(config.maxLpBase),
    ...Object.keys(config.maxAaveSupplyBase),
  ]);
  for (const base of bases) {
    const maxSwap =
      base === "WETH"
        ? config.maxAgentWethInWei
        : (config.maxAgentBaseIn[base] ?? 0n);
    const maxLp =
      base === "WETH" ? config.maxLpWethWei : (config.maxLpBase[base] ?? 0n);
    const maxAave =
      base === "WETH"
        ? config.maxAaveSupplyWethWei
        : (config.maxAaveSupplyBase[base] ?? 0n);
    out[base] = {
      maxSwapInBaseWei: maxSwap.toString(),
      maxLpBaseWei: maxLp.toString(),
      maxAaveSupplyBaseWei: maxAave.toString(),
    };
  }
  return out;
}
