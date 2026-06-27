/**
 * clean-arb: 規律的な 2-leg cross-venue 裁定のみを行う agent（全 active base × 全 AMM venue）。
 *
 * multi-arb との違い: multi-arb の step1（cost-aware な 2-leg delta-neutral 裁定）だけを残し、
 * **single-leg フォールバックを撤廃**した。single-leg は「fair から乖離した venue を fair へ寄せる」
 * 1 swap をコスト無視・方向リスクありで出すため、WBTC 注入が作る大きな乖離を追って手数料/方向で
 * 系統的に損する（multi-arb が WBTC で大赤字の主因）。
 *
 * clean-arb は「spread > 両 venue 手数料 + 安全マージン」のときだけ 2-leg を出し、無ければ noop。
 * 方向 β を持たず venue 間スプレッド(α)だけを、コストを上回るときだけ抜く＝規律的な裁定者。
 */
import { createInterface } from "node:readline";
import { marketViews, type MarketView } from "./lib/markets.js";

const SAFETY_MARGIN_BPS = 60; // 2-leg ラウンドトリップの採算マージン（手数料+price impact 見込み）
const MIN_SIZE_BPS = 250;
const MAX_SIZE_BPS = 2500;
const SPREAD_GAIN = 200_000; // net edge → サイズの線形ゲイン
const LEG_SLIPPAGE_BPS = 120;

function minBI(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
function baseToFloat(amountBaseWei: bigint, decimals: number): number {
  return Number(amountBaseWei) / 10 ** decimals;
}
function floatToBase(amount: number, decimals: number): bigint {
  return BigInt(Math.max(0, Math.floor(amount * 10 ** decimals)));
}

type TwoLeg = {
  base: string;
  spread: number;
  cheap: MarketView["venues"][number];
  rich: MarketView["venues"][number];
  usdcIn: bigint;
  baseSell: bigint;
};

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const obs = JSON.parse(line);
  const views = marketViews(obs);
  const usdcBal = BigInt(obs.balances.usdcUnits || "0");
  const maxUsdc = BigInt(obs.limits.maxUsdcInUnits);
  const fee = obs.limits.defaultPriorityFeePerGasWei;

  // 全 base × venue を走査し、最も大きい採算 2-leg を選ぶ。
  let bestTwo: TwoLeg | null = null;
  for (const view of views) {
    if (view.venues.length < 2) continue;
    let cheap = view.venues[0];
    let rich = view.venues[0];
    for (const v of view.venues) {
      if (v.price < cheap.price) cheap = v;
      if (v.price > rich.price) rich = v;
    }
    if (cheap.price <= 0 || rich.price <= 0) continue;
    const spread = rich.price / cheap.price - 1;
    const roundtripCost =
      (cheap.feeBps + rich.feeBps + SAFETY_MARGIN_BPS) / 10000;
    if (spread <= roundtripCost) continue; // コスト超のときだけ
    const usdcCap = minBI(usdcBal, maxUsdc);
    if (usdcCap <= 0n) continue;
    const netEdge = spread - roundtripCost;
    const sizeBps = Math.min(
      MAX_SIZE_BPS,
      Math.max(MIN_SIZE_BPS, Math.floor(netEdge * SPREAD_GAIN)),
    );
    const usdcIn = (usdcCap * BigInt(sizeBps)) / 10000n;
    if (usdcIn <= 0n) continue;
    const boughtBase = baseToFloat(usdcIn, 6) / cheap.price;
    let baseSell = floatToBase(boughtBase * 0.98, view.baseDecimals);
    const maxBaseIn = BigInt(view.maxSwapInBaseWei || "0");
    if (maxBaseIn > 0n) baseSell = minBI(baseSell, maxBaseIn);
    if (baseSell <= 0n) continue;
    if (!bestTwo || spread > bestTwo.spread)
      bestTwo = { base: view.base, spread, cheap, rich, usdcIn, baseSell };
  }

  if (!bestTwo) {
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: "no profitable 2-leg spread" })}\n`,
    );
    return;
  }

  const withBase = (a: Record<string, unknown>): Record<string, unknown> =>
    bestTwo!.base === "WETH" ? a : { ...a, base: bestTwo!.base };
  const bundle = {
    type: "bundle",
    actions: [
      withBase({
        type: bestTwo.cheap.swapType,
        tokenIn: "USDC",
        amountIn: bestTwo.usdcIn.toString(),
        slippageBps: LEG_SLIPPAGE_BPS,
      }),
      withBase({
        type: bestTwo.rich.swapType,
        tokenIn: bestTwo.base,
        amountIn: bestTwo.baseSell.toString(),
        slippageBps: LEG_SLIPPAGE_BPS,
      }),
    ],
    maxPriorityFeePerGasWei: fee,
  };
  process.stdout.write(`${JSON.stringify(bundle)}\n`);
});
