// inv-hedge: 初期在庫（spot の ETH/WETH ロング）を GMX short で相殺して delta-neutral を作る
// ヘッジ実証 agent（ADR 0008 ダッシュボードのデモ用）。
//
// 目的は「fair price が上下しても PnL がほぼ平らになる」ことの可視化:
//   value = usdc + (eth+weth)*fair + gmxValue
//   spot ロングの β（+110ETH 相当）に対し、ほぼ同 notional の GMX short（fair 下落で利益）を
//   建てると β が相殺され、value が fair に対して中立になる。
//
// 状態機械（GMX は keeper 実行が次ブロックなので、提出後は数ブロック待つ）:
//   A: ポジション無し → 在庫 ETH 相当の notional で gmxIncrease short を 1 回提出
//   B: 提出直後       → keeper 執行待ち（noop）
//   C: ポジション確立 → noop で維持
//
// env:
//   HEDGE_FRACTION         ヘッジ比率（既定 1.0 = フルヘッジ）
//   HEDGE_COLLATERAL_USDC  short の担保 USDC（既定 20000。残高内で clamp）
import { createInterface } from "node:readline";
import { createEmitter } from "./lib/agentLog.js";

const HEDGE_FRACTION = Number(process.env.HEDGE_FRACTION ?? "1.0");
const COLLATERAL_USDC_UNITS =
  BigInt(process.env.HEDGE_COLLATERAL_USDC ?? "20000") * 1_000_000n;
const SIZE_1E30 = 10n ** 30n;
const RETRY_AFTER_ROUNDS = 4; // 提出後これだけ待っても建たなければ再提出

const emit = createEmitter();
const rl = createInterface({ input: process.stdin });

let pendingSince: number | null = null;

function clamp(v: bigint, max: bigint): bigint {
  return v > max ? max : v;
}

rl.on("line", (line) => {
  const obs = JSON.parse(line);
  const round: number = obs.round;
  const gmx = obs.protocols?.gmx;
  const fee = obs.limits.defaultPriorityFeePerGasWei;
  const signals: Record<string, number> = {};
  const state: Record<string, unknown> = {};

  if (!gmx) {
    emit({ type: "noop", reason: "gmx disabled (cannot hedge)" }, { round });
    return;
  }

  // C: ショート確立済み → 維持
  if (gmx.position) {
    pendingSince = null;
    state.phase = "C:delta-neutral";
    signals.hedgeSizeUsd = Number(gmx.position.sizeUsd ?? 0);
    emit(
      { type: "noop", reason: "delta-neutral established" },
      { round, signals, state },
    );
    return;
  }

  // B: 提出直後は keeper 執行を待つ
  if (pendingSince !== null && round - pendingSince < RETRY_AFTER_ROUNDS) {
    state.phase = "B:awaiting-keeper";
    emit(
      { type: "noop", reason: "short submitted, awaiting keeper" },
      { round, state },
    );
    return;
  }

  // A: 在庫 ETH 相当の notional で short を建てる
  const ethExposure =
    (Number(obs.balances.ethWei) + Number(obs.balances.wethWei)) / 1e18;
  const marketPrice = gmx.marketPriceUsd ?? obs.fairPriceUsdcPerWeth;
  const notionalUsd = ethExposure * marketPrice * HEDGE_FRACTION;
  if (!(notionalUsd > 0) || !(marketPrice > 0)) {
    emit({ type: "noop", reason: "no exposure to hedge" }, { round });
    return;
  }
  const sizeUsd = clamp(
    BigInt(Math.round(notionalUsd)) * SIZE_1E30,
    BigInt(obs.limits.maxGmxSizeUsd),
  );
  const collateral = clamp(
    COLLATERAL_USDC_UNITS,
    BigInt(obs.balances.usdcUnits),
  );

  pendingSince = round;
  signals.ethExposure = ethExposure;
  signals.notionalUsd = notionalUsd;
  signals.marketPrice = marketPrice;
  state.phase = "A:open-short";
  emit(
    {
      type: "gmxIncrease",
      isLong: false,
      collateral: "USDC",
      collateralAmount: collateral.toString(),
      sizeDeltaUsd: sizeUsd.toString(),
      maxPriorityFeePerGasWei: fee,
      reason: `hedge ${(HEDGE_FRACTION * 100).toFixed(0)}% of ${ethExposure.toFixed(1)} ETH`,
    },
    { round, signals, state },
  );
});
