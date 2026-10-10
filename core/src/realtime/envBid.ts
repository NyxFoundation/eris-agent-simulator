// ADR 0011 §1: what the environment bids for the transactions that stage its own events.
//
// Under economicGas the environment's prices are storage writes and cannot be overtaken, but the
// transactions that *make* an event -- a launch wave's buys, a depeg's sells and buy-back, a
// liquidity pull's withdrawals -- are ordinary transactions in the fee auction. At a fixed fee
// they are either always first (the old cap + 1 gwei) or always beatable (the default 0.1 gwei,
// measured: a 3 gwei bidder was ahead of every launch wave buy and took ~$2,000 more on launch#101).
// Neither is something to be good at. So each such transaction bids a random fraction of what
// getting ahead of it is worth:
//
//   priority fee per gas = U × V / G,   U ~ lognormal(median ENV_BID_MEDIAN, σ ENV_BID_SIGMA)
//
// G is the gas of the swap a front-runner would send on the same venue (FRONT_RUN_GAS), not this
// transaction's gas limit: a front-runner only has to beat the fee per gas and pays it on its own gas.
// Dividing by the padded limit (600k–900k) put the real bid at a fifth of U × V, and a single 150k for
// every venue still left it a third low against a 100k Uniswap swap (PR #287 review).
//
// V is the environment's own estimate of what a front-runner can take: the price-impact cost of
// its trade (a sandwich takes at most about that), or for a pull the slippage a reference trade
// saves by executing on the deeper book. P(U < 1) = 0.60: in about 60% of cases getting ahead pays
// if it is priced right, and in the rest the environment has bid more than it is worth, so bidding
// high is not a free win. The skill is pricing it: estimating V, and learning from the fees the
// environment paid in past blocks (they are on chain) how much of it it bids.
//
// U comes from the scenario's keyed stream, so it is reproducible and not predictable in advance.

import type { Rng, RngSnapshot } from "@eris/sdk/rng.js";

// ln(1/0.86) / 0.6 = 0.251 → Φ(0.251) = 0.599. (0.29 put it at 0.98; changed the same day.)
export const ENV_BID_MEDIAN = 0.86;
export const ENV_BID_SIGMA = 0.6;
// What a front-running swap uses on each venue: gasUsed of successful swaps in 40 runs' blocks.csv
// (agents and flow alike; PR #287 review), rounded slightly down so a leaner front-runner still pays
// about U × V. Uniswap V3 exactInputSingle ~104k (p10–p90 101k–107k), Balancer swap ~96k, Curve
// exchange ~136k (134k–142k).
export const FRONT_RUN_GAS = {
  uniswap: 100_000n,
  balancer: 95_000n,
  curve: 135_000n,
} as const;
export type FrontRunVenue = keyof typeof FRONT_RUN_GAS;

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

export type EnvBidContext = {
  bidder: EnvBidder;
  // USD per ETH, to turn V into wei.
  ethUsd: number;
};

export type EnvBid = {
  priorityFeeWei: bigint;
  u: number;
  valueUsd: number;
  // True when the sender's balance, not U × V, set the fee.
  balanceCapped: boolean;
};

export class EnvBidder {
  constructor(
    private readonly rng: Rng,
    private readonly floorWei: bigint,
  ) {}

  // The stream's position, for a practice period's checkpoint (periodResume.ts): a resumed period
  // continues the draws instead of repeating them from the start.
  snapshot(): RngSnapshot {
    return this.rng.snapshot();
  }

  // `balanceWei` bounds the fee so the transaction stays affordable: the node checks the gas *limit*
  // times the fee against the balance and refuses what the sender cannot cover, which would delay the
  // event rather than price it. Half the balance, so the next block's transaction is affordable too.
  bid(input: {
    valueUsd: number;
    // The gas of the swap that would get ahead of this one (FRONT_RUN_GAS): what the fee is per.
    frontRunGas: bigint;
    // This transaction's gas limit: only for the affordability cap.
    gasLimit: bigint;
    ethUsd: number;
    balanceWei?: bigint;
  }): EnvBid {
    const u = ENV_BID_MEDIAN * Math.exp(ENV_BID_SIGMA * this.rng.gaussian());
    const valueUsd = Number.isFinite(input.valueUsd) ? Math.max(0, input.valueUsd) : 0;
    let fee = this.floorWei;
    if (valueUsd > 0 && input.ethUsd > 0 && input.frontRunGas > 0n) {
      const totalWei = BigInt(Math.floor(((u * valueUsd) / input.ethUsd) * 1e18));
      const perGas = totalWei / input.frontRunGas;
      if (perGas > fee) fee = perGas;
    }
    let balanceCapped = false;
    if (input.balanceWei !== undefined && input.gasLimit > 0n) {
      const cap = input.balanceWei / 2n / input.gasLimit;
      if (fee > cap) {
        fee = cap > this.floorWei ? cap : this.floorWei;
        balanceCapped = true;
      }
    }
    return { priorityFeeWei: fee, u, valueUsd, balanceCapped };
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
