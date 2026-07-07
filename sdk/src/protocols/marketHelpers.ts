// Shared helpers for market resolution and base price lookup (ADR 0013, Phase 5).
//
// Each adapter is aligned to "resolve the market from action.base and use that market's venue leg".
// On the default fork only the WETH market exists, so the base-unspecified path (default WETH) is
// exactly identical to before (backward compatible). Bases like WBTC become resolvable as legs are added to MARKET_LEGS.
import { marketFor, type MarketConfig } from "../markets.js";
import type { ProtocolId, TokenSymbol } from "../types.js";
import type { SimContext } from "./types.js";

// Resolve the given protocol's market from the action's base (default WETH).
export function resolveMarket(
  protocol: ProtocolId,
  action: { base?: TokenSymbol },
): MarketConfig {
  const base = action.base ?? "WETH";
  const market = marketFor(protocol, base);
  if (!market) {
    throw new Error(`${protocol}: no market configured for base "${base}"`);
  }
  return market;
}

// An adapter looks up the fair price (USD) for the given base. Prefers ctx.fairPrices, else the single fairPrice.
// WETH matches the fallback, so this is backward compatible (works as before even when ctx.fairPrices is unset).
export function baseFairPrice(
  ctx: SimContext,
  base: TokenSymbol,
  fallback: number,
): number {
  const p = ctx.fairPrices?.[base];
  return p !== undefined && Number.isFinite(p) ? p : fallback;
}

// Two-sided executable quote (balancer/curve shared). mid = sqrt(sell*buy) cancels the (symmetric)
// fee/impact of the probe; halfSpread = per-side cost vs that mid. A one-sided sell probe
// under-reports the executable mid when reserves are imbalanced (twocrypto's dynamic fee widened
// the real bid-ask to ~128bps while consumers corrected by a flat 30bps), which showed agents a
// phantom cross-venue spread — the root cause of the WBTC all-agent bleed.
export type TwoSidedQuote = {
  priceUsdcPerWeth: number; // executable mid
  sellPriceUsdcPerWeth: number; // executable base->quote price (fee/impact included)
  buyPriceUsdcPerWeth: number; // executable quote->base price (fee/impact included)
  effectiveHalfSpreadBps: number; // per-side cost vs mid; round trip = 2x
};

export function twoSidedQuote(sellPx: number, buyPx: number): TwoSidedQuote {
  return {
    priceUsdcPerWeth: Math.sqrt(sellPx * buyPx),
    sellPriceUsdcPerWeth: sellPx,
    buyPriceUsdcPerWeth: buyPx,
    effectiveHalfSpreadBps: Math.max(
      0,
      (Math.sqrt(buyPx / sellPx) - 1) * 10_000,
    ),
  };
}

// Copy a state entry's two-sided fields into the observation (all-or-nothing: only when the buy
// probe succeeded). Absent fields signal consumers to fall back to the legacy 30bps convention.
export function twoSidedFields(
  entry: Partial<TwoSidedQuote> | undefined,
): Partial<Omit<TwoSidedQuote, "priceUsdcPerWeth">> {
  if (
    !entry ||
    entry.sellPriceUsdcPerWeth === undefined ||
    entry.buyPriceUsdcPerWeth === undefined ||
    entry.effectiveHalfSpreadBps === undefined
  )
    return {};
  return {
    sellPriceUsdcPerWeth: entry.sellPriceUsdcPerWeth,
    buyPriceUsdcPerWeth: entry.buyPriceUsdcPerWeth,
    effectiveHalfSpreadBps: entry.effectiveHalfSpreadBps,
  };
}
