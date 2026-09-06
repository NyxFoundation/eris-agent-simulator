/**
 * stat-arb: rolling-stats driven arb agent with z-score sizing and dynamic
 *           priority fee bidding.
 *
 * Compared to arb-bot (fixed gap threshold, fixed sizing schedule):
 *   - Threshold is data-driven: enter when |z(gap)| > STAT_ARB_Z_ENTER.
 *   - Size scales with |z| (capped at 50% of per-round swap limit).
 *   - Priority fee is EV-proportional: bid ≈ alpha * EV_wei / gasEstimate,
 *     clamped to the simulator's [defaultPriorityFee, maxPriorityFee] band.
 *   - During burn-in (rolling stats not yet meaningful) emit noop. The
 *     observation's `history` field is replayed on startup so late-spawned
 *     agents don't need a fresh N rounds of cold start.
 *
 * Env vars:
 *   STAT_ARB_WINDOW         (default 64)  burn-in stats window metadata; the
 *                                          Welford estimator is unbounded, so
 *                                          this only labels the tuning window.
 *   STAT_ARB_Z_ENTER        (default 1.5) minimum |z| to take a position.
 *   STAT_ARB_Z_AGGRESSIVE   (default 2.5) |z| at which sizing saturates the
 *                                          50% cap; below this, size scales
 *                                          linearly from Z_ENTER → cap.
 *   STAT_ARB_BID_ALPHA      (default 0.3) fraction of expected EV (wei) routed
 *                                          to priority fee bidding.
 *   STAT_ARB_BURN_IN        (default 20)  minimum sample count before trading.
 */
import type { AgentAction, AgentObservation } from "@eris/sdk";
import { RollingStats } from "../lib/rolling-stats.js";
import { sized } from "../lib/affordable.js";
import { marketViews } from "../lib/markets.js";

const WINDOW = Math.max(
  2,
  Math.floor(Number(process.env.STAT_ARB_WINDOW ?? "64")),
);
const Z_ENTER = Number(process.env.STAT_ARB_Z_ENTER ?? "1.5");
const Z_AGGRESSIVE = Number(process.env.STAT_ARB_Z_AGGRESSIVE ?? "2.5");
const BID_ALPHA = Number(process.env.STAT_ARB_BID_ALPHA ?? "0.3");
const BURN_IN = Math.max(
  2,
  Math.floor(Number(process.env.STAT_ARB_BURN_IN ?? "20")),
);

const GAS_UNITS_ESTIMATE = 180_000n;
const SIZE_CAP_BPS = 5000; // 50% of per-round swap limit
const SIZE_FLOOR_BPS = 500; // 5% — when |z| barely clears Z_ENTER

if (!Number.isFinite(Z_ENTER) || Z_ENTER <= 0) {
  process.stderr.write(
    `invalid STAT_ARB_Z_ENTER: ${process.env.STAT_ARB_Z_ENTER}\n`,
  );
  process.exit(1);
}
if (!Number.isFinite(Z_AGGRESSIVE) || Z_AGGRESSIVE <= Z_ENTER) {
  process.stderr.write(
    `invalid STAT_ARB_Z_AGGRESSIVE (must be > Z_ENTER): ${process.env.STAT_ARB_Z_AGGRESSIVE}\n`,
  );
  process.exit(1);
}
if (!Number.isFinite(BID_ALPHA) || BID_ALPHA < 0) {
  process.stderr.write(
    `invalid STAT_ARB_BID_ALPHA: ${process.env.STAT_ARB_BID_ALPHA}\n`,
  );
  process.exit(1);
}

// One estimator per base. A z-score is only meaningful against the deviation history of the *same*
// market: WBTC's gap distribution is not WETH's, and pooling them would score a normal WBTC
// dislocation against WETH's variance (ADR 0013 -- the registry is multi-asset, so the statistics
// have to be too).
const statsByBase = new Map<string, RollingStats>();
const seenByBase = new Map<string, Set<number>>();

function statsFor(base: string): RollingStats {
  let s = statsByBase.get(base);
  if (!s) statsByBase.set(base, (s = new RollingStats(WINDOW)));
  return s;
}

function seenFor(base: string): Set<number> {
  let s = seenByBase.get(base);
  if (!s) seenByBase.set(base, (s = new Set<number>()));
  return s;
}

function computeGap(pool: number, fair: number): number | null {
  if (!Number.isFinite(pool) || pool <= 0) return null;
  if (!Number.isFinite(fair) || fair <= 0) return null;
  return fair / pool - 1;
}

// history carries the WETH pool and fair only, so it seeds WETH's estimator alone; the other bases
// burn in live. Better than seeding them from WETH's history, which would hand them a distribution
// that is not theirs.
function seedFromHistory(
  history: AgentObservation["history"] | undefined,
): void {
  if (!history || history.length === 0) return;
  const stats = statsFor("WETH");
  const seen = seenFor("WETH");
  for (const point of history) {
    if (seen.has(point.round)) continue;
    const gap = computeGap(
      point.poolPriceUsdcPerWeth,
      point.fairPriceUsdcPerWeth,
    );
    if (gap === null) continue;
    stats.update(gap);
    seen.add(point.round);
  }
}

function noop(reason: string): AgentAction {
  return { type: "noop", reason };
}

export function decide(obs: AgentObservation): AgentAction | null {
  const views = marketViews(obs).filter((v) => v.venues.length > 0);
  if (views.length === 0) return noop("no venue quoting any base");

  seedFromHistory(obs.history);

  // Score every active base, then take the strongest signal that can actually be funded. Scoring
  // only WETH left the WBTC markets untouched however far they drifted.
  type Candidate = {
    base: string;
    absZ: number;
    bestGap: number;
    swapType: "swap" | "balancerSwap" | "curveSwap";
    fair: number;
    decimals: number;
  };
  const candidates: Candidate[] = [];
  let burningIn = 0;

  for (const view of views) {
    // The signal is the uniswap gap where uniswap quotes this base (the venue the estimator was
    // tuned on), and the first available venue otherwise.
    const signalVenue =
      view.venues.find((v) => v.protocol === "uniswap") ?? view.venues[0];
    const gap = computeGap(signalVenue.price, view.fair);
    if (gap === null) continue;

    const stats = statsFor(view.base);
    const seen = seenFor(view.base);
    // Score against the current model BEFORE incorporating the new sample -- otherwise the latest
    // point pulls the mean toward itself and damps the signal. Then fold it in for next round.
    const z = stats.zscore(gap);
    if (!seen.has(obs.round)) {
      stats.update(gap);
      seen.add(obs.round);
    }
    if (stats.count() < BURN_IN) {
      burningIn++;
      continue;
    }
    const absZ = Math.abs(z);
    if (absZ < Z_ENTER) continue;

    // Judge the regime on the signal venue, but execute on the most deviated one.
    let best = view.venues[0];
    let bestGap = view.fair / view.venues[0].price - 1;
    for (const v of view.venues) {
      const g = view.fair / v.price - 1;
      if (Math.abs(g) > Math.abs(bestGap)) {
        bestGap = g;
        best = v;
      }
    }
    candidates.push({
      base: view.base,
      absZ,
      bestGap,
      swapType: best.swapType,
      fair: view.fair,
      decimals: view.baseDecimals,
    });
  }

  if (candidates.length === 0)
    return noop(
      burningIn > 0
        ? `burn-in (${views.map((v) => `${v.base} ${statsFor(v.base).count()}/${BURN_IN}`).join(", ")})`
        : "no base deviating far enough to trade",
    );

  candidates.sort((a, b) => b.absZ - a.absZ);

  // Try the strongest signal first and fall through to the next when the leg cannot be funded --
  // a base whose sell side is empty must not shadow one whose buy side is not.
  let skippedUnfundable = false;
  for (const c of candidates) {
    const tokenIn = c.bestGap > 0 ? "USDC" : c.base;

    // Linear ramp: SIZE_FLOOR_BPS at |z| = Z_ENTER, SIZE_CAP_BPS at |z| >= Z_AGGRESSIVE.
    const span = Math.max(0.0001, Z_AGGRESSIVE - Z_ENTER);
    const t = Math.max(0, Math.min(1, (c.absZ - Z_ENTER) / span));
    const sizeBps = Math.max(
      SIZE_FLOOR_BPS,
      Math.min(
        SIZE_CAP_BPS,
        Math.floor(SIZE_FLOOR_BPS + (SIZE_CAP_BPS - SIZE_FLOOR_BPS) * t),
      ),
    );
    // Bounded by the wallet, which is now the only bound there is: proposing an unfundable leg is a
    // self-reject, indistinguishable in the score from choosing not to trade (issue #54).
    const amountIn = sized(obs, tokenIn, sizeBps);
    if (amountIn <= 0n) {
      skippedUnfundable = true;
      continue;
    }

    // EV in USDC ~= size_usdc * |gap|. Convert to wei via the base's own fair price.
    const sizeUsdc =
      tokenIn === "USDC"
        ? Number(amountIn) / 1e6
        : (Number(amountIn) / 10 ** c.decimals) * c.fair;
    const evUsdc = sizeUsdc * Math.abs(c.bestGap);
    // The bid is denominated in the chain's own currency, so the conversion is through the WETH
    // fair price whatever base the trade is in.
    const evGwei = Math.max(
      0,
      Math.floor((evUsdc / obs.fairPriceUsdcPerWeth) * 1e9),
    );
    const evWei = BigInt(evGwei) * 1_000_000_000n;

    const alphaScale = 10_000n;
    const alphaNum = BigInt(
      Math.max(0, Math.floor(BID_ALPHA * Number(alphaScale))),
    );
    const bidPerGasWei = (evWei * alphaNum) / alphaScale / GAS_UNITS_ESTIMATE;

    const minBid = BigInt(obs.limits.defaultPriorityFeePerGasWei);
    const maxBid = BigInt(obs.limits.maxPriorityFeePerGasWei);
    const bid =
      bidPerGasWei < minBid
        ? minBid
        : bidPerGasWei > maxBid
          ? maxBid
          : bidPerGasWei;

    // `base` only belongs on a non-WETH swap (ADR 0013): the WETH market is the untagged default,
    // and the action union has no `base` on the shapes that are not swaps.
    const action: Record<string, unknown> = {
      type: c.swapType,
      tokenIn,
      amountIn: amountIn.toString(),
      maxPriorityFeePerGasWei: bid.toString(),
      slippageBps: 75,
    };
    if (c.base !== "WETH") action.base = c.base;
    return action as unknown as AgentAction;
  }

  return noop(
    skippedUnfundable
      ? "every deviating base wants a leg this wallet cannot fund"
      : "no fundable base",
  );
}
