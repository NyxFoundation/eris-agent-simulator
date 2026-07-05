/**
 * Observation normalization helper for multi-asset agents (ADR 0013).
 *
 * WETH stays at the top level as before (protocols.uniswap.pool / protocols.balancer /
 * protocols.curve), while extra bases (WBTC etc.) live under protocols.*.markets["<base>/USDC"].
 * This absorbs that difference and returns every active base normalized to the same shape
 * (base / fair / venue prices / base inventory). Agent logic can then scan all markets uniformly
 * without caring about the base (the foundation for moving from per-asset support to a multi-asset design).
 *
 * The set of bases is derived from the keys of observation.fairPricesUsd (the coordinator/directShim
 * carries the fair price of every active base). Bases with no venue price at all are excluded.
 */
import type { AgentObservation } from "@eris/sdk/types.js";

export type AgentProtocol = "uniswap" | "balancer" | "curve";

export type AgentVenue = {
  protocol: AgentProtocol;
  swapType: "swap" | "balancerSwap" | "curveSwap";
  // quote(USDC) per base. Normalized to a cross-venue-comparable mid (for balancer/curve the
  // fee-inclusive quote has the fee added back; see the comment inside marketViews).
  price: number;
  // Trading fee (bps). Used for the round-trip profitability check of cross-venue arb. uniswap reads
  // the pool fee (3000 pips = 30bps). balancer/curve have no fee in the observation, so default 30bps.
  feeBps: number;
};

export type MarketView = {
  base: string; // "WETH" | "WBTC" | ...
  fair: number; // fair USD price of this base
  venues: AgentVenue[];
  // base inventory (base units, decimal string). WETH is balances.wethWei; others are baseBalances[base].
  baseBalanceWei: string;
  // base decimals (WETH=18 / WBTC=8). Used to convert between base amount and USD/quote.
  baseDecimals: number;
  // per-round cap on base-input swap (base units, decimal string). "0" = no cap (balance bound).
  maxSwapInBaseWei: string;
};

const QUOTE = "USDC";

const SWAP_TYPE: Record<AgentProtocol, AgentVenue["swapType"]> = {
  uniswap: "swap",
  balancer: "balancerSwap",
  curve: "curveSwap",
};

function venuePrice(
  obs: AgentObservation,
  base: string,
  protocol: AgentProtocol,
): number | undefined {
  const p = obs.protocols ?? {};
  if (protocol === "uniswap") {
    if (base === "WETH") return p.uniswap?.pool?.priceUsdcPerWeth;
    return p.uniswap?.markets?.[`${base}/${QUOTE}`]?.priceUsdcPerWeth;
  }
  const amm = protocol === "balancer" ? p.balancer : p.curve;
  if (base === "WETH") return amm?.priceUsdcPerWeth;
  return amm?.markets?.[`${base}/${QUOTE}`]?.priceUsdcPerWeth;
}

// Venue trading fee (bps). uniswap: pool fee (pips, 3000=0.3%) -> /100 gives bps.
// balancer/curve have no fee in the observation, so default 30bps (conservative).
function venueFeeBps(
  obs: AgentObservation,
  base: string,
  protocol: AgentProtocol,
): number {
  if (protocol !== "uniswap") return 30;
  const pool =
    base === "WETH"
      ? obs.protocols?.uniswap?.pool
      : obs.protocols?.uniswap?.markets?.[`${base}/${QUOTE}`];
  const fee = pool?.fee;
  return typeof fee === "number" && fee > 0 ? fee / 100 : 30;
}

// Normalize the observation into a base-agnostic array of market views. WETH is pinned first (deterministic order).
export function marketViews(obs: AgentObservation): MarketView[] {
  const fairByBase = obs.fairPricesUsd ?? { WETH: obs.fairPriceUsdcPerWeth };
  const bases = Object.keys(fairByBase).sort((a, b) =>
    a === "WETH" ? -1 : b === "WETH" ? 1 : a < b ? -1 : 1,
  );
  const views: MarketView[] = [];
  for (const base of bases) {
    const fair = fairByBase[base];
    if (!(fair > 0)) continue;
    const venues: AgentVenue[] = [];
    for (const protocol of ["uniswap", "balancer", "curve"] as const) {
      const price = venuePrice(obs, base, protocol);
      if (typeof price === "number" && price > 0) {
        const feeBps = venueFeeBps(obs, base, protocol);
        // Unify the observed-price convention to mid. uniswap is the slot0 mid, but balancer/curve's
        // observed price is a "fee-inclusive sell quote" (the executable price from probing the
        // quoter/query), so it systematically looks cheaper by the fee (measured at full-pool
        // equilibrium: uniswap 3000.00 / balancer 2990.97 / curve 2992.20). Leaving this step in place
        // causes (1) the cheap/rich decision to always skew toward the balancer/curve side, and (2) the
        // fee to be double-counted in the profitability math (the fee is already baked into quoted, yet
        // the fee is also added at the threshold) — a source of systematic loss where you chase an
        // apparent spread and lose to fees. Add the fee back to normalize to a mid before comparing.
        const mid =
          protocol === "uniswap" ? price : price / (1 - feeBps / 10000);
        venues.push({
          protocol,
          swapType: SWAP_TYPE[protocol],
          price: mid,
          feeBps,
        });
      }
    }
    if (venues.length === 0) continue;
    const baseBalanceWei =
      base === "WETH"
        ? obs.balances.wethWei
        : (obs.baseBalances?.[base] ?? "0");
    const baseDecimals = obs.baseDecimals?.[base] ?? 18;
    const maxSwapInBaseWei =
      base === "WETH"
        ? obs.limits.maxWethInWei
        : (obs.limits.baseLimits?.[base]?.maxSwapInBaseWei ?? "0");
    views.push({
      base,
      fair,
      venues,
      baseBalanceWei,
      baseDecimals,
      maxSwapInBaseWei,
    });
  }
  return views;
}
