// ADR 0011 §1b/§1c: what the environment pays, and what it tolerates, on the transactions that stage
// its own events (a launch wave's trades, a depeg's trades, a liquidity pull, a whale print).
//
// Under economicGas the environment's prices are storage writes and cannot be overtaken, but these
// transactions are ordinary ones in the fee auction. They are protected the way a real trader or LP
// protects a transaction -- an ordinary fee and, for trades, a slippage limit -- rather than by
// outbidding whoever might get ahead: a sandwich can take at most the limit's share of what the trade
// receives, and pushing further reverts it. Getting ahead of them is left to the participants to
// compete for among themselves.
//
// An earlier version (PR #287) had each of them bid a random share of its front-running value V,
// U × V / gas. It made the environment pay a searcher's price as the victim, and on its own larger gas
// it paid more than V (crash#101: ~$191 against $117 on six pulls). Removed on 2026-10-09 (ADR 0011
// §1c); V is still computed and recorded on the events, for reading what the ordering was worth.
//
// The draws come from the scenario's keyed streams (env-bid:<kind>), so they are reproducible as a
// stream and not predictable in advance.

import type { Rng, RngSnapshot } from "@eris/sdk/rng.js";

// A liquidity pull has no trade of its own to sandwich: what being ahead of it is worth depends on
// the trade that gets ahead. Valued at this reference size.
export const PULL_REFERENCE_TRADE_USD = 10_000;
// The spot venues' seeded depth, both sides: 3M USDC + the base at the anchor price, per venue and
// per base (deployer: uniswap-v3 / balancer / curve seed WETH/USDC and WBTC/USDC alike).
export const SEEDED_SPOT_DEPTH_USD = 6_000_000;

// A send the caller holds back so it can order several of one key's transactions by bid (ADR 0011
// §1b). Transactions from one sender are included in nonce order only, so a low bid sent first would
// hold back a higher one sent after it from the same key. `send` does the send and its bookkeeping
// and resolves to the hash, or null when the send failed (already reported).
export type DeferredSend = {
  priorityFeeWei: bigint;
  send: () => Promise<`0x${string}` | null>;
};

// Send highest bid first. Stable for equal bids, so the callers' own order breaks ties.
export async function sendByBid(sends: DeferredSend[]): Promise<Array<`0x${string}` | null>> {
  const order = sends
    .map((s, i) => ({ s, i }))
    .sort((a, b) =>
      a.s.priorityFeeWei === b.s.priorityFeeWei
        ? a.i - b.i
        : a.s.priorityFeeWei > b.s.priorityFeeWei
          ? -1
          : 1,
    );
  const out: Array<`0x${string}` | null> = new Array(sends.length).fill(null);
  for (const { s, i } of order) out[i] = await s.send();
  return out;
}

// An ordinary sender's fee for the environment's pulls and whale prints: median 1.4 gwei, σ 0.35,
// so the mean is about 1.5 gwei and nine in ten draws fall between about 0.8 and 2.5 gwei.
export const FLAT_FEE_MEDIAN_WEI = 1_400_000_000n;
export const FLAT_FEE_SIGMA = 0.35;

// Slippage limits for the environment's trades under economicGas, in basis points. The whale's is a
// fixed 0.5% (what the venue adapters already defaulted to; decided 2026-10-09). The launch wave's and
// the depeg's are drawn log-uniform over a factor-of-two range per trade: tight enough that a
// sandwich takes only a small share, where the old limits (launch 15%, depeg 5%) let it take most of
// a wave's impact.
export const WHALE_SLIPPAGE_BPS = 50;
export const LAUNCH_WAVE_SLIPPAGE_BPS: [number, number] = [300, 600];
export const DEPEG_SLIPPAGE_BPS: [number, number] = [100, 200];

export type EnvBidContext = {
  bidder: EnvBidder;
};

export type EnvBid = {
  priorityFeeWei: bigint;
  u: number;
  valueUsd: number;
};

export class EnvBidder {
  constructor(
    private readonly rng: Rng,
    private readonly floorWei: bigint,
  ) {}

  // A fee that does not depend on what getting ahead is worth: what an ordinary sender pays, drawn
  // around `medianWei` (lognormal, σ `sigma`). For the environment's transactions that are not
  // trades worth protecting with the fee -- a liquidity pull, and a whale whose protection is its
  // slippage limit (drawSlippageBps) -- because a fee priced at the front-running value was paid on
  // the environment's own, larger gas and came out above that value (PR #287 follow-up).
  flatBid(medianWei: bigint, sigma = FLAT_FEE_SIGMA): EnvBid {
    const u = Math.exp(sigma * this.rng.gaussian());
    const fee = BigInt(Math.max(1, Math.round(Number(medianWei) * u)));
    return {
      priorityFeeWei: fee > this.floorWei ? fee : this.floorWei,
      u,
      valueUsd: 0,
    };
  }

  // A slippage limit in basis points, log-uniform in [minBps, maxBps]: a sender's tolerance, so a
  // sandwich can take at most this share of what the trade receives (and a deeper push reverts it).
  drawSlippageBps(minBps: number, maxBps: number): number {
    const lo = Math.log(minBps);
    const hi = Math.log(maxBps);
    return Math.round(Math.exp(lo + (hi - lo) * this.rng.next()));
  }

  // The stream's position, for a practice period's checkpoint (periodResume.ts): a resumed period
  // continues the draws instead of repeating them from the start.
  snapshot(): RngSnapshot {
    return this.rng.snapshot();
  }


}

// The price-impact cost of a trade, in the units of whichever side `inIsUsd` names as dollars:
// what it receives (`quoted`) against what it would at the marginal rate (`smallQuoted` for
// `smallIn`, scaled up). Pool fees are in both quotes in proportion, so they cancel.
export function impactValueUsd(input: {
  amountIn: bigint;
  quoted: bigint;
  smallIn: bigint;
  smallQuoted: bigint;
  // Decimals of the dollar side, and which side that is.
  usdDecimals: number;
  usdSide: "in" | "out";
}): number {
  const { amountIn, quoted, smallIn, smallQuoted } = input;
  if (amountIn <= 0n || quoted <= 0n || smallIn <= 0n || smallQuoted <= 0n) return 0;
  const atMarginal = (smallQuoted * amountIn) / smallIn;
  if (atMarginal <= quoted) return 0;
  const scale = 10 ** input.usdDecimals;
  if (input.usdSide === "out") return Number(atMarginal - quoted) / scale;
  // Dollars in: the share of the input lost to impact.
  return (Number(amountIn) / scale) * (1 - Number(quoted) / Number(atMarginal));
}

// The marginal-rate probe for a trade of `amountIn`: a thousandth of it, at least one unit.
export function probeAmount(amountIn: bigint): bigint {
  const small = amountIn / 1000n;
  return small > 0n ? small : 1n;
}

// What a trade of N dollars gives up to price impact on a constant-product book with y dollars on
// the side it trades into: it receives x·N/(y+N) where the marginal price would give x·N/y, a
// shortfall of N²/(y+N) dollars. y is ONE side of the book: SEEDED_SPOT_DEPTH_USD counts both, and an
// earlier N²/(2D) with D = both sides put V at a quarter of this (PR #287 review).
export function constantProductShortfallUsd(notionalUsd: number, sideDepthUsd: number): number {
  if (!(notionalUsd > 0) || !(sideDepthUsd > 0)) return 0;
  return (notionalUsd * notionalUsd) / (sideDepthUsd + notionalUsd);
}

// V for a trade whose own quote the environment does not take before sending -- the whale's print
// goes out through the flow path -- on a seeded spot book (half of SEEDED_SPOT_DEPTH_USD a side).
// Constant product is exact for Uniswap's full-range seed and Balancer's 50/50 pool; Curve's
// twocrypto concentrates liquidity near its price scale, so there it overstates the impact, which
// errs toward the environment bidding more, not less.
export function seededImpactValueUsd(notionalUsd: number): number {
  return constantProductShortfallUsd(notionalUsd, SEEDED_SPOT_DEPTH_USD / 2);
}

// What a reference trade saves by executing before a pull takes depth from `depthBefore` to
// `depthAfter` (pool units; only the ratio is used), on a constant-product book whose side is half
// of SEEDED_SPOT_DEPTH_USD scaled by `depthBefore / seededDepth`: the shortfall N²/(y+N) after the
// pull minus the shortfall before it. Zero for a restore: depth coming back makes it better to be
// after, not before.
export function pullFrontRunValueUsd(input: {
  depthBefore: bigint;
  depthAfter: bigint;
  seededDepth: bigint;
}): number {
  const { depthBefore, depthAfter, seededDepth } = input;
  if (depthAfter >= depthBefore || depthAfter <= 0n || seededDepth <= 0n) return 0;
  const sideBefore = (SEEDED_SPOT_DEPTH_USD / 2) * (Number(depthBefore) / Number(seededDepth));
  const sideAfter = sideBefore * (Number(depthAfter) / Number(depthBefore));
  const n = PULL_REFERENCE_TRADE_USD;
  return (
    constantProductShortfallUsd(n, sideAfter) - constantProductShortfallUsd(n, sideBefore)
  );
}
