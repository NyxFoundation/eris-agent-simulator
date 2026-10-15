/**
 * noah: submission entry. Three layers, tried in order, each gated by what the last two years
 * of reference agents in this repo learned the hard way.
 *
 *   1. 2-leg delta-neutral arbitrage (multi-arb / max-profit-arb's opportunity scan, base-agnostic
 *      via marketViews()). Buy the cheapest venue, sell the richest, same bundle, only when the
 *      spread clears both venues' fees plus a safety margin. Carries no directional beta -- this is
 *      the "does not lose big" foundation (competition-strategy.md §3.6: clean-arb's discipline
 *      measured 0 systematic loss where multi-arb's single-leg fallback lost -1,650 USDC on a WBTC
 *      injection event in a 60-block calm regime).
 *   2. Single-leg fallback, taken only when (1) found nothing. Gated by BOTH a fee-aware threshold
 *      AND a z-score confirmation (stat-arb's RollingStats, per base): a raw gap above the fee band
 *      is not enough on its own -- multi-arb's fallback fired on exactly that and lost systematically
 *      on WBTC. Requiring the gap to also be statistically unusual for *that* base's own recent
 *      distribution is the fix.
 *   3. Adaptive priority-fee bidding (adaptive-arb / max-profit-arb): bid the minimum needed to beat
 *      the observed top competitor, never more than a fraction of the trade's own expected profit.
 *
 * Among candidates within a layer, the one with the largest *expected USDC profit* wins (not the
 * largest raw gap/spread) -- profit is the closer proxy for what the scorer actually measures (P =
 * V_K - V_0), which is max-profit-arb's departure from multi-arb.
 *
 * Every branch, including noop, calls ctx.log with a reason and signals (issue #101: 351 consecutive
 * unexplained noops is what "not logging why" looks like from the outside). Every leg is sized
 * through lib/affordable.ts's canFund/sized, which is the one thing this file never skips (issue
 * #54: an unfunded leg self-rejects and scores identically to a strategy that chose not to trade --
 * silently, which is the worst way to be broken).
 *
 * Out of scope for v1 (see plan): GMX perps, Aave borrow/liquidation, LST/Liquity. Reasons are
 * mechanical, not laziness -- GMX cannot be compiled locally on this box's arm64 (spot EC2 only),
 * lst/liquity are absent from obs.protocols unless ENABLED_PROTOCOLS names them (a self-hosted-agent
 * trap this repo's own docs warn about), and liquidating other participants' positions is a run(ctx)
 * agent shape that cannot coexist with prompt.md (kind: improve) in one submission. A run that never
 * touches those venues just noops through the regimes that need them, which is not a disqualifying
 * outcome -- it is what "not attempted" looks like in this scoring model.
 *
 * JP: 3層構成。①2レグdelta-neutral裁定（方向性リスクゼロ、最優先）②z-score確認付きの単発
 * フォールバック（①が無いときだけ。素の乖離幅だけでなく「そのbase自身の直近分布から見て
 * 異常か」も要求することで、multi-arbが単発フォールバックでWBTC投入時に出した実測-1,650 USDCの
 * 再現を防ぐ）③adaptive-arb/max-profit-arb由来の適応入札。候補選択は「乖離幅最大」ではなく
 * 「期待USDC利益最大」（採点対象=Pに近い代理指標）。資金チェック（canFund/sized）とログ
 * （ctx.log、noopでも理由付き）は全分岐で必須。v1はAMM裁定のみでGMX/Aave/LST/Liquityは
 * 対象外（理由は上のコメント参照）。
 */
import type { AgentAction, AgentContext, AgentObservation } from "@eris/sdk";
import { sized } from "../lib/affordable.js";
import { marketViews, type MarketView } from "../lib/markets.js";
import { RollingStats } from "../lib/rolling-stats.js";

// ---- layer 1: 2-leg delta-neutral arbitrage ----
const SAFETY_MARGIN_BPS = Number(process.env.NOAH_SAFETY_MARGIN_BPS ?? "50");
const MIN_SIZE_BPS = 250;
const MAX_SIZE_BPS = 2500; // 25% of the relevant balance at the largest edge
const SPREAD_GAIN = 200_000; // linear gain from net edge -> size
const LEG_SLIPPAGE_BPS = 120;

// ---- layer 2: z-score-gated single-leg fallback (deliberately more conservative than layer 1) ----
const SINGLE_SAFETY_MARGIN_BPS = Number(
  process.env.NOAH_SINGLE_SAFETY_MARGIN_BPS ?? "60",
);
const SINGLE_MIN_SIZE_BPS = 100;
const SINGLE_MAX_SIZE_BPS = 1000; // 10% cap, vs layer 1's 25% -- this leg carries directional risk
const SINGLE_SLIPPAGE_BPS = 75;
const Z_ENTER = Number(process.env.NOAH_Z_ENTER ?? "1.5");
const Z_AGGRESSIVE = Number(process.env.NOAH_Z_AGGRESSIVE ?? "2.5");
const BURN_IN = Math.max(
  2,
  Math.floor(Number(process.env.NOAH_BURN_IN ?? "20")),
);
const STATS_WINDOW = Math.max(
  2,
  Math.floor(Number(process.env.NOAH_STATS_WINDOW ?? "64")),
);

// ---- layer 3: adaptive priority-fee bidding ----
const GAS_UNITS_ESTIMATE = 180_000n;
const CEIL_FRACTION = Number(process.env.NOAH_CEIL_FRACTION ?? "0.8");
const ONE_GWEI = 1_000_000_000n;

if (!Number.isFinite(SAFETY_MARGIN_BPS) || SAFETY_MARGIN_BPS < 0) {
  process.stderr.write(
    `invalid NOAH_SAFETY_MARGIN_BPS: ${process.env.NOAH_SAFETY_MARGIN_BPS}\n`,
  );
  process.exit(1);
}
if (
  !Number.isFinite(SINGLE_SAFETY_MARGIN_BPS) ||
  SINGLE_SAFETY_MARGIN_BPS < 0
) {
  process.stderr.write(
    `invalid NOAH_SINGLE_SAFETY_MARGIN_BPS: ${process.env.NOAH_SINGLE_SAFETY_MARGIN_BPS}\n`,
  );
  process.exit(1);
}
if (!Number.isFinite(Z_ENTER) || Z_ENTER <= 0) {
  process.stderr.write(`invalid NOAH_Z_ENTER: ${process.env.NOAH_Z_ENTER}\n`);
  process.exit(1);
}
if (!Number.isFinite(Z_AGGRESSIVE) || Z_AGGRESSIVE <= Z_ENTER) {
  process.stderr.write(
    `invalid NOAH_Z_AGGRESSIVE (must be > NOAH_Z_ENTER): ${process.env.NOAH_Z_AGGRESSIVE}\n`,
  );
  process.exit(1);
}
if (!Number.isFinite(CEIL_FRACTION) || CEIL_FRACTION <= 0) {
  process.stderr.write(
    `invalid NOAH_CEIL_FRACTION: ${process.env.NOAH_CEIL_FRACTION}\n`,
  );
  process.exit(1);
}

function baseToFloat(amountBaseWei: bigint, decimals: number): number {
  return Number(amountBaseWei) / 10 ** decimals;
}
function floatToBase(amount: number, decimals: number): bigint {
  return BigInt(Math.max(0, Math.floor(amount * 10 ** decimals)));
}

// Priority-fee ceiling implied by an expected profit: never bid away more than CEIL_FRACTION of the
// trade's own edge. gasUnits should be 2x the per-tx estimate for a 2-leg bundle (the bid applies to
// both legs at once).
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

// Minimum bid needed to beat the observed top competitor, capped at the profit ceiling. Null means
// even the environment's floor bid would already exceed the ceiling -- the edge is too thin to pay
// gas for, so the caller should noop rather than trade at a loss on fees alone.
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
  const marginFrac = revertRate > 0.4 ? 60n : 20n;
  const margin =
    (competitorMax * marginFrac) / 100n > minBid
      ? (competitorMax * marginFrac) / 100n
      : minBid;
  let bid = competitorMax + margin;
  if (bid > ceilingPerGas) bid = ceilingPerGas;
  if (bid < minBid) bid = minBid;
  if (bid > maxBid) bid = maxBid;
  return bid;
}

function computeGap(price: number, fair: number): number | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(fair) || fair <= 0) return null;
  return fair / price - 1;
}

// One estimator per base (ADR 0013): WBTC's gap distribution is not WETH's, and pooling them would
// score a normal WBTC dislocation against WETH's variance.
const statsByBase = new Map<string, RollingStats>();
const seenByBase = new Map<string, Set<number>>();

function statsFor(base: string): RollingStats {
  let s = statsByBase.get(base);
  if (!s) statsByBase.set(base, (s = new RollingStats(STATS_WINDOW)));
  return s;
}
function seenFor(base: string): Set<number> {
  let s = seenByBase.get(base);
  if (!s) seenByBase.set(base, (s = new Set<number>()));
  return s;
}

// history carries only the WETH pool/fair pair, so only WETH's estimator can be warm-started from
// it; other bases burn in live.
function seedFromHistory(history: AgentObservation["history"] | undefined): void {
  if (!history || history.length === 0) return;
  const stats = statsFor("WETH");
  const seen = seenFor("WETH");
  for (const point of history) {
    if (seen.has(point.round)) continue;
    const gap = computeGap(point.poolPriceUsdcPerWeth, point.fairPriceUsdcPerWeth);
    if (gap === null) continue;
    stats.update(gap);
    seen.add(point.round);
  }
}

// Score against the model BEFORE folding the new sample in -- otherwise the latest point pulls the
// mean toward itself and damps its own signal.
function zscoreAndUpdate(base: string, round: number, gap: number): number {
  const stats = statsFor(base);
  const seen = seenFor(base);
  const z = stats.zscore(gap);
  if (!seen.has(round)) {
    stats.update(gap);
    seen.add(round);
  }
  return z;
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

type OneLeg = {
  base: string;
  venue: MarketView["venues"][number];
  gapAbs: number;
  absZ: number;
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
    ctx.log({ round, action, reason, signals });
    return action;
  };

  const fair = obs.fairPriceUsdcPerWeth;
  if (!Number.isFinite(fair) || fair <= 0) return noop("invalid fair price");

  const views = marketViews(obs);
  if (views.length === 0) return noop("no venue quoting any base");

  seedFromHistory(obs.history);
  const usdcBal = BigInt(obs.balances.usdcUnits || "0");

  // ---- update every base's z-score bookkeeping this round, regardless of what fires below ----
  // (keeps layer 2's statistics warm even on rounds where layer 1 trades instead.)
  const gapInfo = new Map<string, { gap: number; absZ: number; burnedIn: boolean }>();
  for (const view of views) {
    const signalVenue =
      view.venues.find((v) => v.protocol === "uniswap") ?? view.venues[0];
    if (!signalVenue) continue;
    const gap = computeGap(signalVenue.price, view.fair);
    if (gap === null) continue;
    const z = zscoreAndUpdate(view.base, round, gap);
    gapInfo.set(view.base, {
      gap,
      absZ: Math.abs(z),
      burnedIn: statsFor(view.base).count() >= BURN_IN,
    });
  }

  // ---- layer 1: 2-leg delta-neutral, ranked by expected USDC profit ----
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
    const roundtripCost = (cheap.feeBps + rich.feeBps + SAFETY_MARGIN_BPS) / 10000;
    if (spread <= roundtripCost) continue;
    if (usdcBal <= 0n) continue;

    const netEdge = spread - roundtripCost;
    const sizeBps = Math.min(
      MAX_SIZE_BPS,
      Math.max(MIN_SIZE_BPS, Math.floor(netEdge * SPREAD_GAIN)),
    );
    const usdcIn = sized(obs, "USDC", sizeBps);
    if (usdcIn <= 0n) continue;

    // Net against any base already sitting in the wallet, not just the freshly bought amount, so
    // leftover rounding inventory is actively drained instead of compounding into unpriced beta.
    const existingBase = baseToFloat(BigInt(view.baseBalanceWei || "0"), view.baseDecimals);
    const boughtBase = baseToFloat(usdcIn, 6) / cheap.price;
    const baseSell = floatToBase(existingBase + boughtBase * 0.98, view.baseDecimals);
    if (baseSell <= 0n) continue;

    const profitUsdc = baseToFloat(usdcIn, 6) * netEdge;
    if (!bestTwo || profitUsdc > bestTwo.profitUsdc)
      bestTwo = { base: view.base, spread, cheap, rich, usdcIn, baseSell, profitUsdc };
  }

  if (bestTwo) {
    const ceiling = profitCeilingPerGas(bestTwo.profitUsdc, fair, 2n * GAS_UNITS_ESTIMATE);
    const bid = adaptiveBid(obs, ceiling);
    if (bid !== null) {
      signals.layer = 1;
      signals.spreadBps = bestTwo.spread * 10_000;
      signals.profitUsdc = bestTwo.profitUsdc;
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
      ctx.log({
        round,
        action,
        signals,
        reason: `${bestTwo.base} 2-leg ${(bestTwo.spread * 10_000).toFixed(1)}bps spread, expected +${bestTwo.profitUsdc.toFixed(2)} USDC`,
      });
      return action;
    }
    // A profitable spread existed but the floor bid already eats the whole edge -- fall through to
    // layer 2 rather than trading it away on fees.
  }

  // ---- layer 2: z-score-gated single-leg fallback ----
  let bestOne: OneLeg | null = null;
  for (const view of views) {
    const info = gapInfo.get(view.base);
    if (!info || !info.burnedIn || info.absZ < Z_ENTER) continue;
    for (const venue of view.venues) {
      const gap = view.fair / venue.price - 1;
      const gapAbs = Math.abs(gap);
      const singleLegCost = (venue.feeBps + SINGLE_SAFETY_MARGIN_BPS) / 10000;
      if (gapAbs <= singleLegCost) continue;

      const buyBase = gap > 0;
      const tokenIn = buyBase ? "USDC" : view.base;
      const cap = buyBase ? usdcBal : BigInt(view.baseBalanceWei || "0");
      if (cap <= 0n) continue;

      // Size ramps with |z| between Z_ENTER and Z_AGGRESSIVE, but into the single-leg's own
      // (tighter) band -- this leg carries directional risk, so it never sizes as large as layer 1.
      const span = Math.max(0.0001, Z_AGGRESSIVE - Z_ENTER);
      const t = Math.max(0, Math.min(1, (info.absZ - Z_ENTER) / span));
      const sizeBps = Math.max(
        SINGLE_MIN_SIZE_BPS,
        Math.min(
          SINGLE_MAX_SIZE_BPS,
          Math.floor(SINGLE_MIN_SIZE_BPS + (SINGLE_MAX_SIZE_BPS - SINGLE_MIN_SIZE_BPS) * t),
        ),
      );
      const amountIn = sized(obs, tokenIn, sizeBps);
      if (amountIn <= 0n) continue;

      const sizeUsdc =
        tokenIn === "USDC"
          ? baseToFloat(amountIn, 6)
          : baseToFloat(amountIn, view.baseDecimals) * venue.price;
      const netEdge = gapAbs - singleLegCost;
      const profitUsdc = sizeUsdc * netEdge;
      if (!bestOne || profitUsdc > bestOne.profitUsdc)
        bestOne = { base: view.base, venue, gapAbs, absZ: info.absZ, tokenIn, amountIn, profitUsdc };
    }
  }

  if (!bestOne) {
    const burning = [...gapInfo.entries()].filter(([, i]) => !i.burnedIn);
    return noop(
      burning.length > 0
        ? `burn-in (${burning.map(([b]) => `${b} ${statsFor(b).count()}/${BURN_IN}`).join(", ")})`
        : "no z-confirmed gap worth taking",
    );
  }

  const ceiling = profitCeilingPerGas(bestOne.profitUsdc, fair, GAS_UNITS_ESTIMATE);
  const bid = adaptiveBid(obs, ceiling);
  if (bid === null) return noop("z-confirmed edge too thin to cover the floor bid");

  signals.layer = 2;
  signals.gapBps = bestOne.gapAbs * 10_000;
  signals.absZ = bestOne.absZ;
  signals.profitUsdc = bestOne.profitUsdc;
  signals.bidGwei = Number(bid) / 1e9;
  const action: Record<string, unknown> = {
    type: bestOne.venue.swapType,
    tokenIn: bestOne.tokenIn,
    amountIn: bestOne.amountIn.toString(),
    maxPriorityFeePerGasWei: bid.toString(),
    slippageBps: SINGLE_SLIPPAGE_BPS,
  };
  if (bestOne.base !== "WETH") action.base = bestOne.base;
  ctx.log({
    round,
    action,
    signals,
    reason: `${bestOne.base} single-leg, z=${bestOne.absZ.toFixed(2)}, gap ${(bestOne.gapAbs * 10_000).toFixed(1)}bps, expected +${bestOne.profitUsdc.toFixed(2)} USDC`,
  });
  return action;
}
