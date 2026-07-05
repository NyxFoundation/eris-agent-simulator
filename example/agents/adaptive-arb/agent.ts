/**
 * adaptive-arb: an arb that uses competition signals (ADR 0011) to bid "the minimum needed to win, without exceeding the opportunity value".
 *
 * Difference from arb-bot: arb-bot mechanically stacks a fixed fraction of profit (BID_PROFIT_FRACTION), which can be too much or too little.
 * adaptive-arb looks at obs.competition and:
 *   - bids just slightly above the top competitor bid (maxCompetitorPriorityFeeWei) — the minimum needed to win
 *   - but never exceeds the opportunity-value ceiling (profit * CEIL_FRACTION / gas), so it can't be punished for overbidding
 *   - raises the margin when it has been front-run recently (high recentRevertRate)
 * This avoids both "bid too little -> get filled ahead of and revert" and "bid too much -> waste fees" (execution skill).
 *
 * Env vars:
 *   ADAPT_CEIL_FRACTION  fraction of the opportunity value allocated to the bid ceiling (default 0.8; the rest is kept as net profit)
 */
import type { AgentAction, AgentContext, AgentObservation } from "@eris/sdk";

const CEIL_FRACTION = Number(process.env.ADAPT_CEIL_FRACTION ?? "0.8");
const GAS_UNITS_ESTIMATE = 180_000n;
const GAP_THRESHOLD = 0.0005;
const SIZE_BPS_MIN = 250;
const SIZE_BPS_MAX = 5000;
const ONE_GWEI = 1_000_000_000n;

if (!Number.isFinite(CEIL_FRACTION) || CEIL_FRACTION <= 0) {
  process.stderr.write(
    `invalid ADAPT_CEIL_FRACTION: ${process.env.ADAPT_CEIL_FRACTION}\n`,
  );
  process.exit(1);
}

export function decide(
  obs: AgentObservation,
  ctx: AgentContext,
): AgentAction | null {
  const round = obs.round;
  const signals: Record<string, number> = {};
  const noop = (reason: string): AgentAction => {
    const action: AgentAction = { type: "noop", reason };
    ctx.log({ round, action, signals });
    return action;
  };
  const fair = obs.fairPriceUsdcPerWeth;
  if (!Number.isFinite(fair) || fair <= 0) return noop("invalid fair");
  // Pick the venue with the largest deviation among the 3 venues (same opportunity selection as arb-bot).
  const venues: Array<{
    swapType: "swap" | "balancerSwap" | "curveSwap";
    price: number;
  }> = [];
  const uni = obs.protocols?.uniswap?.pool?.priceUsdcPerWeth;
  if (Number.isFinite(uni) && (uni ?? 0) > 0)
    venues.push({ swapType: "swap", price: uni as number });
  const bal = obs.protocols?.balancer?.priceUsdcPerWeth;
  if (Number.isFinite(bal) && (bal ?? 0) > 0)
    venues.push({ swapType: "balancerSwap", price: bal as number });
  const curve = obs.protocols?.curve?.priceUsdcPerWeth;
  if (Number.isFinite(curve) && (curve ?? 0) > 0)
    venues.push({ swapType: "curveSwap", price: curve as number });
  if (venues.length === 0) return noop("no venue");
  let best = venues[0];
  let gap = fair / venues[0].price - 1;
  for (const v of venues) {
    const g = fair / v.price - 1;
    if (Math.abs(g) > Math.abs(gap)) {
      gap = g;
      best = v;
    }
  }
  signals.gapBps = gap * 10_000;
  if (Math.abs(gap) < GAP_THRESHOLD) return noop("gap too small");

  const tokenIn = gap > 0 ? "USDC" : "WETH";
  const max = BigInt(
    tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits,
  );
  const sizeBps = Math.min(
    SIZE_BPS_MAX,
    Math.max(SIZE_BPS_MIN, Math.floor(Math.abs(gap) * 200_000)),
  );
  const amountIn = (max * BigInt(sizeBps)) / 10_000n;

  // Opportunity value ceiling (per gas) = profit * CEIL_FRACTION / gas. Bidding above this eats into net.
  const sizeUsdc =
    tokenIn === "USDC"
      ? Number(amountIn) / 1e6
      : (Number(amountIn) / 1e18) * fair;
  const profitUsdc = sizeUsdc * Math.abs(gap);
  const profitWei =
    BigInt(Math.max(0, Math.floor((profitUsdc / fair) * 1e9))) * ONE_GWEI;
  const ceilNum = BigInt(Math.max(0, Math.floor(CEIL_FRACTION * 10_000)));
  const ceilingPerGas = (profitWei * ceilNum) / 10_000n / GAS_UNITS_ESTIMATE;

  // Competition signal: bid just slightly above the top competitor (the minimum needed to win). Raise margin if being front-run.
  const comp = obs.competition;
  const competitorMax = BigInt(comp?.maxCompetitorPriorityFeeWei ?? "0");
  const revertRate = comp?.recentRevertRate ?? 0;
  signals.competitorMaxGwei = Number(competitorMax / ONE_GWEI);
  signals.revertRate = revertRate;
  signals.lastTxIndex = comp?.lastTxIndex ?? -1;
  // margin: 20% normally, 60% when front-running is frequent (revert>0.4) to reliably get ahead. Minimum 1 gwei.
  const marginFrac = revertRate > 0.4 ? 60n : 20n;
  const margin =
    (competitorMax * marginFrac) / 100n > ONE_GWEI
      ? (competitorMax * marginFrac) / 100n
      : ONE_GWEI;
  let bid = competitorMax + margin;
  // Cap at the opportunity-value ceiling (avoid overbidding).
  if (bid > ceilingPerGas) bid = ceilingPerGas;
  // clamp to floor/ceiling.
  const minBid = BigInt(obs.limits.defaultPriorityFeePerGasWei);
  const maxBid = BigInt(obs.limits.maxPriorityFeePerGasWei);
  if (bid < minBid) bid = minBid;
  if (bid > maxBid) bid = maxBid;

  signals.bidGwei = Number(bid / ONE_GWEI);
  signals.ceilingGwei = Number(ceilingPerGas / ONE_GWEI);
  const action: AgentAction = {
    type: best.swapType,
    tokenIn,
    amountIn: amountIn.toString(),
    maxPriorityFeePerGasWei: bid.toString(),
    slippageBps: 75,
  };
  ctx.log({ round, action, signals });
  return action;
}
