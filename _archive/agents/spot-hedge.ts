// spot-hedge: 初期在庫の WETH を現物で USDC に売り切って β（ETH 方向エクスポージャ）を畳む
// ヘッジ実証 agent（ADR 0008 ダッシュボードのデモ用）。
//
// 目的は「β を消すと fair が動いても PnL が平らになる」ことの可視化:
//   value = usdc + (eth+weth)*fair
//   WETH を USDC に変えていくと (eth+weth) が減り、value が fair に対して中立になる。
//   → flatten 後は fair が上下しても PnL がほぼ動かない（noop は β で揺れ続ける）。
//
// GMX 経由のヘッジ（perp short）は realtime で keeper が約定しないため使わず、robust な
// uniswap swap だけで β を落とす。毎ブロック maxWethInWei まで WETH→USDC を売り、
// 在庫がしきい値以下になったら noop で維持する。
//
// 前提: 在庫を liquid WETH 中心にする（INITIAL_WETH_WEI を大きく、INITIAL_ETH_WEI は gas 分のみ）。
//       native ETH は wrap アクションが無く現物で売れないため。
//
// env:
//   HEDGE_KEEP_WETH_WEI  売り残す WETH（既定 0 = フルフラット）
//   HEDGE_SLIPPAGE_BPS   売り注文の許容スリッページ（既定 500）
import { createInterface } from "node:readline";
import { createEmitter } from "./lib/agentLog.js";

const KEEP_WETH_WEI = BigInt(process.env.HEDGE_KEEP_WETH_WEI ?? "0");
const SLIPPAGE_BPS = Number(process.env.HEDGE_SLIPPAGE_BPS ?? "500");

const emit = createEmitter();
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const obs = JSON.parse(line);
  const round: number = obs.round;
  const fee = obs.limits.defaultPriorityFeePerGasWei;
  const wethWei = BigInt(obs.balances.wethWei);
  const maxIn = BigInt(obs.limits.maxWethInWei);
  const signals: Record<string, number> = {
    wethEth: Number(wethWei) / 1e18,
    fair: obs.fairPriceUsdcPerWeth,
  };

  // フラット済み → 維持（fair が動いても value はほぼ不変 = ヘッジ完了）
  if (wethWei <= KEEP_WETH_WEI) {
    emit(
      { type: "noop", reason: "flat: β hedged to cash" },
      { round, signals, state: { phase: "flat" } },
    );
    return;
  }

  let sell = wethWei - KEEP_WETH_WEI;
  if (sell > maxIn) sell = maxIn;
  emit(
    {
      type: "swap",
      tokenIn: "WETH",
      amountIn: sell.toString(),
      maxPriorityFeePerGasWei: fee,
      slippageBps: SLIPPAGE_BPS,
      reason: "selling WETH→USDC to flatten β",
    },
    { round, signals, state: { phase: "selling" } },
  );
});
