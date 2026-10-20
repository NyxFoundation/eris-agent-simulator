/**
 * noah's Liquity (eUSD) side -- a ported copy of example/agents/redemption-arb's decideRedemption,
 * so that noah's AMM-only decide() gains a second, independent source of candidates without
 * noah depending on another agent's directory (each submission is one self-contained dir;
 * bundle:agent zips one).
 *
 * eUSD is redeemable against the riskiest Trove for ~$1 of collateral minus a fee. When it trades
 * below par on the eUSD/USDC pool by more than that fee, buying it and redeeming closes a loop that
 * does not depend on price direction -- see example/agents/redemption-arb/agent.ts's header comment
 * for the three reasons this is a decision and not a formula (the fee rises with every redemption
 * in the run, buying pushes the pool back toward par, and the ETH redemption pays still costs an
 * AMM fee to turn back into USDC).
 *
 * The one change from the original: `buy` now carries an estimated `profitUsdc`, in the same units
 * noah's own AMM `Candidate.profitUsdc` uses, so agent.ts can put it in the same
 * `candidates.sort((a, b) => b.profitUsdc - a.profitUsdc)` funnel instead of inventing a second
 * ranking. `redeem` / `sell` / `wrap` / `unwind` are "finish what was already started," not a fresh
 * opportunity to rank against the AMM side -- agent.ts takes them immediately, before even building
 * the AMM candidates, for the same reason the original orders them first: holding eUSD or ETH
 * across blocks while chasing a different trade is a price bet nobody chose to take. The other
 * addition: `closingOut` gates step 3 (a fresh `buy`) off inside the AMM side's own close-out
 * window, because eUSD/DAI score at realizable value (sell the whole holding at once, concave in
 * size) -- a buy taken too late to round-trip back to cash before the epoch's scoring boundary
 * pays that markdown for nothing. Steps 1-2 (finishing what is already in flight) ignore it.
 *
 * JP: redemption-arb の decideRedemption を noah 自身のディレクトリに複製したもの（提出は
 * 1 agent = 1 ディレクトリなので他 agent への import はできない）。buy 判断にのみ
 * profitUsdc を追加し、noah の AMM 側 candidates と同じ基準で比較できるようにしている。
 * redeem/sell/wrap/unwind は「前回までの後始末」であって新しい機会ではないので、
 * AMM candidates を作る前に無条件で実行する（redemption-arb 本家と同じ優先順位）。
 */
import type { LiquityObservation } from "@eris/sdk";

export const LIQUITY_PARAMS = {
  safetyBps: Number(process.env.NOAH_REDEMPTION_SAFETY_BPS ?? "20"),
  exitCostBps: Number(process.env.NOAH_REDEMPTION_EXIT_COST_BPS ?? "35"),
  buyFractionBps: Number(process.env.NOAH_REDEMPTION_BUY_FRACTION_BPS ?? "3000"),
  maxPoolShareBps: Number(process.env.NOAH_REDEMPTION_MAX_POOL_SHARE_BPS ?? "1000"),
  impactConvexity: Number(process.env.NOAH_REDEMPTION_IMPACT_CONVEXITY ?? "1.5"),
  slippageBps: Number(process.env.NOAH_REDEMPTION_SLIPPAGE_BPS ?? "100"),
};

for (const [k, v] of Object.entries(LIQUITY_PARAMS)) {
  if (!Number.isFinite(v) || v < 0) {
    process.stderr.write(`noah/liquity: invalid LIQUITY_PARAMS.${k}: ${v}\n`);
    process.exit(1);
  }
}

const MIN_EUSD_WEI = 200n * 10n ** 18n; // redeeming less than this is not worth the gas
const MIN_USDC_UNITS = 200n * 10n ** 6n;
const MIN_WETH_WEI = 10n ** 16n; // 0.01 WETH

export type LiquityDecision =
  | { kind: "buy"; usdcIn: bigint; edgeBps: number; profitUsdc: number }
  | { kind: "redeem"; eusdIn: bigint; edgeBps: number }
  | { kind: "sell"; eusdIn: bigint; premiumBps: number }
  | { kind: "wrap"; ethWei: bigint }
  | { kind: "unwind"; wethWei: bigint }
  | { kind: "hold"; reason: string };

function minBI(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function fraction(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.max(0, Math.round(bps)))) / 10_000n;
}

/// The discount at which redeeming beats selling into the pool (same economics as
/// redemption-arb's redeemThresholdBps).
export function redeemThresholdBps(l: LiquityObservation): number {
  return l.redemptionRateBps + LIQUITY_PARAMS.exitCostBps;
}

/// How far the pool is from balanced, in USDC-equivalent units (redemption-arb's poolImbalanceUsdc).
export function poolImbalanceUsdc(l: LiquityObservation): bigint {
  if (!l.poolReserves) return 0n;
  const eusd = BigInt(l.poolReserves.eusd) / 10n ** 12n; // to USDC's 6 decimals
  const usdc = BigInt(l.poolReserves.usdc);
  return eusd > usdc ? (eusd - usdc) / 2n : 0n;
}

/// Pure decision, separated from obs/action plumbing (ported from redemption-arb's
/// decideRedemption -- same order, same thresholds, `buy` additionally sized into profitUsdc).
export function decideLiquity(input: {
  liquity: LiquityObservation;
  usdcUnits: bigint;
  wethWei: bigint;
  ethWei: bigint;
  ethBaselineWei: bigint;
  wethBaselineWei: bigint;
  canSellEth: boolean;
  // True inside the AMM side's close-out window (noah's PARAMS.closeOutBlocks). A fresh buy here
  // takes at least ~3 blocks to round-trip (buy lands -> redeem/sell sent -> proceeds land -> sell
  // proceeds), so one started this late is still eUSD or ETH in hand at the scoring boundary. Under
  // the realizable-value rule that eUSD/DAI are marked at (sell the whole holding at once, concave in
  // size), that is a markdown a buy taken earlier would not have paid. Finishing what is already in
  // flight (steps 1-2 below) is unaffected -- only a fresh buy (step 3) is gated.
  closingOut: boolean;
}): LiquityDecision {
  const l = input.liquity;
  const eusd = BigInt(l.eusdBalanceWei);

  // 1. Sell the proceeds of the last redemption. WETH first, then wrap whatever native ETH the
  //    redemption left above the gas endowment.
  if (input.canSellEth) {
    const sellable =
      input.wethWei > input.wethBaselineWei ? input.wethWei - input.wethBaselineWei : 0n;
    if (sellable >= MIN_WETH_WEI) return { kind: "unwind", wethWei: sellable };
    const reserve =
      input.ethBaselineWei > BigInt(l.suggestedGasReserveWei)
        ? input.ethBaselineWei
        : BigInt(l.suggestedGasReserveWei);
    if (input.ethWei > reserve + MIN_WETH_WEI)
      return { kind: "wrap", ethWei: input.ethWei - reserve };
  }

  if (!l.marketQuoted) {
    return {
      kind: "hold",
      reason: "the eUSD/USDC pool did not quote: there is no market price to trade against",
    };
  }

  // 2. eUSD in hand goes out the better of the two doors.
  if (eusd >= MIN_EUSD_WEI) {
    const redeemEdge = l.redemptionEdgeBps - LIQUITY_PARAMS.exitCostBps;
    if (l.discountBps <= 0) return { kind: "sell", eusdIn: eusd, premiumBps: -l.discountBps };
    if (redeemEdge > 0) return { kind: "redeem", eusdIn: eusd, edgeBps: redeemEdge };
    return {
      kind: "hold",
      reason: `holding ${(Number(eusd) / 1e18).toFixed(0)} eUSD: redeeming nets ${redeemEdge.toFixed(1)}bps after the ${LIQUITY_PARAMS.exitCostBps}bps exit, and the pool is still ${l.discountBps.toFixed(1)}bps below par`,
    };
  }

  // 3. Buy the discount, if it clears every cost between here and USDC -- but not this late in the
  //    epoch, when the round trip back to cash can no longer finish before the scoring boundary.
  if (input.closingOut) {
    return {
      kind: "hold",
      reason:
        "closing out: a fresh buy could not redeem/sell back to cash before the epoch's scoring " +
        "boundary, and eUSD held into it is marked at its realizable (sell-it-all-now) value, not par",
    };
  }
  const buyEdge =
    l.discountBps - l.redemptionRateBps - LIQUITY_PARAMS.exitCostBps - LIQUITY_PARAMS.safetyBps;
  if (buyEdge > 0 && input.usdcUnits >= MIN_USDC_UNITS) {
    let size = minBI(fraction(input.usdcUnits, LIQUITY_PARAMS.buyFractionBps), input.usdcUnits);
    const poolEusd = l.poolReserves ? BigInt(l.poolReserves.eusd) : 0n;
    if (poolEusd > 0n) {
      const capUsdc = fraction(poolEusd, LIQUITY_PARAMS.maxPoolShareBps) / 10n ** 12n;
      if (capUsdc > 0n) size = minBI(size, capUsdc);
    }
    const room = l.discountBps - redeemThresholdBps(l) - LIQUITY_PARAMS.safetyBps;
    const imbalanceUsdc = poolImbalanceUsdc(l);
    if (imbalanceUsdc > 0n && l.discountBps > 0) {
      const affordable =
        room > 0
          ? (imbalanceUsdc * BigInt(Math.floor(room * 1000))) /
            BigInt(Math.ceil(2 * LIQUITY_PARAMS.impactConvexity * l.discountBps * 1000))
          : 0n;
      size = minBI(size, affordable);
    }
    if (size >= MIN_USDC_UNITS) {
      const profitUsdc = (Number(size) / 1e6) * (buyEdge / 10_000);
      return { kind: "buy", usdcIn: size, edgeBps: buyEdge, profitUsdc };
    }
  }

  return {
    kind: "hold",
    reason:
      `eUSD is ${l.discountBps.toFixed(1)}bps off par; redeeming costs ${l.redemptionRateBps.toFixed(1)}bps ` +
      `and the exit ${LIQUITY_PARAMS.exitCostBps}bps, so the edge is ${buyEdge.toFixed(1)}bps after ${LIQUITY_PARAMS.safetyBps}bps of safety`,
  };
}
