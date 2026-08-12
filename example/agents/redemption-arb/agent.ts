/**
 * redemption-arb: the CDP stablecoin venue's headline trade (issue #39).
 *
 * eUSD is redeemable against the riskiest Trove for exactly $1 of collateral, minus a redemption
 * fee. So whenever it trades below par on the Curve pool by more than that fee, there is a closed
 * loop that does not depend on the price going anywhere:
 *
 *   buy      spend USDC on eUSD while the pool is discounted
 *   redeem   exchange it for ETH at the oracle price, paying `redemptionRateBps` out of the ETH
 *   unwind   sell the ETH back to USDC, because the profit is in USDC and ETH is a price bet
 *
 * Three things make it a decision rather than a formula, and all three are in the observation:
 *
 *   the fee is not fixed. Every redemption in the run raises `baseRate`, and it decays on a ~12h
 *   half-life -- which inside a 300-second run means it effectively only rises. Redeeming early is
 *   cheap and redeeming after someone else is not, so the first mover prices everyone behind them.
 *
 *   the discount is not free to take. Buying eUSD pushes the pool back toward par, so an order
 *   sized at the whole balance closes the very dislocation it is trading.
 *
 *   the exit costs too. Redemption pays *ETH*, and turning that back into USDC pays an AMM fee. An
 *   agent that compares the discount against the redemption fee alone takes trades that lose money
 *   on the way out.
 *
 * The mirror trade -- minting eUSD and selling it when the pool is at a premium -- needs a Trove and
 * therefore WETH, which the evaluation regimes deliberately do not hand out (ADR 0017 §4). What is
 * here instead is the exit side of it: an inventory bought at a discount is sold rather than
 * redeemed once the peg has recovered past par, because at that point the pool pays more than the
 * protocol does.
 */
import type {
  AgentAction,
  AgentContext,
  AgentObservation,
  LiquityObservation,
} from "@eris/sdk";
import { TOKENS } from "@eris/sdk/constants.js";

// Edge demanded on top of every known cost before buying. The discount is measured at probe size
// and the fee curve moves under other people's redemptions, so this is the margin for both.
const SAFETY_BPS = Number(process.env.ERIS_REDEMPTION_SAFETY_BPS ?? "20");

// What it costs to turn redeemed ETH back into USDC, in bps of notional. The local Uniswap pool is
// 0.3%, so this is deliberately not optional: at a 60bps discount and a 50bps fee the trade looks
// profitable and is not.
const EXIT_COST_BPS = Number(process.env.ERIS_REDEMPTION_EXIT_COST_BPS ?? "35");

// Share of the free USDC balance to commit to one purchase. Buying pushes the pool back toward par,
// so the whole balance in one order is the reliable way to pay for a discount that is no longer
// there by the end of the fill.
const BUY_FRACTION_BPS = Number(
  process.env.ERIS_REDEMPTION_BUY_FRACTION_BPS ?? "3000",
);

// Never let one purchase exceed this share of the pool's eUSD depth, whatever the balance says.
const MAX_POOL_SHARE_BPS = Number(
  process.env.ERIS_REDEMPTION_MAX_POOL_SHARE_BPS ?? "1000",
);

// How much steeper than proportional the stableswap curve is around a broken peg. Measured on the
// deployed pool: an imbalance of 42k eUSD showed 120bps, and a purchase that took a quarter of that
// imbalance out closed 36% of the discount -- so the discount moves roughly 1.5x the share of the
// imbalance a trade removes. Used to size the buy, not to price it.
const IMPACT_CONVEXITY = Number(
  process.env.ERIS_REDEMPTION_IMPACT_CONVEXITY ?? "1.5",
);

const SLIPPAGE_BPS = Number(process.env.ERIS_REDEMPTION_SLIPPAGE_BPS ?? "100");

// Hold the redeemed ETH instead of selling it back to USDC. Off by default: holding ETH is a
// directional bet, and this agent is meant to be the venue's α rather than its β.
const HOLD_ETH = process.env.ERIS_REDEMPTION_HOLD_ETH === "1";

// Dust floors. Below these an action costs more in gas than it can earn.
const MIN_EUSD_WEI = 200n * 10n ** 18n; // redeeming less than this is not worth the gas
const MIN_USDC_UNITS = 200n * 10n ** 6n;
const MIN_WETH_WEI = 10n ** 16n; // 0.01 WETH

/// What this agent started with in each of the two forms redemption pays out in.
///
/// Native ETH: the balance *above* the endowment is what is tradable, because the endowment is what
/// pays for gas -- selling into it is how an agent strands itself with a position it can no longer
/// close (issue #39).
///
/// WETH: the same rule for a different reason. A funding profile that hands out WETH (the template
/// config does, for the LST venue) is not redemption proceeds, and dumping it into USDC pays the
/// AMM's fee on inventory the agent never chose to hold. Under the evaluation profile this is zero
/// and nothing changes; without it, an agent funded in WETH spends its whole run trying to sell it.
let baselineEthWei: bigint | null = null;
let baselineWethWei: bigint | null = null;

function minBI(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function fraction(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.max(0, Math.round(bps)))) / 10_000n;
}

/// The discount at which redeeming beats selling into the pool. Redemption pays par minus the
/// protocol's fee, and the ETH it pays in still has to be sold; the pool pays the market price
/// directly. So the two exits are equal exactly here, and below it the pool is the better door.
export function redeemThresholdBps(l: LiquityObservation): number {
  return l.redemptionRateBps + EXIT_COST_BPS;
}

/// How far the pool is from balanced, in USDC-equivalent units. Near par the two coins trade
/// one-for-one, so half the difference between the legs is what a trade has to move to close the
/// dislocation. Zero when the observation carried no reserves.
export function poolImbalanceUsdc(l: LiquityObservation): bigint {
  if (!l.poolReserves) return 0n;
  const eusd = BigInt(l.poolReserves.eusd) / 10n ** 12n; // to USDC's 6 decimals
  const usdc = BigInt(l.poolReserves.usdc);
  return eusd > usdc ? (eusd - usdc) / 2n : 0n;
}

export type RedemptionDecision =
  | { kind: "buy"; usdcIn: bigint; edgeBps: number }
  | { kind: "redeem"; eusdIn: bigint; edgeBps: number }
  | { kind: "sell"; eusdIn: bigint; premiumBps: number }
  | { kind: "wrap"; ethWei: bigint }
  | { kind: "unwind"; wethWei: bigint }
  | { kind: "hold"; reason: string };

/// The decision, separated from the observation plumbing so the economics can be reasoned about
/// (and tested) without a chain.
///
/// Order matters as much as the thresholds. Recycling capital comes before finding new trades: an
/// agent that buys again while its last redemption is still sitting in ETH is running a price bet
/// it never decided to take, and it has less USDC to trade the next dislocation with.
export function decideRedemption(input: {
  liquity: LiquityObservation;
  usdcUnits: bigint;
  wethWei: bigint;
  ethWei: bigint;
  ethBaselineWei: bigint;
  wethBaselineWei: bigint;
  maxUsdcPerRound: bigint;
  maxWethPerRound: bigint;
  canSellEth: boolean;
}): RedemptionDecision {
  const l = input.liquity;
  const eusd = BigInt(l.eusdBalanceWei);

  // 1. Sell the proceeds of the last redemption. WETH first, then wrap whatever native ETH the
  //    redemption left above the gas endowment.
  if (input.canSellEth && !HOLD_ETH) {
    const sellable =
      input.wethWei > input.wethBaselineWei
        ? input.wethWei - input.wethBaselineWei
        : 0n;
    if (sellable >= MIN_WETH_WEI) {
      // Capped at the per-round swap limit rather than sent whole. A redemption large enough to
      // exceed it would otherwise be rejected by the runtime every block, and because this branch
      // comes first the agent would never reach any of its other decisions -- measured on the
      // template config, where a WETH-funded wallet spent all 40 blocks being rejected.
      const size =
        input.maxWethPerRound > 0n && sellable > input.maxWethPerRound
          ? input.maxWethPerRound
          : sellable;
      return { kind: "unwind", wethWei: size };
    }
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
      reason:
        "the eUSD/USDC pool did not quote: there is no market price to trade against",
    };
  }

  // 2. eUSD in hand goes out the better of the two doors. The protocol pays par minus the
  //    redemption fee; the pool pays whatever it is trading at. Above par the pool wins, and
  //    redeeming there would be paying a fee to receive less.
  if (eusd >= MIN_EUSD_WEI) {
    const redeemEdge = l.redemptionEdgeBps - EXIT_COST_BPS;
    if (l.discountBps <= 0)
      return { kind: "sell", eusdIn: eusd, premiumBps: -l.discountBps };
    if (redeemEdge > 0)
      return { kind: "redeem", eusdIn: eusd, edgeBps: redeemEdge };
    // Bought into a discount that has since narrowed but not closed. Selling here pays the pool's
    // spread on the way out for nothing, so hold and let the position work.
    return {
      kind: "hold",
      reason: `holding ${(Number(eusd) / 1e18).toFixed(0)} eUSD: redeeming nets ${redeemEdge.toFixed(1)}bps after the ${EXIT_COST_BPS}bps exit, and the pool is still ${l.discountBps.toFixed(1)}bps below par`,
    };
  }

  // 3. Buy the discount, if it clears every cost between here and USDC.
  const buyEdge =
    l.discountBps - l.redemptionRateBps - EXIT_COST_BPS - SAFETY_BPS;
  if (buyEdge > 0 && input.usdcUnits >= MIN_USDC_UNITS) {
    let size = minBI(
      fraction(input.usdcUnits, BUY_FRACTION_BPS),
      input.usdcUnits,
    );
    if (input.maxUsdcPerRound > 0n) size = minBI(size, input.maxUsdcPerRound);
    // The pool's own depth is the harder bound: past a share of it the purchase is bidding against
    // itself and the average fill is nowhere near the quoted discount.
    const poolEusd = l.poolReserves ? BigInt(l.poolReserves.eusd) : 0n;
    if (poolEusd > 0n) {
      // eUSD is 18-decimal and USDC is 6; near par the two are interchangeable at 1e12.
      const capUsdc = fraction(poolEusd, MAX_POOL_SHARE_BPS) / 10n ** 12n;
      if (capUsdc > 0n) size = minBI(size, capUsdc);
    }
    // The binding cap, and the one that took a live run to find: buy so much that the purchase
    // itself pushes the discount under the redemption threshold and the loop never closes. Measured
    // on the first run of this agent -- it bought at 120bps, its own fill left 78bps, and 85bps was
    // needed to redeem, so it sat on the inventory and exited through the pool instead. Sizing to
    // the headroom above that threshold is what turns the trade back into a redemption.
    const room = l.discountBps - redeemThresholdBps(l) - SAFETY_BPS;
    const imbalanceUsdc = poolImbalanceUsdc(l);
    if (imbalanceUsdc > 0n && l.discountBps > 0) {
      const affordable =
        room > 0
          ? (imbalanceUsdc * BigInt(Math.floor(room * 1000))) /
            BigInt(Math.ceil(2 * IMPACT_CONVEXITY * l.discountBps * 1000))
          : 0n;
      size = minBI(size, affordable);
    }
    if (size >= MIN_USDC_UNITS)
      return { kind: "buy", usdcIn: size, edgeBps: buyEdge };
  }

  return {
    kind: "hold",
    reason:
      `eUSD is ${l.discountBps.toFixed(1)}bps off par; redeeming costs ${l.redemptionRateBps.toFixed(1)}bps ` +
      `and the exit ${EXIT_COST_BPS}bps, so the edge is ${buyEdge.toFixed(1)}bps after ${SAFETY_BPS}bps of safety`,
  };
}

export function decide(
  obs: AgentObservation,
  ctx?: AgentContext,
): AgentAction | Record<string, unknown> | null {
  const liquity = obs.protocols.liquity;
  if (!liquity) {
    return {
      type: "noop",
      reason: "the liquity venue is not enabled this run",
    };
  }
  const ethWei = BigInt(obs.balances.ethWei || "0");
  const wethWei = BigInt(obs.balances.wethWei || "0");
  if (baselineEthWei === null) baselineEthWei = ethWei;
  if (baselineWethWei === null) baselineWethWei = wethWei;

  const decision = decideRedemption({
    liquity,
    usdcUnits: BigInt(obs.balances.usdcUnits || "0"),
    wethWei,
    ethWei,
    ethBaselineWei: baselineEthWei,
    wethBaselineWei: baselineWethWei,
    maxUsdcPerRound: BigInt(obs.limits.maxUsdcInUnits || "0"),
    maxWethPerRound: BigInt(obs.limits.maxWethInWei || "0"),
    // Turning ETH back into USDC needs a spot market. Without one the proceeds stay in ETH, which
    // is a worse position than the agent chose but better than a swap that reverts every block.
    canSellEth: obs.enabledProtocols.includes("uniswap"),
  });
  const fee = obs.limits.defaultPriorityFeePerGasWei;

  // Record why, every cycle. Sitting out is the correct move most of the time here -- the peg is
  // near par by construction until something moves it -- and without this a run where the agent
  // correctly did nothing is indistinguishable from one where it was broken.
  ctx?.log({
    round: obs.round,
    reason: decision.kind === "hold" ? decision.reason : decision.kind,
    signals: {
      discountBps: Number(liquity.discountBps.toFixed(2)),
      redemptionRateBps: Number(liquity.redemptionRateBps.toFixed(2)),
      redemptionEdgeBps: Number(liquity.redemptionEdgeBps.toFixed(2)),
      eusd: Number((Number(liquity.eusdBalanceWei) / 1e18).toFixed(2)),
      tcr: Number(liquity.tcr.toFixed(3)),
      recoveryMode: liquity.recoveryMode ? 1 : 0,
    },
  });

  switch (decision.kind) {
    case "buy":
      return {
        type: "liquitySwapEusd",
        tokenIn: "USDC",
        amountIn: decision.usdcIn.toString(),
        slippageBps: SLIPPAGE_BPS,
        maxPriorityFeePerGasWei: fee,
      };
    case "sell":
      return {
        type: "liquitySwapEusd",
        tokenIn: "EUSD",
        amountIn: decision.eusdIn.toString(),
        slippageBps: SLIPPAGE_BPS,
        maxPriorityFeePerGasWei: fee,
      };
    case "redeem":
      // The adapter computes the HintHelpers hints and truncates to what the sorted list can
      // absorb; an unhinted redemption walks the list on chain and is prohibitively expensive.
      return {
        type: "liquityRedeem",
        amountEusdWei: decision.eusdIn.toString(),
        maxPriorityFeePerGasWei: fee,
      };
    case "wrap":
      // No action type wraps ETH -- every other venue is WETH-denominated, so nothing has needed
      // it. Redemption is the one payout in native ETH, so this agent does it itself.
      return {
        type: "rawTx",
        tx: {
          to: TOKENS.WETH.address,
          data: "0xd0e30db0", // WETH9.deposit()
          value: decision.ethWei.toString(),
        },
        maxPriorityFeePerGasWei: fee,
      };
    case "unwind":
      return {
        type: "swap",
        tokenIn: "WETH",
        amountIn: decision.wethWei.toString(),
        slippageBps: SLIPPAGE_BPS,
        maxPriorityFeePerGasWei: fee,
      };
    default:
      return { type: "noop", reason: decision.reason };
  }
}
