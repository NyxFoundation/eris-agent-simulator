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
