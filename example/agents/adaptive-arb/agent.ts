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
import { sized } from "../lib/affordable.js";
import { marketViews } from "../lib/markets.js";

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
  // Every active base, not just WETH (ADR 0013): the widest gap this round may be in the WBTC
  // market, and scanning only WETH left it untouched however far it drifted.
  const ranked = marketViews(obs)
    .flatMap((view) =>
      view.venues.map((v) => ({
        base: view.base,
        decimals: view.baseDecimals,
        swapType: v.swapType,
        price: v.price,
        gap: view.fair / v.price - 1,
      })),
    )
    .filter((c) => Number.isFinite(c.gap))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  if (ranked.length === 0) return noop("no venue");

  const sizeFor = (g: number): number =>
    Math.min(
      SIZE_BPS_MAX,
      Math.max(SIZE_BPS_MIN, Math.floor(Math.abs(g) * 200_000)),
    );

  signals.gapBps = ranked[0].gap * 10_000;
  if (Math.abs(ranked[0].gap) < GAP_THRESHOLD) return noop("gap too small");

  let chosen: {
    venue: (typeof ranked)[number];
    gap: number;
    tokenIn: string;
    amountIn: bigint;
  } | null = null;
  let skippedUnfundable = false;
  for (const candidate of ranked) {
    if (Math.abs(candidate.gap) < GAP_THRESHOLD) break;
    const token = candidate.gap > 0 ? "USDC" : candidate.base;
    // A fraction of the wallet. Proposing an unfundable leg is a self-reject that reads in the
    // score exactly like choosing not to trade (issue #54), and with no rule cap left the wallet is
    // the only thing that bounds the order anyway.
    const amount = sized(obs, token, sizeFor(candidate.gap));
    if (amount === 0n) {
      skippedUnfundable = true;
      continue;
    }
    chosen = { venue: candidate, gap: candidate.gap, tokenIn: token, amountIn: amount };
    break;
  }
  if (chosen === null)
    return noop(
      skippedUnfundable
        ? "every venue with a gap wants a leg this wallet cannot fund"
        : "no fundable gap",
    );

  const best = chosen.venue;
  const gap = chosen.gap;
  const tokenIn = chosen.tokenIn;
  const sizeBps = sizeFor(gap);
  const amountIn = chosen.amountIn;
  signals.gapBps = gap * 10_000;

  // Opportunity value ceiling (per gas) = profit * CEIL_FRACTION / gas. Bidding above this eats into net.
  // The leg's USD size uses the *base's* own decimals and fair: a WBTC leg priced off the WETH
  // fair with 18 decimals would be wrong by ten orders of magnitude.
  const sizeUsdc =
    tokenIn === "USDC"
      ? Number(amountIn) / 1e6
      : (Number(amountIn) / 10 ** best.decimals) *
        (marketViews(obs).find((v) => v.base === best.base)?.fair ?? fair);
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
  // `base` only belongs on a non-WETH swap (ADR 0013): the WETH market is the untagged default.
  const built: Record<string, unknown> = {
    type: best.swapType,
    tokenIn,
    amountIn: amountIn.toString(),
    maxPriorityFeePerGasWei: bid.toString(),
    slippageBps: 75,
  };
  if (best.base !== "WETH") built.base = best.base;
  const action = built as unknown as AgentAction;
  ctx.log({ round, action, signals, reason: `${best.base} gap ${(gap * 10_000).toFixed(1)}bps on ${best.swapType}` });
  return action;
}
