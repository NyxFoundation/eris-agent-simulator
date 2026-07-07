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
  // quote(USDC) per base. Normalized to a cross-venue-comparable mid. balancer/curve carry a
  // two-sided executable quote in the observation, whose mid is used directly; when the two-sided
  // fields are absent (old observations) the fee-inclusive sell quote has 30bps added back (legacy).
  price: number;
  // Effective per-side cost vs mid (bps). Used for the round-trip profitability check of cross-venue
  // arb (cost of a 2-leg trade = cheap.feeBps + rich.feeBps). uniswap reads the pool fee (3000 pips =
  // 30bps). balancer/curve use the measured effectiveHalfSpreadBps (fee + impact at probe size; e.g.
  // twocrypto's dynamic fee under imbalance), falling back to 30bps when absent. A flat 30bps here
  // under-priced curve's real cost and made phantom spreads look profitable (WBTC all-agent bleed).
  feeBps: number;
  // Executable one-sided prices (fee/impact included; two-sided venues only). sellPrice = what you
  // get selling base; buyPrice = what you pay buying base. For precise edge math prefer
  // sell/buy over mid±feeBps.
  sellPrice?: number;
  buyPrice?: number;
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

type VenueQuoteObs = {
  price: number;
  sellPrice?: number;
  buyPrice?: number;
  effectiveHalfSpreadBps?: number;
};

function venueQuote(
  obs: AgentObservation,
  base: string,
  protocol: AgentProtocol,
): VenueQuoteObs | undefined {
  const p = obs.protocols ?? {};
  if (protocol === "uniswap") {
    const pool =
      base === "WETH"
        ? p.uniswap?.pool
        : p.uniswap?.markets?.[`${base}/${QUOTE}`];
    return pool ? { price: pool.priceUsdcPerWeth } : undefined;
  }
  const amm = protocol === "balancer" ? p.balancer : p.curve;
  const slice = base === "WETH" ? amm : amm?.markets?.[`${base}/${QUOTE}`];
  if (!slice) return undefined;
  return {
    price: slice.priceUsdcPerWeth,
    sellPrice: slice.sellPriceUsdcPerWeth,
    buyPrice: slice.buyPriceUsdcPerWeth,
    effectiveHalfSpreadBps: slice.effectiveHalfSpreadBps,
  };
}

// Venue trading fee (bps). uniswap: pool fee (pips, 3000=0.3%) -> /100 gives bps.
// balancer/curve: legacy fallback of 30bps, used only when the observation carries no
// two-sided quote (the measured effectiveHalfSpreadBps takes precedence in marketViews).
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
      const q = venueQuote(obs, base, protocol);
      if (!q || !(q.price > 0)) continue;
      // Unify the observed-price convention to mid. uniswap is the slot0 mid. balancer/curve now
      // carry a two-sided executable quote: price is already the executable mid and
      // effectiveHalfSpreadBps is the measured per-side cost (fee + impact; e.g. twocrypto's
      // dynamic fee under imbalance), so use both directly. Old observations without the
      // two-sided fields report a "fee-inclusive sell quote" that systematically looks cheaper by
      // the fee (measured at full-pool equilibrium: uniswap 3000.00 / balancer 2990.97 / curve
      // 2992.20); for those, add a flat 30bps back to approximate a mid (legacy fallback). The
      // flat correction under-prices the real cost under imbalance — the phantom-spread source —
      // which is why the measured half-spread takes precedence whenever present.
      const twoSided =
        protocol !== "uniswap" &&
        typeof q.effectiveHalfSpreadBps === "number" &&
        q.effectiveHalfSpreadBps >= 0 &&
        typeof q.sellPrice === "number" &&
        typeof q.buyPrice === "number";
      const feeBps = twoSided
        ? q.effectiveHalfSpreadBps!
        : venueFeeBps(obs, base, protocol);
      const mid =
        protocol === "uniswap" || twoSided
          ? q.price
          : q.price / (1 - feeBps / 10000);
      venues.push({
        protocol,
        swapType: SWAP_TYPE[protocol],
        price: mid,
        feeBps,
        ...(twoSided ? { sellPrice: q.sellPrice, buyPrice: q.buyPrice } : {}),
      });
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
