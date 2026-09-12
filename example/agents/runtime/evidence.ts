/**
 * evidence.ts: what the revision loop knows about the interval it is being asked to judge (#76).
 *
 * The self-improvement loop used to hand the model two PnL numbers, the last twelve decisions, and
 * one observation -- the latest. That is a snapshot. "I lost money during the depeg" and "my
 * arbitrage does not win" both reach the model as a dip and nothing else, and every bundled
 * prompt.md rightly answered "leave it alone", because there was nothing in the context that could
 * tell one failure apart from another.
 *
 * None of that was an environment limitation. The runtime is the participant's own code, the
 * observation already carries the raw signals, and send.ts already resolves its own receipts. What
 * was missing was somebody keeping the history and attributing the outcomes. That is this file:
 *
 *   MarketHistory   one sample per observed block, kept for the revision interval, reported as a
 *                   digest rather than as rows (60 whole observations would be the token budget)
 *   TradeLedger     one entry per transaction the agent sent, from the block it was decided on to
 *                   what the position was worth a few blocks after it landed
 *
 * Both are read-only bookkeeping over things the agent can already see. Neither adds a chain call:
 * MarketHistory samples the observation the block loop already built, and TradeLedger is fed from
 * the receipts computeCompetition already fetches (ADR 0011).
 *
 * The digests are deliberately small. Context size is the participant's inference cost (rules
 * §2.5) and the proxy records every call (§2.3), so this reports extremes, counts and windows --
 * the shape of the interval -- not the interval itself.
 */
import type { AgentObservation } from "@eris/sdk/types.js";

// How far a stable has to sit from a dollar before the digest calls it a departure. Par is a
// convention, not an observation, so a couple of bps of noise around it is not news; 25 bps is
// roughly where a stable-stable pool's fee stops explaining the difference.
export const PEG_BAND_BPS = 25;

// Buckets the venue-gap series is counted into. A threshold would have to be the strategy's own,
// and the runtime does not know it -- so instead of guessing one, the digest reports how many
// blocks the gap spent above each of a fixed ladder. A strategy that fires at 10 bps can read its
// own threshold off the ladder, and so can one that should move it.
export const GAP_BUCKETS_BPS = [5, 10, 25, 50] as const;

// One venue-and-base price series, keyed `<protocol>:<base>`.
export type VenueSample = {
  // Pool price in USDC per unit of the base, as the observation reports it.
  price: number;
  // (pool - fair) / fair, in bps. Positive means the venue is rich.
  gapBps: number;
  // Round-trip cost the venue itself quoted, when it quotes one (balancer / curve / lst). An edge
  // below twice this is fee bleed however wide the gap looks.
  halfSpreadBps?: number;
};

// What one block looked like. Small on purpose: this is kept for every block of the interval.
export type MarketSample = {
  block: number;
  // Marked value of everything the agent holds, from the observation. Null when the observation did
  // not carry one.
  valueUsdc: number | null;
  // Base symbol -> fair price in USD, as the PriceFeed published it.
  fair: Record<string, number>;
  // Base symbol -> how much of it the wallet held at this block, in whole units (8.0 WETH, not
  // wei). Spot only: WETH counts the native ETH next to it, since the two are the same exposure.
  // This is what turns "the marked value moved" into two numbers -- what the market did to what the
  // agent was already holding, and what the trade did -- and without it the first is reported as
  // the second (the smoke run of 2026-09-07 showed a do-nothing agent "earning" +6,562 USDC over the
  // same windows in which the trading agent was credited with +6,877).
  holdings: Record<string, number>;
  venues: Record<string, VenueSample>;
  // Stable symbol -> what the market says it is worth. `marketQuoted: false` means par by
  // convention or by fallback, which must not be read as "the peg is holding".
  stables: Record<string, { priceUsdc: number; marketQuoted: boolean }>;
  // Venues whose opportunity is a discount rather than a gap against a fair price: the LST's market
  // price against what the vault owes (and eUSD's pool price against par, only when the registry
  // does not already price eUSD as a stable -- see sampleObservation). They were missing from the
  // first cut of this file, which left `lst-carry` and `redemption-arb` reading prompts that
  // pointed at evidence the digest never produced.
  discounts: Record<string, { bps: number; quoted: boolean }>;
};

function bps(actual: number, reference: number): number {
  if (!Number.isFinite(actual) || !Number.isFinite(reference) || reference === 0)
    return 0;
  return ((actual - reference) / reference) * 10_000;
}

// Pull the price series out of one observation.
//
// Every venue that publishes a base price is sampled, including the per-base `markets` maps that
// ADR 0013 added -- a WBTC dislocation is invisible if only the WETH pool is read, and the thin
// bases are where the gaps live.
export function sampleObservation(obs: AgentObservation): MarketSample {
  // A fair price of zero is a feed that has not been published yet (the first observations of a
  // run can land while setup is still writing it), not a base worth nothing. Marking against it
  // would turn the whole holding into a "market move" the moment the feed comes alive.
  const fair: Record<string, number> = {};
  if (Number.isFinite(obs.fairPriceUsdcPerWeth) && obs.fairPriceUsdcPerWeth > 0)
    fair.WETH = obs.fairPriceUsdcPerWeth;
  for (const [base, price] of Object.entries(obs.fairPricesUsd ?? {}))
    if (typeof price === "number" && Number.isFinite(price) && price > 0)
      fair[base] = price;

  const venues: Record<string, VenueSample> = {};
  const add = (
    protocol: string,
    base: string,
    price: unknown,
    halfSpreadBps?: unknown,
  ): void => {
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0)
      return;
    const reference = fair[base];
    if (reference === undefined) return;
    venues[`${protocol}:${base}`] = {
      price,
      gapBps: bps(price, reference),
      ...(typeof halfSpreadBps === "number" && Number.isFinite(halfSpreadBps)
        ? { halfSpreadBps }
        : {}),
    };
  };

  const p = obs.protocols ?? {};
  if (p.uniswap) {
    add("uniswap", "WETH", p.uniswap.pool?.priceUsdcPerWeth);
    for (const [base, m] of Object.entries(p.uniswap.markets ?? {}))
      add("uniswap", base, m.priceUsdcPerWeth);
  }
  for (const id of ["balancer", "curve"] as const) {
    const venue = p[id];
    if (!venue) continue;
    add(id, "WETH", venue.priceUsdcPerWeth, venue.effectiveHalfSpreadBps);
    for (const [base, m] of Object.entries(venue.markets ?? {}))
      add(id, base, m.priceUsdcPerWeth, m.effectiveHalfSpreadBps);
  }
  if (p.gmx) {
    add("gmx", "WETH", p.gmx.marketPriceUsd);
    for (const [base, m] of Object.entries(p.gmx.markets ?? {}))
      add("gmx", base, m.marketPriceUsd);
  }

  const stables: MarketSample["stables"] = {};
  for (const [symbol, s] of Object.entries(obs.balances?.stables ?? {})) {
    if (typeof s?.priceUsdc !== "number" || !Number.isFinite(s.priceUsdc))
      continue;
    stables[symbol] = {
      priceUsdc: s.priceUsdc,
      marketQuoted: s.marketQuoted === true,
    };
  }

  const discounts: MarketSample["discounts"] = {};
  if (p.lst && Number.isFinite(p.lst.discountBps))
    discounts["lst:market-vs-redemption"] = {
      bps: p.lst.discountBps,
      // Undefined predates the flag and meant "quoted"; false means the pool refused, and a refusal
      // is not a 100% discount.
      quoted: p.lst.marketQuoted !== false,
    };
  // eUSD is reported once. Since issue #27 it is a market-priced stable in the registry, so its
  // price already arrives in `stables` with the stables' sign (negative = below a dollar). The
  // liquity adapter's discount is the same price with the sign flipped (positive = below par), and
  // a run that showed both put "-90 bps" and "+90 bps" for one depeg in two sections of the same
  // context. The adapter's figure is used only when the registry has no entry for it.
  if (
    !("EUSD" in stables) &&
    p.liquity &&
    Number.isFinite(p.liquity.discountBps)
  )
    discounts["liquity:EUSD-vs-par"] = {
      bps: p.liquity.discountBps,
      quoted: p.liquity.marketQuoted === true,
    };

  const holdings: Record<string, number> = {};
  const units = (raw: unknown, decimals: number): number | null => {
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
    const n = Number(raw) / 10 ** decimals;
    return Number.isFinite(n) ? n : null;
  };
  for (const [base, raw] of Object.entries(obs.baseBalances ?? {})) {
    // No decimals means no way to read the figure; a guessed 18 on an 8-decimal token is a
    // ten-billion-fold error, which is worse than leaving that base's share of the move unexplained.
    const decimals = obs.baseDecimals?.[base];
    if (typeof decimals !== "number") continue;
    const n = units(raw, decimals);
    if (n !== null) holdings[base] = n;
  }
  const weth = units(obs.balances?.wethWei, 18);
  const eth = units(obs.balances?.ethWei, 18);
  if (weth !== null || eth !== null)
    holdings.WETH = (holdings.WETH ?? weth ?? 0) + (eth ?? 0);

  const value = obs.inventory?.valueUsdc;
  return {
    block: obs.round,
    valueUsdc: typeof value === "number" ? value : null,
    fair,
    holdings,
    venues,
    stables,
    discounts,
  };
}

/// What holding `holdings` would have gained or lost between two fair-price marks, in USDC.
///
/// The counterfactual behind every attribution in this file: the agent could always have done
/// nothing, and "nothing" is worth this much. Only the bases priced at both ends count; a base
/// missing from either side is left out rather than priced at zero. Null when no base could be
/// priced, which the caller reports as "the market's share is unknown" rather than as zero.
export function marketMoveUsdc(
  holdings: Record<string, number>,
  fairFrom: Record<string, number>,
  fairTo: Record<string, number>,
): number | null {
  let sum = 0;
  let priced = 0;
  for (const [base, held] of Object.entries(holdings)) {
    const from = fairFrom[base];
    const to = fairTo[base];
    if (
      !Number.isFinite(held) ||
      from === undefined ||
      to === undefined ||
      from <= 0 ||
      to <= 0
    )
      continue;
    sum += held * (to - from);
    priced += 1;
  }
  return priced === 0 ? null : sum;
}

/// One sample per observed block, kept for as long as the revision interval needs it.
///
/// A ring rather than a growing array: the run is 360 blocks and the interval is 60, so the whole
/// history is never wanted and keeping it would be a leak with a nice name.
export class MarketHistory {
  private readonly samples: MarketSample[] = [];
  // Same samples, keyed by block. The ledger asks for the gap at one block once per unresolved
  // transaction per block; a linear scan there is samples x transactions of work in the block loop's
  // hot path, which is the two-second budget this file is supposed to stay out of.
  private readonly byBlock = new Map<number, MarketSample>();
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /// Grow the buffer to cover a revision interval that is only known later.
  ///
  /// The runtime has to have somewhere to put the first block's sample before it has parsed
  /// prompt.md, and a buffer shorter than the interval hands the model a window that stops before
  /// the event it is being asked about. Growing is the only direction: shrinking would drop samples
  /// the current interval still needs.
  ensureCapacity(blocks: number): void {
    if (blocks > this.capacity) this.capacity = blocks;
  }

  push(obs: AgentObservation): void {
    // The block loop can fire twice for one block on a reconnect; a duplicate would double-count
    // every bucket below.
    const last = this.samples[this.samples.length - 1];
    if (last && last.block >= obs.round) return;
    const sample = sampleObservation(obs);
    this.samples.push(sample);
    this.byBlock.set(sample.block, sample);
    if (this.samples.length > this.capacity)
      for (const dropped of this.samples.splice(
        0,
        this.samples.length - this.capacity,
      ))
        this.byBlock.delete(dropped.block);
  }

  get size(): number {
    return this.samples.length;
  }

  /// The sample taken at one block, if that block was observed and is still in the ring.
  at(block: number): MarketSample | undefined {
    return this.byBlock.get(block);
  }

  latest(): MarketSample | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  /// The gap this agent saw on one venue at one block, in bps.
  ///
  /// This is the edge a decision was taken on, which the action itself does not record. `base`
  /// omitted means the WETH market, which is how every action that predates ADR 0013's per-base
  /// markets spells it.
  gapAt(block: number, protocol?: string, base?: string): number | undefined {
    if (!protocol) return undefined;
    return this.byBlock.get(block)?.venues[`${protocol}:${base ?? "WETH"}`]
      ?.gapBps;
  }

  /// Everything from `block` onwards. `null` means the whole buffer, which is what the first
  /// revision of a run gets.
  since(block: number | null): MarketSample[] {
    if (block === null) return [...this.samples];
    return this.samples.filter((s) => s.block >= block);
  }
}

type Series = { min: number; max: number; last: number; minAt: number; maxAt: number };

function series(
  samples: MarketSample[],
  pick: (s: MarketSample) => number | undefined,
): Series | null {
  let out: Series | null = null;
  for (const s of samples) {
    const v = pick(s);
    if (v === undefined || !Number.isFinite(v)) continue;
    if (out === null) {
      out = { min: v, max: v, last: v, minAt: s.block, maxAt: s.block };
      continue;
    }
    if (v < out.min) {
      out.min = v;
      out.minAt = s.block;
    }
    if (v > out.max) {
      out.max = v;
      out.maxAt = s.block;
    }
    out.last = v;
  }
  return out;
}

// A contiguous run of blocks in which a series sat outside a band around zero. Used for both the
// stables against par and the venues whose opportunity is a discount.
type Departure = {
  from: number;
  to: number;
  blocks: number;
  // Signed, and that is the point: for eUSD a departure can be a discount (negative, a redemption
  // is worth taking) or a premium (positive, underwriting at that price has to earn it back
  // first). An unsigned "worst 1.0150" cannot tell those apart.
  worstBps: number;
  worstAt: number;
  open: boolean;
};

function departures(
  samples: MarketSample[],
  // Signed bps from the reference, or undefined for a block that says nothing. Undefined is not
  // zero: an unquoted stable reads as par because nothing observed it, and treating that as "back
  // at par" would close a window the market never closed.
  pick: (s: MarketSample) => number | undefined,
  bandBps: number,
): Departure[] {
  const out: Departure[] = [];
  let open: Departure | null = null;
  for (const s of samples) {
    const v = pick(s);
    if (v === undefined || Math.abs(v) <= bandBps) {
      if (open) {
        out.push(open);
        open = null;
      }
      continue;
    }
    if (!open)
      open = {
        from: s.block,
        to: s.block,
        blocks: 1,
        worstBps: v,
        worstAt: s.block,
        open: false,
      };
    else {
      open.to = s.block;
      open.blocks += 1;
      if (Math.abs(v) > Math.abs(open.worstBps)) {
        open.worstBps = v;
        open.worstAt = s.block;
      }
    }
  }
  if (open) out.push({ ...open, open: true });
  return out;
}

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

function signed(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${fmt(n, digits)}`;
}

/// The interval's price history, as lines for the revision context.
///
/// Extremes, counts and windows -- not rows. Sixty whole observations would be the entire token
/// budget, and the model does not need the interval replayed; it needs to know when the window was
/// open, how wide it got, and whether it is still open.
export function digestMarketHistory(
  samples: MarketSample[],
  opts: { pegBandBps?: number; gapBucketsBps?: readonly number[] } = {},
): string[] {
  if (samples.length === 0) return [];
  const band = opts.pegBandBps ?? PEG_BAND_BPS;
  const buckets = opts.gapBucketsBps ?? GAP_BUCKETS_BPS;
  const first = samples[0].block;
  const last = samples[samples.length - 1].block;
  const lines: string[] = [
    `market history, blocks ${first}..${last} (${samples.length} observed):`,
  ];

  const value = series(samples, (s) => s.valueUsdc ?? undefined);
  if (value)
    lines.push(
      `  marked value: ${fmt(value.last)} USDC now; low ${fmt(value.min)} @b${value.minAt}, ` +
        `high ${fmt(value.max)} @b${value.maxAt}`,
    );

  const bases = new Set<string>();
  for (const s of samples) for (const b of Object.keys(s.fair)) bases.add(b);
  for (const base of [...bases].sort()) {
    const f = series(samples, (s) => s.fair[base]);
    if (!f) continue;
    lines.push(
      `  fair ${base}: ${fmt(f.last)} now; low ${fmt(f.min)} @b${f.minAt}, high ${fmt(f.max)} @b${f.maxAt}`,
    );
  }

  const keys = new Set<string>();
  for (const s of samples) for (const k of Object.keys(s.venues)) keys.add(k);
  if (keys.size > 0) {
    lines.push(
      `  venue gap vs fair in bps (low / high / now, then blocks with |gap| over ` +
        `${buckets.join("/")} bps of ${samples.length}):`,
    );
    for (const key of [...keys].sort()) {
      const g = series(samples, (s) => s.venues[key]?.gapBps);
      if (!g) continue;
      const counts = buckets.map(
        (b) =>
          samples.filter((s) => {
            const v = s.venues[key]?.gapBps;
            return v !== undefined && Math.abs(v) > b;
          }).length,
      );
      const halfSpread = samples
        .map((s) => s.venues[key]?.halfSpreadBps)
        .filter((v): v is number => typeof v === "number");
      // The widest the venue quoted during the interval, not the latest. Curve's dynamic fee moves
      // (it widened the real bid-ask to ~128 bps during the WBTC bleed), and a "round trip costs 24
      // bps" taken from the calmest block of the interval is the number that makes fee bleed look
      // like a threshold problem.
      const cost =
        halfSpread.length > 0
          ? ` — round trip cost up to ${fmt(
              2 * halfSpread.reduce((a, b) => (b > a ? b : a), halfSpread[0]),
              1,
            )} bps here`
          : "";
      lines.push(
        `    ${key}: ${fmt(g.min, 1)} @b${g.minAt} / ${fmt(g.max, 1)} @b${g.maxAt} / ${fmt(g.last, 1)}` +
          ` — over: ${counts.join("/")}${cost}`,
      );
    }
  }

  const symbols = new Set<string>();
  for (const s of samples)
    for (const [sym, q] of Object.entries(s.stables))
      if (sym !== "USDC" && q.marketQuoted) symbols.add(sym);
  if (symbols.size > 0) {
    lines.push(`  stables against par (band ${band} bps, negative is below a dollar):`);
    for (const symbol of [...symbols].sort()) {
      const pick = (s: MarketSample): number | undefined => {
        const q = s.stables[symbol];
        return q !== undefined && q.marketQuoted ? bps(q.priceUsdc, 1) : undefined;
      };
      const windows = departures(samples, pick, band);
      if (windows.length === 0) {
        const p = series(samples, pick);
        lines.push(
          `    ${symbol}: inside the band throughout` +
            (p ? ` (now ${fmt(1 + p.last / 10_000, 4)})` : ""),
        );
        continue;
      }
      for (const w of windows)
        lines.push(
          `    ${symbol}: outside b${w.from}..b${w.to} (${w.blocks} blocks), worst ` +
            `${fmt(w.worstBps, 1)} bps (${fmt(1 + w.worstBps / 10_000, 4)})` +
            ` @b${w.worstAt}${w.open ? " — STILL OUTSIDE" : " — back inside"}`,
        );
    }
  }

  const discountKeys = new Set<string>();
  for (const s of samples)
    for (const [key, d] of Object.entries(s.discounts))
      if (d.quoted) discountKeys.add(key);
  if (discountKeys.size > 0) {
    lines.push(
      `  venue discounts (band ${band} bps, positive means the market is cheap against what the ` +
        `venue will pay):`,
    );
    for (const key of [...discountKeys].sort()) {
      const pick = (s: MarketSample): number | undefined => {
        const d = s.discounts[key];
        return d !== undefined && d.quoted ? d.bps : undefined;
      };
      const windows = departures(samples, pick, band);
      const p = series(samples, pick);
      if (windows.length === 0) {
        lines.push(
          `    ${key}: inside the band throughout` +
            (p ? ` (now ${fmt(p.last, 1)} bps)` : " (never quoted)"),
        );
        continue;
      }
      for (const w of windows)
        lines.push(
          `    ${key}: open b${w.from}..b${w.to} (${w.blocks} blocks), widest ` +
            `${fmt(w.worstBps, 1)} bps @b${w.worstAt}` +
            (w.open ? " — STILL OPEN" : " — closed"),
        );
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Transaction attribution
// ---------------------------------------------------------------------------

/// One transaction, from the decision that produced it to what it was worth afterwards.
///
/// The three faults behind "my arbitrage does not win" are *late*, *reverted* and *edge below the
/// round trip*, and only the last one is a threshold change. Without inclusion latency, txIndex and
/// a value delta, all three arrive as the same dip.
export type TradeRecord = {
  hash: string;
  // The observation block the strategy decided on. The distance from here to `includedAtBlock` is
  // how late the transaction was.
  decidedAtBlock: number;
  actionType?: string;
  protocol?: string;
  base?: string;
  // The principal the action asked for, in the input token's own units, when it has one. Raw
  // transactions and deployments have none.
  amount?: string;
  // The venue gap the strategy was looking at when it decided, in bps -- the edge it *quoted*
  // itself. Filled from the market history rather than from the action, because the action does not
  // carry why it was taken. Paired with the value delta below it answers "I fired at 30 bps and it
  // netted what", which is the comparison the fee-bleed diagnosis needs.
  quotedGapBps?: number;
  status?: "success" | "reverted";
  includedAtBlock?: number;
  txIndex?: number;
  // Marked value before the trade and VALUE_MARK_DELAY_BLOCKS after it landed. The baseline is the
  // observation the strategy decided on -- the last mark that does not yet contain the trade -- so
  // the difference includes the trade's own execution: an arbitrage earns its edge *at* the fill,
  // and a baseline taken after inclusion had already banked it and measured three blocks of drift
  // instead. When the decision block's sample is gone (a missed block, or a ring that has rolled),
  // the first mark at or after inclusion is used and `baselineAfterInclusion` says so.
  valueBefore?: number;
  valueBeforeBlock?: number;
  baselineAfterInclusion?: boolean;
  valueAfter?: number;
  markedAtBlock?: number;
  // What the inventory held at the baseline would have done over the same window at fair prices.
  // The raw difference above is the market's move on that inventory plus whatever the trade did;
  // this is the first of those two, so the second can be shown on its own. Undefined when the
  // baseline sample carried no holdings or the fair prices were missing at either end.
  marketValueDeltaUsdc?: number;
};

export type TradeAggregate = {
  sent: number;
  included: number;
  reverted: number;
  pending: number;
  meanInclusionLatencyBlocks: number | null;
  meanTxIndex: number | null;
  // Mean *size* of the gaps the strategy fired on, in bps. Against `attributedValueDeltaUsdc` this
  // is "what I expected" against "what I got". Unsigned on purpose: what the fee-bleed comparison
  // needs is how much edge was on the table, and a signed mean over a strategy that trades both
  // directions cancels to something near zero that means nothing. The direction lives in the two
  // counts below.
  meanQuotedGapBps: number | null;
  // How those gaps were signed. A mean over signed gaps cancels, and the sign is the direction of
  // the bet: firing on a rich venue and losing in a falling market is being directionally wrong,
  // which is a different fault from bleeding fees.
  quotedOnCheapVenue: number;
  quotedOnRichVenue: number;
  // Sum of the per-trade marked-value deltas that have had time to settle, as marked: the market's
  // move on the inventory held plus whatever the trades did. Not the run's PnL (it excludes the
  // blocks in which nothing was trading), and not the trades' own figure either -- that is
  // `tradeValueDeltaUsdc` below.
  rawValueDeltaUsdc: number | null;
  attributedTrades: number;
  // The raw figure split in two, over the settled trades whose baseline carried holdings: what
  // holding the baseline inventory at fair prices would have done over the same windows, and the
  // remainder, which is what the trades themselves did. The second is the number to judge a
  // strategy on. Both null when no settled trade could be split.
  marketValueDeltaUsdc: number | null;
  tradeValueDeltaUsdc: number | null;
  splitTrades: number;
};

// Blocks to wait after inclusion before marking a trade's value delta. Small: an arbitrage that has
// not paid off in three blocks was not an arbitrage, and a longer window mostly measures the market.
export const VALUE_MARK_DELAY_BLOCKS = 3;

// How late a marked value may be and still serve as a trade's baseline. The block loop can miss a
// block under load, and a baseline one block late is still a baseline; five blocks late is the
// market. A record that never gets one is reported as unattributed rather than attributed wrongly.
export const VALUE_BASELINE_SLACK_BLOCKS = 1;

// The actions whose decision is a *venue gap*, so a gap is the edge they quoted themselves. A
// stableSwap or a Trove adjustment is not one of these: attributing the WETH pool's gap to it would
// put a number in front of the model that had nothing to do with the decision.
//
// `bundle` is absent on purpose and costs nothing: validateAction decomposes a bundle into leaf
// intents before anything is sent, so a bundled swap reaches the ledger as `swap` with its own
// hash, not as `bundle` (send.ts submit()).
const GAP_TRADING_ACTIONS = new Set(["swap", "balancerSwap", "curveSwap"]);

/// The agent's own transactions, indexed by hash.
///
/// Fed from three places, none of which costs a chain call: the sender when a transaction goes out,
/// the receipt resolution computeCompetition already does every block (ADR 0011), and the block loop
/// when it has a fresh marked value.
export class TradeLedger {
  private readonly records: TradeRecord[] = [];
  private readonly byHash = new Map<string, TradeRecord>();
  // Holdings and fair prices at each open trade's baseline, held until the settled mark computes
  // the market's share. Not on the record: a record is what the digest reads, and two price maps
  // per trade are working state, not evidence.
  private readonly baselineMarket = new Map<
    string,
    { holdings: Record<string, number>; fair: Record<string, number> }
  >();
  private readonly capacity: number;
  // Looks up the venue gap this agent saw at a given block. Supplied by the runtime, which owns the
  // market history; the ledger only knows hashes and blocks. Optional, so a participant runtime
  // that keeps no history still gets everything else.
  private readonly gapAt:
    | ((block: number, protocol?: string, base?: string) => number | undefined)
    | undefined;
  // The market sample at a block, for the pre-trade baseline. Same owner as `gapAt`; a runtime
  // without a history falls back to the first mark after inclusion, as before.
  private readonly sampleAt: ((block: number) => MarketSample | undefined) | undefined;

  constructor(
    opts: {
      capacity?: number;
      gapAt?: (
        block: number,
        protocol?: string,
        base?: string,
      ) => number | undefined;
      sampleAt?: (block: number) => MarketSample | undefined;
    } = {},
  ) {
    this.capacity = opts.capacity ?? 128;
    this.gapAt = opts.gapAt;
    this.sampleAt = opts.sampleAt;
  }

  submitted(record: TradeRecord): void {
    this.records.push(record);
    this.byHash.set(record.hash, record);
    if (this.records.length > this.capacity) {
      const dropped = this.records.splice(
        0,
        this.records.length - this.capacity,
      );
      for (const d of dropped) {
        this.byHash.delete(d.hash);
        this.baselineMarket.delete(d.hash);
      }
    }
  }

  /// A receipt has landed. First one wins.
  ///
  /// A reorg could in principle change a transaction's block or status afterwards, and this will
  /// not notice: the sender only chases receipts for transactions it has not resolved (send.ts
  /// computeCompetition), so nothing would call this a second time anyway. On anvil, where blocks
  /// are produced on a fixed interval by the environment, there is nothing to reorg -- and buying
  /// re-resolution would cost a receipt fetch per settled transaction per block, in the hot path.
  resolved(
    hash: string,
    info: { status: "success" | "reverted"; txIndex?: number; blockNumber?: number },
  ): void {
    const record = this.byHash.get(hash);
    if (!record || record.status !== undefined) return;
    record.status = info.status;
    if (info.txIndex !== undefined) record.txIndex = info.txIndex;
    if (info.blockNumber !== undefined) record.includedAtBlock = info.blockNumber;
  }

  /// A fresh marked value for this block. Fills the baseline and the settled figures for any
  /// transaction the block is the right moment for. `sample` is this block's market sample when the
  /// runtime keeps one; it supplies the holdings and fair prices that separate the market's share
  /// of each delta from the trade's.
  mark(block: number, valueUsdc: number | null, sample?: MarketSample): void {
    // The quoted edge is resolved here rather than at submit time: a transaction is built and sent
    // asynchronously, so at `submitted` the block it was decided on may not yet be in the history.
    if (this.gapAt)
      for (const r of this.records) {
        if (
          r.quotedGapBps !== undefined ||
          !GAP_TRADING_ACTIONS.has(r.actionType ?? "")
        )
          continue;
        const gap = this.gapAt(r.decidedAtBlock, r.protocol, r.base);
        if (gap !== undefined) r.quotedGapBps = gap;
      }
    if (valueUsdc === null || !Number.isFinite(valueUsdc)) return;
    for (const r of this.records) {
      if (r.includedAtBlock === undefined) continue;
      if (r.valueBefore === undefined) {
        // Preferred: the mark the strategy decided on, which predates the trade. Looked up here
        // rather than at submit time because a transaction is built asynchronously and the decision
        // block's sample may not have been pushed yet when `submitted` ran.
        const before =
          r.decidedAtBlock < r.includedAtBlock
            ? this.sampleAt?.(r.decidedAtBlock)
            : undefined;
        if (before && before.valueUsdc !== null) {
          r.valueBefore = before.valueUsdc;
          r.valueBeforeBlock = before.block;
          r.baselineAfterInclusion = false;
          this.baselineMarket.set(r.hash, {
            holdings: before.holdings,
            fair: before.fair,
          });
        } else if (
          block >= r.includedAtBlock &&
          block <= r.includedAtBlock + VALUE_BASELINE_SLACK_BLOCKS
        ) {
          r.valueBefore = valueUsdc;
          r.valueBeforeBlock = block;
          r.baselineAfterInclusion = true;
          if (sample)
            this.baselineMarket.set(r.hash, {
              holdings: sample.holdings,
              fair: sample.fair,
            });
        }
      }
      if (
        r.valueAfter === undefined &&
        block >= r.includedAtBlock + VALUE_MARK_DELAY_BLOCKS
      ) {
        r.valueAfter = valueUsdc;
        r.markedAtBlock = block;
        const baseline = this.baselineMarket.get(r.hash);
        if (baseline && sample) {
          const move = marketMoveUsdc(baseline.holdings, baseline.fair, sample.fair);
          if (move !== null) r.marketValueDeltaUsdc = move;
        }
        this.baselineMarket.delete(r.hash);
      }
    }
  }

  since(block: number | null): TradeRecord[] {
    return block === null
      ? [...this.records]
      : this.records.filter((r) => r.decidedAtBlock >= block);
  }

  /// What the interval's transactions did, as numbers rather than as a list.
  aggregate(block: number | null): TradeAggregate {
    // Gas refills are the runtime's housekeeping, not the strategy's trades; counting them would
    // put a revert rate on a decision the strategy never made (send.ts excludes them from the
    // competition signal for the same reason).
    const rows = this.since(block).filter(
      (r) => !String(r.actionType ?? "").startsWith("gasRefill"),
    );
    const included = rows.filter((r) => r.status !== undefined);
    const latencies = included
      .filter((r) => r.includedAtBlock !== undefined)
      .map((r) => r.includedAtBlock! - r.decidedAtBlock);
    const indices = included
      .filter((r) => r.txIndex !== undefined)
      .map((r) => r.txIndex!);
    const attributed = rows.filter(
      (r) => r.valueBefore !== undefined && r.valueAfter !== undefined,
    );
    const split = attributed.filter((r) => r.marketValueDeltaUsdc !== undefined);
    const quoted = rows
      .map((r) => r.quotedGapBps)
      .filter((v): v is number => typeof v === "number");
    const mean = (xs: number[]): number | null =>
      xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
    return {
      sent: rows.length,
      included: included.length,
      reverted: included.filter((r) => r.status === "reverted").length,
      pending: rows.length - included.length,
      meanInclusionLatencyBlocks: mean(latencies),
      meanTxIndex: mean(indices),
      meanQuotedGapBps: mean(quoted.map((v) => Math.abs(v))),
      quotedOnCheapVenue: quoted.filter((v) => v < 0).length,
      quotedOnRichVenue: quoted.filter((v) => v > 0).length,
      rawValueDeltaUsdc:
        attributed.length === 0
          ? null
          : attributed.reduce(
              (sum, r) => sum + (r.valueAfter! - r.valueBefore!),
              0,
            ),
      attributedTrades: attributed.length,
      marketValueDeltaUsdc:
        split.length === 0
          ? null
          : split.reduce((sum, r) => sum + r.marketValueDeltaUsdc!, 0),
      tradeValueDeltaUsdc:
        split.length === 0
          ? null
          : split.reduce(
              (sum, r) =>
                sum + (r.valueAfter! - r.valueBefore! - r.marketValueDeltaUsdc!),
              0,
            ),
      splitTrades: split.length,
    };
  }

  /// How each decision turned out, keyed by the block it was decided on.
  ///
  /// This is the join the model could not make before: a decision was in one list and its
  /// transaction's fate was in another file, so "included two blocks late, behind three
  /// competitors" and "reverted on the slippage bound" both read as "swap".
  outcomesByBlock(block: number | null): Map<number, string[]> {
    const out = new Map<number, string[]>();
    for (const r of this.since(block)) {
      const parts: string[] = [];
      if (r.status === undefined) parts.push("not mined yet");
      else {
        const late =
          r.includedAtBlock === undefined
            ? ""
            : ` @+${r.includedAtBlock - r.decidedAtBlock}`;
        const idx = r.txIndex === undefined ? "" : ` idx ${r.txIndex}`;
        parts.push(
          r.status === "reverted"
            ? `reverted${late}${idx}`
            : `included${late}${idx}`,
        );
      }
      if (r.valueBefore !== undefined && r.valueAfter !== undefined) {
        const raw = r.valueAfter - r.valueBefore;
        const split =
          r.marketValueDeltaUsdc === undefined
            ? "market share unknown"
            : `market ${signed(r.marketValueDeltaUsdc)}, trade ${signed(
                raw - r.marketValueDeltaUsdc,
              )}`;
        parts.push(
          `value ${signed(raw)} after ${VALUE_MARK_DELAY_BLOCKS}b (${split}` +
            `${r.baselineAfterInclusion ? "; baseline taken after inclusion" : ""})`,
        );
      }
      if (r.quotedGapBps !== undefined)
        parts.push(`decided on a ${fmt(r.quotedGapBps, 1)} bps gap`);
      const label =
        `${r.actionType ?? "tx"}${r.base ? ` ${r.base}` : ""}` +
        `${r.amount ? ` ${r.amount}` : ""}: ${parts.join(", ")}`;
      const list = out.get(r.decidedAtBlock);
      if (list) list.push(label);
      else out.set(r.decidedAtBlock, [label]);
    }
    return out;
  }
}

/// The interval's transaction aggregates, as lines for the revision context.
export function digestTrades(agg: TradeAggregate): string[] {
  if (agg.sent === 0)
    return ["transactions since the last revision: none were sent"];
  const lines = [
    // "mined" counts a revert too -- it made it into a block, it just did not do anything -- so the
    // three numbers are stated as a partition rather than left to be added up wrongly.
    `transactions since the last revision: ${agg.sent} sent = ` +
      `${agg.included - agg.reverted} succeeded + ${agg.reverted} mined-but-reverted + ` +
      `${agg.pending} never mined`,
  ];
  if (agg.meanInclusionLatencyBlocks !== null)
    lines.push(
      `  mean inclusion latency: ${fmt(agg.meanInclusionLatencyBlocks, 2)} blocks after the ` +
        `block the strategy decided on (0 is same block)`,
    );
  if (agg.meanTxIndex !== null)
    lines.push(
      `  mean position in the block: index ${fmt(agg.meanTxIndex, 2)} (lower is earlier; ` +
        `a rising index against a competitor's bid is being outbid, not a bad threshold)`,
    );
  if (agg.meanQuotedGapBps !== null)
    lines.push(
      `  mean gap the strategy fired on: ${fmt(agg.meanQuotedGapBps, 1)} bps ` +
        `(${agg.quotedOnCheapVenue} on a cheap venue, ${agg.quotedOnRichVenue} on a rich one). ` +
        `That is what it expected; the settled figure below is what it got`,
    );
  if (agg.rawValueDeltaUsdc !== null) {
    lines.push(
      `  marked value across the ${agg.attributedTrades} settled trades: ` +
        `${signed(agg.rawValueDeltaUsdc)} USDC, from the mark before each trade to ` +
        `${VALUE_MARK_DELAY_BLOCKS} blocks after it landed. That figure contains the market's ` +
        `move on the inventory the strategy was already holding, and is not what the trades did.`,
    );
    if (agg.marketValueDeltaUsdc !== null && agg.tradeValueDeltaUsdc !== null)
      lines.push(
        `  split over the ${agg.splitTrades} of them whose baseline carried holdings: ` +
          `holding that inventory at fair prices would have made ${signed(
            agg.marketValueDeltaUsdc,
          )} USDC; ` +
          `the trades themselves made ${signed(agg.tradeValueDeltaUsdc)} USDC. ` +
          `Judge the strategy on the second number (spot WETH/WBTC only; a perp, lending or ` +
          `staking position's market move is still inside it). Consecutive trades have ` +
          `overlapping windows, so this sum is per trade, not the interval's total -- that is ` +
          `the "what trading did" figure on the PnL line above.`,
      );
    else
      lines.push(
        `  the market's share of that could not be separated (no holdings were sampled), so read ` +
          `it against the fair-price move in the market history before crediting it to the trades.`,
      );
  }
  if (agg.included > 0 && agg.attributedTrades < agg.included)
    lines.push(
      `  ${agg.included - agg.attributedTrades} of the mined transactions are not in that figure: ` +
        `either they have not had ${VALUE_MARK_DELAY_BLOCKS} blocks to settle, or the block they ` +
        `landed in was not observed, and a baseline taken later would be measuring the market`,
    );
  return lines;
}
