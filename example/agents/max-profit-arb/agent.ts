/**
 * max-profit-arb: a profit-maximizing multi-asset cross-venue arbitrage agent.
 *
 * Combines the two already-proven pieces in this repo instead of inventing a new mechanism:
 *   - multi-arb's opportunity selection: scan every active base (WETH/WBTC/...) x every AMM venue,
 *     prefer a 2-leg delta-neutral bundle (buy cheap + sell rich) when the round-trip spread clears
 *     both venues' fees, and fall back to a single-leg pull-toward-fair otherwise. Both are sized
 *     proportional to net-of-fee edge (bigger edge -> bigger size, within caps).
 *   - adaptive-arb's bidding: among all opportunities considered, the one actually picked is the one
 *     with the largest expected USDC profit (not just the largest raw gap/spread), and the priority
 *     fee bid is the minimum needed to beat the observed top competitor bid (obs.competition),
 *     capped so a bid never eats more than CEIL_FRACTION of that expected profit.
 *
 * Env vars:
 *   PROFIT_MAX_CEIL_FRACTION  fraction of expected profit allocated to the bid ceiling (default 0.8)
 */
import type { AgentAction, AgentContext, AgentObservation } from "@eris/sdk";
import { marketViews, type MarketView } from "../lib/markets.js";

const SAFETY_MARGIN_BPS = 50;
const MIN_SIZE_BPS = 250;
const MAX_SIZE_BPS = 2500;
const SPREAD_GAIN = 200_000;
const GAP_GAIN = 200_000;
const LEG_SLIPPAGE_BPS = 120;
const SINGLE_SLIPPAGE_BPS = 75;
const GAS_UNITS_ESTIMATE = 180_000n;
const CEIL_FRACTION = Number(process.env.PROFIT_MAX_CEIL_FRACTION ?? "0.8");
const ONE_GWEI = 1_000_000_000n;

if (!Number.isFinite(CEIL_FRACTION) || CEIL_FRACTION <= 0) {
  process.stderr.write(
    `invalid PROFIT_MAX_CEIL_FRACTION: ${process.env.PROFIT_MAX_CEIL_FRACTION}\n`,
  );
  process.exit(1);
}

function minBI(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
function baseToFloat(amountBaseWei: bigint, decimals: number): number {
  return Number(amountBaseWei) / 10 ** decimals;
}
function floatToBase(amount: number, decimals: number): bigint {
  return BigInt(Math.max(0, Math.floor(amount * 10 ** decimals)));
}

// Priority-fee ceiling implied by an expected profit: the most we're willing to bid per gas unit
// without giving away more than CEIL_FRACTION of the trade's edge. gasUnits should be 2x the
// per-tx estimate for a 2-leg bundle (the bid applies to both legs).
function profitCeilingPerGas(
  profitUsdc: number,
  fair: number,
  gasUnits: bigint,
): bigint {
  const profitWei =
    BigInt(Math.max(0, Math.floor((profitUsdc / fair) * 1e9))) * ONE_GWEI;
  const ceilNum = BigInt(Math.max(0, Math.floor(CEIL_FRACTION * 10_000)));
  return (profitWei * ceilNum) / 10_000n / gasUnits;
}

// Minimum priority fee needed to beat the top competitor (obs.competition), never bidding away more
// than the profit ceiling. Returns null when even the environment's floor bid would already exceed
// the ceiling (the edge is too thin to justify trading at all — better to noop than pay to lose).
function adaptiveBid(
  obs: AgentObservation,
  ceilingPerGas: bigint,
): bigint | null {
  const minBid = BigInt(obs.limits.defaultPriorityFeePerGasWei);
  const maxBid = BigInt(obs.limits.maxPriorityFeePerGasWei);
  if (ceilingPerGas < minBid) return null;

  const comp = obs.competition;
  const competitorMax = BigInt(comp?.maxCompetitorPriorityFeeWei ?? "0");
  const revertRate = comp?.recentRevertRate ?? 0;
  // 20% margin normally, 60% when recently front-run a lot (revert rate > 40%). The margin floor is
  // the environment's own default fee (not an absolute gwei constant) so "no observed competition"
  // reduces to bidding the floor instead of unconditionally overpaying by a fixed amount.
  const marginFrac = revertRate > 0.4 ? 60n : 20n;
  const margin =
    (competitorMax * marginFrac) / 100n > minBid
      ? (competitorMax * marginFrac) / 100n
      : minBid;
  let bid = competitorMax + margin;
  if (bid > ceilingPerGas) bid = ceilingPerGas; // never bid away the edge
  if (bid < minBid) bid = minBid;
  if (bid > maxBid) bid = maxBid;
  return bid;
}

type TwoLeg = {
  base: string;
  spread: number;
  cheap: MarketView["venues"][number];
  rich: MarketView["venues"][number];
  usdcIn: bigint;
  baseSell: bigint;
  profitUsdc: number;
};

type SingleLeg = {
  base: string;
  venue: MarketView["venues"][number];
  gapAbs: number;
  tokenIn: string;
  amountIn: bigint;
  profitUsdc: number;
};

export function decide(
  obs: AgentObservation,
  ctx: AgentContext,
): AgentAction | Record<string, unknown> | null {
  const round = obs.round;
  const signals: Record<string, number> = {};
  const noop = (reason: string): AgentAction => {
    const action: AgentAction = { type: "noop", reason };
    ctx.log({ round, action, signals });
    return action;
  };

  const fair = obs.fairPriceUsdcPerWeth;
  if (!Number.isFinite(fair) || fair <= 0) return noop("invalid fair");

  const views = marketViews(obs);
  const usdcBal = BigInt(obs.balances.usdcUnits || "0");
  const maxUsdc = BigInt(obs.limits.maxUsdcInUnits);
  const maxWeth = BigInt(obs.limits.maxWethInWei);

  // ---- 1) 2-leg cross-venue arbitrage (delta-neutral; ranked by expected USDC profit) ----
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
    if (spread <= roundtripCost) continue;

    const usdcCap = minBI(usdcBal, maxUsdc);
    if (usdcCap <= 0n) continue;
    const netEdge = spread - roundtripCost;
    const sizeBps = Math.min(
      MAX_SIZE_BPS,
      Math.max(MIN_SIZE_BPS, Math.floor(netEdge * SPREAD_GAIN)),
    );
    const usdcIn = (usdcCap * BigInt(sizeBps)) / 10000n;
    if (usdcIn <= 0n) continue;
    // Net against any base already sitting in the wallet (leftover from a prior round's rounding),
    // instead of only the freshly-bought estimate, so residual inventory is actively drained rather
    // than left to compound into unpriced directional exposure over many rounds.
    const existingBase = baseToFloat(
      BigInt(view.baseBalanceWei || "0"),
      view.baseDecimals,
    );
    const boughtBase = baseToFloat(usdcIn, 6) / cheap.price;
    let baseSell = floatToBase(
      existingBase + boughtBase * 0.98,
      view.baseDecimals,
    );
    const maxBaseIn = BigInt(view.maxSwapInBaseWei || "0");
    if (maxBaseIn > 0n) baseSell = minBI(baseSell, maxBaseIn);
    if (baseSell <= 0n) continue;

    const profitUsdc = baseToFloat(usdcIn, 6) * netEdge;
    // A bundle is 2 separate transactions sharing one bid, so the gas cost the bid ceiling must
    // clear is ~2x a single-leg trade's.
    const ceiling = profitCeilingPerGas(profitUsdc, fair, 2n * GAS_UNITS_ESTIMATE);
    if (ceiling < BigInt(obs.limits.defaultPriorityFeePerGasWei)) continue;
    if (!bestTwo || profitUsdc > bestTwo.profitUsdc)
      bestTwo = { base: view.base, spread, cheap, rich, usdcIn, baseSell, profitUsdc };
  }

  if (bestTwo) {
    const ceiling = profitCeilingPerGas(
      bestTwo.profitUsdc,
      fair,
      2n * GAS_UNITS_ESTIMATE,
    );
    const bid = adaptiveBid(obs, ceiling);
    if (bid !== null) {
      signals.mode = 2;
      signals.spreadBps = bestTwo.spread * 10_000;
      signals.bidGwei = Number(bid) / 1e9;
      const withBase = (a: Record<string, unknown>): Record<string, unknown> =>
        bestTwo!.base === "WETH" ? a : { ...a, base: bestTwo!.base };
      const action = {
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
        maxPriorityFeePerGasWei: bid.toString(),
      };
      ctx.log({ round, action, signals, expectedPnlUsdc: bestTwo.profitUsdc });
      return action;
    }
  }

  // ---- 2) single-leg fallback (pull the most-profitable (base, venue) deviation back toward fair) ----
  let bestOne: SingleLeg | null = null;
  for (const view of views) {
    for (const venue of view.venues) {
      const gap = view.fair / venue.price - 1;
      const gapAbs = Math.abs(gap);
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

      const netEdge = gapAbs - singleLegCost;
      const sizeBps = Math.min(
        MAX_SIZE_BPS,
        Math.max(MIN_SIZE_BPS, Math.floor(netEdge * GAP_GAIN)),
      );
      const amountIn = (cap * BigInt(sizeBps)) / 10000n;
      if (amountIn <= 0n) continue;

      const sizeUsdc =
        tokenIn === "USDC"
          ? baseToFloat(amountIn, 6)
          : baseToFloat(amountIn, view.baseDecimals) * venue.price;
      const profitUsdc = sizeUsdc * netEdge;
      const ceiling = profitCeilingPerGas(profitUsdc, fair, GAS_UNITS_ESTIMATE);
      if (ceiling < BigInt(obs.limits.defaultPriorityFeePerGasWei)) continue;
      if (!bestOne || profitUsdc > bestOne.profitUsdc)
        bestOne = { base: view.base, venue, gapAbs, tokenIn, amountIn, profitUsdc };
    }
  }

  if (!bestOne) return noop("no profitable opportunity");

  const ceiling = profitCeilingPerGas(bestOne.profitUsdc, fair, GAS_UNITS_ESTIMATE);
  const bid = adaptiveBid(obs, ceiling);
  if (bid === null) return noop("edge too thin to cover the floor bid");
  signals.mode = 1;
  signals.gapBps = bestOne.gapAbs * 10_000;
  signals.bidGwei = Number(bid) / 1e9;
  const action: Record<string, unknown> = {
    type: bestOne.venue.swapType,
    tokenIn: bestOne.tokenIn,
    amountIn: bestOne.amountIn.toString(),
    maxPriorityFeePerGasWei: bid.toString(),
    slippageBps: SINGLE_SLIPPAGE_BPS,
  };
  if (bestOne.base !== "WETH") action.base = bestOne.base;
  ctx.log({ round, action, signals, expectedPnlUsdc: bestOne.profitUsdc });
  return action;
}
