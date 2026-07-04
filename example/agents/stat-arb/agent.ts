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

const stats = new RollingStats(WINDOW);
const seenRounds = new Set<number>();

function computeGap(pool: number, fair: number): number | null {
  if (!Number.isFinite(pool) || pool <= 0) return null;
  if (!Number.isFinite(fair) || fair <= 0) return null;
  return fair / pool - 1;
}

function seedFromHistory(
  history: AgentObservation["history"] | undefined,
): void {
  if (!history || history.length === 0) return;
  for (const point of history) {
    if (seenRounds.has(point.round)) continue;
    const gap = computeGap(
      point.poolPriceUsdcPerWeth,
      point.fairPriceUsdcPerWeth,
    );
    if (gap === null) continue;
    stats.update(gap);
    seenRounds.add(point.round);
  }
}

function noop(reason: string): AgentAction {
  return { type: "noop", reason };
}

export function decide(obs: AgentObservation): AgentAction | null {
  // 観測はネスト形 (protocols.uniswap.pool)。本戦略はトップレベル pool を前提にした
  // フラット形を使うため、uniswap 無効時は裁定できず noop。
  const uniPool = obs.protocols?.uniswap?.pool;
  if (!uniPool) return noop("uniswap pool unavailable");

  seedFromHistory(obs.history);

  const pool = uniPool.priceUsdcPerWeth;
  const fair = obs.fairPriceUsdcPerWeth;
  const gap = computeGap(pool, fair);
  if (gap === null) return noop("invalid prices");

  // Score against the current model BEFORE incorporating the new sample —
  // otherwise the latest point pulls the mean toward itself and damps the
  // signal. Then fold it in for next round.
  const z = stats.zscore(gap);
  stats.update(gap);
  seenRounds.add(obs.round);

  if (stats.count() < BURN_IN) {
    return noop(`burn-in (${stats.count()}/${BURN_IN})`);
  }

  const absZ = Math.abs(z);
  if (absZ < Z_ENTER) {
    return noop(`|z|=${absZ.toFixed(2)} < ${Z_ENTER}`);
  }

  // z は uniswap gap = 「動いている regime か」の判定に使い、執行は 3 venue の最大乖離 venue を選ぶ。
  const venues: Array<{
    swapType: "swap" | "balancerSwap" | "curveSwap";
    price: number;
  }> = [{ swapType: "swap", price: pool }];
  const balP = obs.protocols?.balancer?.priceUsdcPerWeth;
  if (Number.isFinite(balP) && (balP ?? 0) > 0)
    venues.push({ swapType: "balancerSwap", price: balP as number });
  const curveP = obs.protocols?.curve?.priceUsdcPerWeth;
  if (Number.isFinite(curveP) && (curveP ?? 0) > 0)
    venues.push({ swapType: "curveSwap", price: curveP as number });
  let best = venues[0];
  let bestGap = fair / venues[0].price - 1;
  for (const v of venues) {
    const g = fair / v.price - 1;
    if (Math.abs(g) > Math.abs(bestGap)) {
      bestGap = g;
      best = v;
    }
  }

  const tokenIn: "WETH" | "USDC" = bestGap > 0 ? "USDC" : "WETH";
  const max = BigInt(
    tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits,
  );

  // Linear ramp: SIZE_FLOOR_BPS at |z| = Z_ENTER, SIZE_CAP_BPS at |z| >= Z_AGGRESSIVE.
  const span = Math.max(0.0001, Z_AGGRESSIVE - Z_ENTER);
  const t = Math.max(0, Math.min(1, (absZ - Z_ENTER) / span));
  const sizeBps = Math.max(
    SIZE_FLOOR_BPS,
    Math.min(
      SIZE_CAP_BPS,
      Math.floor(SIZE_FLOOR_BPS + (SIZE_CAP_BPS - SIZE_FLOOR_BPS) * t),
    ),
  );
  const amountIn = (max * BigInt(sizeBps)) / 10_000n;

  if (amountIn <= 0n) {
    return noop("size rounds to zero");
  }

  // EV in USDC ≈ size_usdc * |gap|. Convert to wei via fair price.
  const sizeUsdc =
    tokenIn === "USDC"
      ? Number(amountIn) / 1e6
      : (Number(amountIn) / 1e18) * fair;
  const evUsdc = sizeUsdc * Math.abs(bestGap);
  const evGwei = Math.max(0, Math.floor((evUsdc / fair) * 1e9));
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

  return {
    type: best.swapType,
    tokenIn,
    amountIn: amountIn.toString(),
    maxPriorityFeePerGasWei: bid.toString(),
    slippageBps: 75,
  };
}
