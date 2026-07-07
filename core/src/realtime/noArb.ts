// Cross-venue no-arbitrage check (phantom-spread guard).
//
// After setup the venues are calibrated to fair within ~±20bps and every venue charges >=30bps per
// side, so an *executable* cross-venue round trip (buy base on venue A, sell on venue B, both
// prices fee/impact-inclusive) must not be profitable. A positive executable profit that persists
// means the pricing/observation layer is broken (e.g. the curve one-sided-probe bias behind the
// WBTC all-agent bleed) or the deploy is mis-calibrated (e.g. token sort order flipped by a split
// deploy broke BalancerQueries) — agents then rationally trade a spread that does not exist and
// bleed fees. The coordinator runs this once at startup (fail-fast on gross breakage) and every
// block (persistent warning only: transient positive arb is the alpha agents are meant to take).
import type { ProtocolId } from "@eris/sdk/types.js";

// Executable quotes for one venue (USD per base, fee/impact-inclusive at probe size).
export type VenueExecQuote = {
  venue: "uniswap" | "balancer" | "curve";
  buyPx: number; // USD paid per base when buying
  sellPx: number; // USD received per base when selling
};

export type ArbFinding = {
  base: string;
  buyVenue: string; // venue with the lowest executable buy price
  sellVenue: string; // venue with the highest executable sell price
  profitBps: number; // executable round-trip profit (>0 = free money at probe size)
};

// Startup: calibration noise is ~±20bps of mid gap against >=60bps of round-trip cost, so any
// positive executable profit at startup is suspicious, and >300bps is unambiguously broken
// (the split-deploy sort-order breakage measured ~1000x price error).
export const STARTUP_WARN_BPS = 10;
export const STARTUP_FAIL_BPS = 300;
// Per block: uninformed flow creates transient executable arbs by design, so warn only when one
// persists for PERSIST_BLOCKS consecutive blocks (nobody can capture it = structural).
export const PERSIST_WARN_BPS = 50;
export const PERSIST_BLOCKS = 10;

// Legacy per-side fee assumption for states without a two-sided quote (matches the old flat
// correction in example/agents/lib/markets.ts).
const LEGACY_FEE_FRAC = 0.003;

// Structural view of the three AMM adapter states (uniswap / balancer / curve). The market config
// rides along in each state entry, so the uniswap fee is read from market.uniswap.fee (pips).
type AmmMarketStateLike = {
  market: { base: string; uniswap?: { fee: number } };
  priceUsdcPerWeth: number;
  sellPriceUsdcPerWeth?: number;
  buyPriceUsdcPerWeth?: number;
};
type AmmStateLike = { markets?: AmmMarketStateLike[] };

function quoteFor(
  venue: VenueExecQuote["venue"],
  ms: AmmMarketStateLike,
): VenueExecQuote | null {
  if (venue === "uniswap") {
    // slot0 mid + pool fee (pips; 3000 = 30bps). Impact at probe size is negligible on the deep pool.
    const mid = ms.priceUsdcPerWeth;
    const feeFrac = (ms.market.uniswap?.fee ?? 3000) / 1_000_000;
    if (!(mid > 0)) return null;
    return { venue, buyPx: mid / (1 - feeFrac), sellPx: mid * (1 - feeFrac) };
  }
  // balancer/curve: prefer the measured two-sided executable quote.
  if (
    typeof ms.sellPriceUsdcPerWeth === "number" &&
    ms.sellPriceUsdcPerWeth > 0 &&
    typeof ms.buyPriceUsdcPerWeth === "number" &&
    ms.buyPriceUsdcPerWeth > 0
  ) {
    return {
      venue,
      buyPx: ms.buyPriceUsdcPerWeth,
      sellPx: ms.sellPriceUsdcPerWeth,
    };
  }
  // Legacy one-sided state: priceUsdcPerWeth is the fee-inclusive sell quote.
  const sellPx = ms.priceUsdcPerWeth;
  if (!(sellPx > 0)) return null;
  return {
    venue,
    buyPx: sellPx / (1 - LEGACY_FEE_FRAC) ** 2,
    sellPx,
  };
}

// Collect executable quotes per base from the adapter states.
export function venueExecQuotes(
  stateById: Map<ProtocolId, unknown>,
  enabledIds: ProtocolId[],
): Record<string, VenueExecQuote[]> {
  const byBase: Record<string, VenueExecQuote[]> = {};
  for (const venue of ["uniswap", "balancer", "curve"] as const) {
    if (!enabledIds.includes(venue)) continue;
    const state = stateById.get(venue) as AmmStateLike | undefined;
    for (const ms of state?.markets ?? []) {
      const q = quoteFor(venue, ms);
      if (!q) continue;
      (byBase[ms.market.base] ??= []).push(q);
    }
  }
  return byBase;
}

// Best executable cross-venue arb for one base (buy on the cheapest buyPx, sell on the highest
// sellPx; different venues). Returns null with fewer than 2 venues. profitBps may be negative
// (healthy: the round trip loses the fees).
export function bestExecutableArb(
  base: string,
  quotes: VenueExecQuote[],
): ArbFinding | null {
  if (quotes.length < 2) return null;
  let best: ArbFinding | null = null;
  for (const buy of quotes) {
    for (const sell of quotes) {
      if (buy.venue === sell.venue) continue;
      const profitBps = (sell.sellPx / buy.buyPx - 1) * 10_000;
      if (!best || profitBps > best.profitBps) {
        best = { base, buyVenue: buy.venue, sellVenue: sell.venue, profitBps };
      }
    }
  }
  return best;
}

// Per-base best findings (sorted worst-first = largest executable profit first).
export function noArbFindings(
  stateById: Map<ProtocolId, unknown>,
  enabledIds: ProtocolId[],
): ArbFinding[] {
  const byBase = venueExecQuotes(stateById, enabledIds);
  const findings: ArbFinding[] = [];
  for (const [base, quotes] of Object.entries(byBase)) {
    const f = bestExecutableArb(base, quotes);
    if (f) findings.push(f);
  }
  findings.sort((a, b) => b.profitBps - a.profitBps);
  return findings;
}

// Tracks consecutive blocks of executable arb per base and decides when to emit a persistent
// warning (every PERSIST_BLOCKS blocks while the violation continues).
export class NoArbMonitor {
  private consecutive = new Map<string, number>();

  // Returns the findings that crossed a PERSIST_BLOCKS boundary this block (usually 0 or 1).
  check(
    findings: ArbFinding[],
  ): Array<ArbFinding & { consecutiveBlocks: number }> {
    const out: Array<ArbFinding & { consecutiveBlocks: number }> = [];
    const seen = new Set<string>();
    for (const f of findings) {
      seen.add(f.base);
      if (f.profitBps > PERSIST_WARN_BPS) {
        const n = (this.consecutive.get(f.base) ?? 0) + 1;
        this.consecutive.set(f.base, n);
        if (n % PERSIST_BLOCKS === 0) out.push({ ...f, consecutiveBlocks: n });
      } else {
        this.consecutive.set(f.base, 0);
      }
    }
    // A base that stopped reporting (probe failure) resets rather than keeping a stale count.
    for (const base of this.consecutive.keys()) {
      if (!seen.has(base)) this.consecutive.set(base, 0);
    }
    return out;
  }
}
