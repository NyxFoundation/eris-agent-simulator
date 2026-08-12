/**
 * trove-manager: the borrower side of the CDP venue (issue #39).
 *
 * Opening a Trove is easy. What the venue actually asks is whether you can hold one through a
 * price path, and it asks it in three ways that no other venue here does:
 *
 *   liquidation   under a 110% ICR the Trove is taken: the collateral goes to the Stability Pool
 *                 and you keep the eUSD. That is a real loss of the difference, and the price at
 *                 which it happens is `liquidationPriceUsd` -- one number, in the observation.
 *
 *   redemption    anyone holding eUSD can exchange it for *your* collateral at the oracle price if
 *                 you are the riskiest Trove in the list. It is not a loss (you get par for what
 *                 they take) but it shrinks the position you chose, and it hits the bottom of the
 *                 list first. `positionFromRiskiest` and `redeemedAheadEusdWei` say how exposed you
 *                 are, and adding collateral moves you up. Defending that position is the skill the
 *                 issue names as having no equivalent anywhere else in this simulator.
 *
 *   Recovery Mode below a system-wide 150% TCR *everyone* under 150% becomes liquidatable at once,
 *                 not just those under 110%. Nothing you did causes it and nothing you do stops it,
 *                 so the only response is to already be above the line when it arrives.
 *
 * What it does with the eUSD it draws is one switch, `ERIS_TROVE_SPEND_DEBT`, and it is the switch
 * that decides whether the other three matter. Held, the eUSD is the repayment that raises a failing
 * ratio for free. Spent -- sold for USDC, which is what borrowing dollars against ETH actually means
 * -- the only defence left is collateral, and a borrower who posted all of it has none. Default off,
 * because the interesting comparison is between two agents that differ in exactly that.
 */
import type {
  AgentAction,
  AgentContext,
  AgentObservation,
  LiquityObservation,
} from "@eris/sdk";

// The ICR to open at. Well clear of MCR: at 110% a Trove is liquidatable the moment the price
// twitches, and the borrowing fee makes reopening expensive.
const TARGET_ICR = Number(process.env.ERIS_TROVE_TARGET_ICR ?? "2.0");

// Add collateral below this. Above MCR by a wide margin on purpose -- the oracle this venue reads
// is one block stale for everyone, so a Trove sitting just above the line is already past it.
const FLOOR_ICR = Number(process.env.ERIS_TROVE_FLOOR_ICR ?? "1.5");

// In Recovery Mode the whole system's floor rises to CCR, so the response is to clear CCR with
// room, not to creep to it.
const RECOVERY_MARGIN = Number(process.env.ERIS_TROVE_RECOVERY_MARGIN ?? "1.1");

// Defend the sorted-list position when this little debt sits between you and a redemption. Measured
// against the whole system's debt, because "how much can be redeemed before it reaches me" is only
// meaningful next to how much eUSD exists to redeem with.
const REDEMPTION_SHIELD_BPS = Number(
  process.env.ERIS_TROVE_SHIELD_BPS ?? "200",
);

// Share of the WETH balance to post as collateral when opening. The rest is kept for the top-ups
// the two defences above will want; an agent that posts everything can only watch.
const OPEN_FRACTION_BPS = Number(process.env.ERIS_TROVE_OPEN_BPS ?? "6000");

// What to do with the eUSD the Trove draws. Holding it is the conservative choice and the default:
// it is also the repayment that defends the position when the price falls. Spending it -- selling it
// for USDC, which is what borrowing dollars against ETH actually means -- is a real strategy and a
// materially different risk, because the only defence left is collateral the agent may not have.
const SPEND_DEBT = process.env.ERIS_TROVE_SPEND_DEBT === "1";

// Blocks before the end of the run to stop opening. A Trove opened at the last moment pays the
// borrowing fee and cannot be managed afterwards.
const CLOSING_BLOCKS = Number(process.env.ERIS_TROVE_CLOSING_BLOCKS ?? "10");

const MIN_TOPUP_WEI = 10n ** 16n; // 0.01 WETH: below this the gas costs more than the defence

function minBI(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function fraction(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.max(0, Math.round(bps)))) / 10_000n;
}

export type TroveDecision =
  | { kind: "open"; collateralWei: bigint; debtEusdWei: bigint; icr: number }
  | { kind: "spend"; amountEusdWei: bigint }
  | { kind: "buyToClose"; usdcIn: bigint; shortfallEusdWei: bigint }
  | { kind: "topUp"; collateralWei: bigint; reason: string }
  | { kind: "repay"; amountEusdWei: bigint; reason: string }
  | { kind: "close" }
  | { kind: "hold"; reason: string };

/// Collateral needed to bring a Trove to `targetIcr` at the current price.
export function topUpForIcr(input: {
  collWei: bigint;
  debtEusdWei: bigint;
  priceUsd: number;
  targetIcr: number;
}): bigint {
  if (input.priceUsd <= 0) return 0n;
  const debt = Number(input.debtEusdWei) / 1e18;
  const needCollEth = (debt * input.targetIcr) / input.priceUsd;
  const haveCollEth = Number(input.collWei) / 1e18;
  if (needCollEth <= haveCollEth) return 0n;
  return BigInt(Math.ceil((needCollEth - haveCollEth) * 1e18));
}

/// The decision, separated from the observation plumbing so the risk rules can be reasoned about
/// (and tested) without a chain.
///
/// Order is the risk order, not the profit order: being liquidated costs the most, being caught by
/// Recovery Mode costs the same for a reason you did not cause, and being redeemed against merely
/// resizes you. Anything that raises the ratio serves all three at once, which is why collateral
/// goes in before debt comes off -- repaying needs eUSD the agent may have already spent.
export function decideTrove(input: {
  liquity: LiquityObservation;
  wethWei: bigint;
  usdcUnits: bigint;
  blocksRemaining: number | undefined;
}): TroveDecision {
  const l = input.liquity;
  const trove = l.trove;
  const late =
    input.blocksRemaining !== undefined &&
    input.blocksRemaining <= CLOSING_BLOCKS;

  if (!trove || trove.status !== 1) {
    if (late)
      return {
        kind: "hold",
        reason: `${input.blocksRemaining} blocks left: a Trove opened now pays the borrowing fee and cannot be managed`,
      };
    // Size the position off the collateral, then draw the debt the target ratio allows.
    const collateralWei = minBI(
      fraction(input.wethWei, OPEN_FRACTION_BPS),
      input.wethWei,
    );
    const collUsd = (Number(collateralWei) / 1e18) * l.priceUsd;
    const debt = collUsd / TARGET_ICR;
    const debtEusdWei = BigInt(Math.floor(debt * 1e18));
    const minNetDebt = BigInt(l.minNetDebtEusdWei);
    if (debtEusdWei < minNetDebt)
      return {
        kind: "hold",
        reason: `collateral supports ${debt.toFixed(0)} eUSD of debt, under the ${(Number(minNetDebt) / 1e18).toFixed(0)} minimum`,
      };
    // Recovery Mode raises the bar for opening from MCR to CCR, and there is no reason to open into
    // it at all: the system is already one price move from liquidating everyone under 150%.
    if (l.recoveryMode)
      return {
        kind: "hold",
        reason: "the system is in Recovery Mode; not opening into it",
      };
    return { kind: "open", collateralWei, debtEusdWei, icr: TARGET_ICR };
  }

  const collWei = BigInt(trove.collWei);
  const debtWei = BigInt(trove.debtEusdWei);
  const topUpTo = (target: number): bigint =>
    topUpForIcr({
      collWei,
      debtEusdWei: debtWei,
      priceUsd: l.priceUsd,
      targetIcr: target,
    });

  // 1. Recovery Mode: the floor is CCR for everyone, whatever your own ratio was a block ago.
  if (l.recoveryMode && trove.icr < l.ccr * RECOVERY_MARGIN) {
    const need = topUpTo(l.ccr * RECOVERY_MARGIN);
    const size = minBI(need, input.wethWei);
    if (size >= MIN_TOPUP_WEI)
      return {
        kind: "topUp",
        collateralWei: size,
        reason: `Recovery Mode: ICR ${trove.icr.toFixed(2)} is inside the CCR ${l.ccr} band that is liquidatable while it lasts`,
      };
    // Out of collateral. Debt is the other side of the same ratio, and repaying needs only eUSD.
    return {
      kind: "repay",
      amountEusdWei: BigInt(l.eusdBalanceWei),
      reason: `Recovery Mode with no WETH left: repaying to raise ICR ${trove.icr.toFixed(2)}`,
    };
  }

  // 2. Ordinary liquidation risk.
  if (trove.icr < FLOOR_ICR) {
    const need = topUpTo(TARGET_ICR);
    const size = minBI(need, input.wethWei);
    if (size >= MIN_TOPUP_WEI)
      return {
        kind: "topUp",
        collateralWei: size,
        reason: `ICR ${trove.icr.toFixed(2)} under the ${FLOOR_ICR} floor; liquidation at ${trove.liquidationPriceUsd.toFixed(0)} USD`,
      };
    if (BigInt(l.eusdBalanceWei) > 0n)
      return {
        kind: "repay",
        amountEusdWei: BigInt(l.eusdBalanceWei),
        reason: `ICR ${trove.icr.toFixed(2)} under the floor and no WETH left; repaying instead`,
      };
  }

  // 3. Redemption exposure: how much eUSD can be redeemed before the walk reaches this Trove. Being
  //    at the bottom of the list is not a loss, but it is the position getting resized by somebody
  //    else's trade -- and the fix is the same top-up that serves the two risks above.
  if (trove.positionKnown && !l.recoveryMode) {
    const systemDebt = BigInt(l.totalDebtEusdWei);
    const shield = fraction(systemDebt, REDEMPTION_SHIELD_BPS);
    if (BigInt(trove.redeemedAheadEusdWei) < shield) {
      const need = topUpTo(Math.max(TARGET_ICR, trove.icr * 1.1));
      const size = minBI(need, input.wethWei);
      if (size >= MIN_TOPUP_WEI)
        return {
          kind: "topUp",
          collateralWei: size,
          reason: `position ${trove.positionFromRiskiest} from the front of the redemption queue with only ${(Number(trove.redeemedAheadEusdWei) / 1e18).toFixed(0)} eUSD ahead`,
        };
    }
  }

  // 4. Spend the proceeds, if that is the strategy. After the defences above, never before: eUSD in
  //    hand is the cheapest way to raise a failing ratio, and selling it first is what turns a
  //    manageable Trove into a liquidation.
  if (SPEND_DEBT && !late) {
    const idle = BigInt(l.eusdBalanceWei);
    if (idle >= 10n ** 20n) return { kind: "spend", amountEusdWei: idle };
  }

  // 5. End of the run: close if the eUSD to repay is in hand. Scoring marks an open Trove at
  //    collateral minus debt either way, so this is about not leaving a position nobody manages.
  if (late) {
    const held = BigInt(l.eusdBalanceWei);
    const owed = BigInt(trove.netDebtEusdWei);
    if (held >= owed) return { kind: "close" };
    // Drawing 4,000 eUSD books 4,020 of debt: the borrowing fee is added to what is owed and never
    // handed over, so a borrower who kept every unit it drew is still short by the fee and can
    // never close. Buying the difference is the only way out, and it is what closing actually costs.
    const shortfall = owed - held;
    if (l.marketQuoted && input.usdcUnits > 0n) {
      // eUSD is 18-decimal and USDC is 6; near par they are interchangeable at 1e12, plus a little
      // headroom for the pool's price and fee.
      const needUsdc = (shortfall / 10n ** 12n) + (shortfall / 10n ** 14n);
      const size = minBI(needUsdc, input.usdcUnits);
      if (size > 0n)
        return { kind: "buyToClose", usdcIn: size, shortfallEusdWei: shortfall };
    }
  }

  return {
    kind: "hold",
    reason: `ICR ${trove.icr.toFixed(2)} (floor ${FLOOR_ICR}, liquidation at ${trove.liquidationPriceUsd.toFixed(0)} USD), ${trove.positionFromRiskiest} from the redemption queue`,
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
  const wethWei = BigInt(obs.balances.wethWei || "0");
  const decision = decideTrove({
    liquity,
    wethWei,
    usdcUnits: BigInt(obs.balances.usdcUnits || "0"),
    blocksRemaining: obs.blocksRemaining,
  });
  const fee = obs.limits.defaultPriorityFeePerGasWei;

  ctx?.log({
    round: obs.round,
    reason: decision.kind === "hold" ? decision.reason : decision.kind,
    signals: {
      icr: Number((liquity.trove?.icr ?? 0).toFixed(3)),
      tcr: Number(liquity.tcr.toFixed(3)),
      recoveryMode: liquity.recoveryMode ? 1 : 0,
      liquidationPriceUsd: Math.round(liquity.trove?.liquidationPriceUsd ?? 0),
      priceUsd: Math.round(liquity.priceUsd),
      queuePosition: liquity.trove?.positionFromRiskiest ?? -1,
    },
  });

  switch (decision.kind) {
    case "open":
      return {
        type: "liquityOpenTrove",
        collateralWethWei: decision.collateralWei.toString(),
        debtEusdWei: decision.debtEusdWei.toString(),
        maxPriorityFeePerGasWei: fee,
      };
    case "topUp":
      return {
        type: "liquityAdjustTrove",
        addCollateralWethWei: decision.collateralWei.toString(),
        maxPriorityFeePerGasWei: fee,
      };
    case "repay":
      return {
        type: "liquityAdjustTrove",
        debtChangeEusdWei: decision.amountEusdWei.toString(),
        isDebtIncrease: false,
        maxPriorityFeePerGasWei: fee,
      };
    case "buyToClose":
      return {
        type: "liquitySwapEusd",
        tokenIn: "USDC",
        amountIn: decision.usdcIn.toString(),
        slippageBps: 100,
        maxPriorityFeePerGasWei: fee,
      };
    case "spend":
      return {
        type: "liquitySwapEusd",
        tokenIn: "EUSD",
        amountIn: decision.amountEusdWei.toString(),
        slippageBps: 100,
        maxPriorityFeePerGasWei: fee,
      };
    case "close":
      return { type: "liquityCloseTrove", maxPriorityFeePerGasWei: fee };
    default:
      return { type: "noop", reason: decision.reason };
  }
}
