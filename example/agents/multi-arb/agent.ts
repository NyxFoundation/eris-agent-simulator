/**
 * multi-arb: a base-agnostic cross-venue arbitrage agent (ADR 0013).
 *
 * Scans across all active bases (WETH / WBTC / ...) x all AMM venues (uniswap / balancer / curve), and each round:
 *   1) Prefers 2-leg delta-neutral arbitrage — when the cross-venue spread for some base (price gap between the
 *      cheapest and most expensive venue) exceeds the threshold, it issues USDC->base buy on the cheapest venue +
 *      base->USDC sell on the most expensive venue as one bundle. The sell leg uses the base output of the buy leg
 *      (action.ts credits the base inside the bundle). Carries no directional beta and extracts only the cross-venue spread (alpha).
 *   2) Falls back to single-leg when there is no 2-leg opportunity — 1 swap that pulls the price of the (base, venue)
 *      most deviated from fair back toward fair (even on USDC-only startup it can build a base on the buy side).
 *
 * Rather than writing a separate agent per asset, it scans the observation's market view uniformly and auto-adapts
 * to any asset set (multi-asset design). It attaches base to the action only when base!=="WETH" (WETH has no base
 * = byte-compatible with the legacy output).
 */
import type { AgentAction, AgentObservation } from "@eris/sdk";
import { marketViews, type MarketView } from "../lib/markets.js";

// Profitability margin (bps). 2-leg trades only when spread exceeds "both venue fees + this", and single-leg
// only when the fair gap exceeds "that venue's fee + this". Without it (gap < cost) it loses to fees and
// bleeds systematically (measured -1490 USDC on 2-leg and -1650 USDC on single-leg in a 60-block calm regime
// -> ignoring cost is a design bug). Also serves as a safety margin for expected slippage/price-impact.
const SAFETY_MARGIN_BPS = 50;
const MIN_SIZE_BPS = 250;
const MAX_SIZE_BPS = 2500;
const SPREAD_GAIN = 200_000; // linear gain from spread -> size
const GAP_GAIN = 200_000;
const LEG_SLIPPAGE_BPS = 120; // slightly loose for 2-leg to account for cross-venue movement
const SINGLE_SLIPPAGE_BPS = 75;

function minBI(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

// Convert a base amount (base units) to a number by dividing by decimals (for USD conversion; an estimate is enough).
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

type SingleLeg = {
  base: string;
  venue: MarketView["venues"][number];
  gapAbs: number;
  tokenIn: string;
  amountIn: bigint;
};

export function decide(
  obs: AgentObservation,
): AgentAction | Record<string, unknown> | null {
  const views = marketViews(obs);
  const usdcBal = BigInt(obs.balances.usdcUnits || "0");
  const maxUsdc = BigInt(obs.limits.maxUsdcInUnits);
  const maxWeth = BigInt(obs.limits.maxWethInWei);
  const fee = obs.limits.defaultPriorityFeePerGasWei;

  // ---- 1) 2-leg cross-venue arbitrage (pick the base with the largest cross-venue spread) ----
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
    // Round-trip profitability: only when spread exceeds buy-venue fee + sell-venue fee + safety margin.
    const roundtripCost =
      (cheap.feeBps + rich.feeBps + SAFETY_MARGIN_BPS) / 10000;
    if (spread <= roundtripCost) continue;
    // USDC size of the buy leg (proportional to net edge = spread - cost; bet small on marginal spreads).
    const usdcCap = minBI(usdcBal, maxUsdc);
    if (usdcCap <= 0n) continue;
    const netEdge = spread - roundtripCost;
    const sizeBps = Math.min(
      MAX_SIZE_BPS,
      Math.max(MIN_SIZE_BPS, Math.floor(netEdge * SPREAD_GAIN)),
    );
    const usdcIn = (usdcCap * BigInt(sizeBps)) / 10000n;
    if (usdcIn <= 0n) continue;
    // Approx. buy-output base = (USDCin / cheapPrice). The sell leg is 98% of that (floor/slippage margin).
    const boughtBase = baseToFloat(usdcIn, 6) / cheap.price;
    let baseSell = floatToBase(boughtBase * 0.98, view.baseDecimals);
    // Cap by the per-base limit ("0" = no limit).
    const maxBaseIn = BigInt(view.maxSwapInBaseWei || "0");
    if (maxBaseIn > 0n) baseSell = minBI(baseSell, maxBaseIn);
    if (baseSell <= 0n) continue;
    if (!bestTwo || spread > bestTwo.spread)
      bestTwo = { base: view.base, spread, cheap, rich, usdcIn, baseSell };
  }

  if (bestTwo) {
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

  // ---- 2) single-leg fallback (pull the (base, venue) most deviated from fair back toward fair) ----
  let bestOne: SingleLeg | null = null;
  for (const view of views) {
    for (const venue of view.venues) {
      const gap = view.fair / venue.price - 1;
      const gapAbs = Math.abs(gap);
      // Profitability line: a single swap toward fair pays that venue's fee, so only fire when gap exceeds
      // "fee + safety margin" (same idea as 2-leg). Fee-aware informed flow keeps deviations within the fee
      // band, so if the threshold is below the fee it keeps firing on in-band deviations every block and losing to fees.
      const singleLegCost = (venue.feeBps + SAFETY_MARGIN_BPS) / 10000;
      if (gapAbs <= singleLegCost) continue;
      const buyBase = gap > 0;
      const tokenIn = buyBase ? "USDC" : view.base;
      let cap: bigint;
      if (buyBase) {
        cap = minBI(usdcBal, maxUsdc);
      } else {
        const baseBal = BigInt(view.baseBalanceWei || "0");
        const maxBaseIn = BigInt(view.maxSwapInBaseWei || "0");
        cap = view.base === "WETH" ? minBI(baseBal, maxWeth) : baseBal;
        if (maxBaseIn > 0n) cap = minBI(cap, maxBaseIn);
      }
      if (cap <= 0n) continue;
      const sizeBps = Math.min(
        MAX_SIZE_BPS,
        Math.max(MIN_SIZE_BPS, Math.floor(gapAbs * GAP_GAIN)),
      );
      const amountIn = (cap * BigInt(sizeBps)) / 10000n;
      if (amountIn <= 0n) continue;
      if (!bestOne || gapAbs > bestOne.gapAbs)
        bestOne = { base: view.base, venue, gapAbs, tokenIn, amountIn };
    }
  }

  if (!bestOne) {
    return { type: "noop", reason: "no funded venue gap" };
  }
  const action: Record<string, unknown> = {
    type: bestOne.venue.swapType,
    tokenIn: bestOne.tokenIn,
    amountIn: bestOne.amountIn.toString(),
    maxPriorityFeePerGasWei: fee,
    slippageBps: SINGLE_SLIPPAGE_BPS,
  };
  if (bestOne.base !== "WETH") action.base = bestOne.base;
  return action;
}
