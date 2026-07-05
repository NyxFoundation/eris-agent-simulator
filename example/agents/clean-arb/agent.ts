/**
 * clean-arb: an agent that only does disciplined 2-leg cross-venue arbitrage (all active bases x all AMM venues).
 *
 * Difference from multi-arb: keeps only multi-arb's step 1 (cost-aware 2-leg delta-neutral arbitrage) and
 * **removes the single-leg fallback**. The single-leg path issues 1 swap to "pull a venue that deviated from
 * fair back toward fair", ignoring cost and carrying directional risk, so it chases the large deviations that
 * WBTC injection creates and loses systematically on fees/direction (the main reason multi-arb ran a big loss on WBTC).
 *
 * clean-arb only issues a 2-leg trade when "spread > both venue fees + safety margin", otherwise noop.
 * It carries no directional beta and extracts only the cross-venue spread (alpha), and only when it beats cost = a disciplined arbitrageur.
 */
import type { AgentAction, AgentObservation } from "@eris/sdk";
import { marketViews, type MarketView } from "../lib/markets.js";

// Profitability margin for the 2-leg round trip (fees + price impact + expected adverse move).
// Overridable via env ERIS_ARB_SAFETY_BPS (raise it in persistent-drift envs to avoid adverse selection, for testing).
const SAFETY_MARGIN_BPS = Number(process.env.ERIS_ARB_SAFETY_BPS ?? "60");
const MIN_SIZE_BPS = 250;
const MAX_SIZE_BPS = 2500;
const SPREAD_GAIN = 200_000; // linear gain from net edge -> size
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

export function decide(
  obs: AgentObservation,
): AgentAction | Record<string, unknown> | null {
  const views = marketViews(obs);
  const usdcBal = BigInt(obs.balances.usdcUnits || "0");
  const maxUsdc = BigInt(obs.limits.maxUsdcInUnits);
  const fee = obs.limits.defaultPriorityFeePerGasWei;

  // Scan all bases x venues and pick the largest profitable 2-leg.
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
    if (spread <= roundtripCost) continue; // only when it beats cost
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
    return { type: "noop", reason: "no profitable 2-leg spread" };
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
  return bundle;
}
