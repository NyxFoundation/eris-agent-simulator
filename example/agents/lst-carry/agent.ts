/**
 * lst-carry: works the liquid-staking venue's whole decision surface (issue #38).
 *
 * An LST has two prices at once. The vault owes `redemptionRateWeth` per share, but only through a
 * withdrawal queue that takes `withdrawalDelayBlocks`; the secondary market pays `marketPriceWeth`
 * immediately, at whatever discount it happens to be trading. Every decision here is about which
 * of those two you want, and whether the run lasts long enough to still have the choice:
 *
 *   claim    a finalized redemption is free money sitting on the table
 *   carry    the market is discounted below redemption -> buy it and queue the redemption at par,
 *            but only while the queue still fits inside the run
 *   harvest  the market is at a premium -> sell shares into it rather than redeem at par
 *   stake    neither, so just earn the yield -- provided you can still queue an exit later
 *   hold     late in the run, do nothing: selling only pays the pool's fee, and scoring already
 *            marks the position at what the pool would pay
 *
 * The last one matters more than it looks. Scoring marks an LST position at what it could realize,
 * so a panicked end-of-run exit converts a mark into the same number minus fees.
 */
import type {
  AgentAction,
  AgentContext,
  AgentObservation,
  LstObservation,
} from "@eris/sdk";

// Round-trip cost of touching the pool (its fee plus the impact of a real-size order), in bps.
// The carry has to clear this before it is worth doing.
const POOL_COST_BPS = Number(process.env.ERIS_LST_POOL_COST_BPS ?? "12");
// Extra edge demanded on top of cost, so noise around par does not trigger trades.
const SAFETY_BPS = Number(process.env.ERIS_LST_SAFETY_BPS ?? "15");
// Blocks of slack left after the queue delay before trusting a queued exit to finalize in time.
const QUEUE_MARGIN_BLOCKS = Number(
  process.env.ERIS_LST_QUEUE_MARGIN_BLOCKS ?? "4",
);
// How much of the WETH-denominated book to hold as LST once there is nothing better to do, in bps.
// A *target*, not a per-cycle fraction: staking a fixed slice of the remaining balance every block
// converges on the same allocation but pays gas twenty-five times to get there (measured in a live
// run, where it was the whole of the agent's loss).
const STAKE_TARGET_BPS = Number(
  process.env.ERIS_LST_STAKE_TARGET_BPS ?? "7000",
);
// Don't top up for a gap smaller than this share of the book: rebalancing dust is pure gas.
const STAKE_REBALANCE_BAND_BPS = Number(
  process.env.ERIS_LST_STAKE_BAND_BPS ?? "500",
);
const CARRY_FRACTION_BPS = Number(
  process.env.ERIS_LST_CARRY_FRACTION_BPS ?? "5000",
);
// Below this APY, staking is not worth the risk of holding LST: the yield stops covering the
// slashing exposure and the cost of eventually exiting. The yield varies during the run (issue #38
// phase 2), so this is a live decision rather than a one-time one -- an agent that ignores it
// simply stakes through the lean stretches and collects the downside for nothing.
const MIN_STAKE_APY_BPS = Number(
  process.env.ERIS_LST_MIN_STAKE_APY_BPS ?? "200",
);
const SLIPPAGE_BPS = Number(process.env.ERIS_LST_SLIPPAGE_BPS ?? "50");
// Cost of acquiring the WETH this venue is denominated in: one AMM fee plus the slippage of the
// buy. Funding is USDC-only in every official regime (ADR 0017 §4), so a strategy that will not
// buy its own exposure simply never trades -- and "I was not handed inventory" is not a market
// judgement. What is a judgement is whether the venue is worth paying the entry for.
const ENTRY_COST_BPS = Number(process.env.ERIS_LST_ENTRY_COST_BPS ?? "35");
// Share of the USDC budget to convert on entry. Half, not all: the rest stays as the numéraire the
// score is denominated in, so a wrong entry is a position rather than the whole book.
const ENTRY_BPS = Number(process.env.ERIS_LST_ENTRY_BPS ?? "5000");
// Leveraged staking (issue #38 phase 3): post LST as Aave collateral, borrow WETH against it, stake
// that too. Off by default -- it multiplies the yield and the slashing exposure in equal measure,
// and the LST's Aave price follows the vault a block late, so a slash reaches the health factor
// after it reaches the position. Opt in with ERIS_LST_LEVERAGE_TARGET_HF.
const LEVERAGE_TARGET_HF = Number(
  process.env.ERIS_LST_LEVERAGE_TARGET_HF ?? "0",
);
// Never borrow the health factor below this, whatever the target says: liquidation costs the
// bonus (7.5%) on the seized collateral, which is worth many runs of yield.
const LEVERAGE_MIN_HF = Number(process.env.ERIS_LST_LEVERAGE_MIN_HF ?? "1.6");
// Only borrow when the health factor is this multiple above the target, so one turn of the loop
// does not immediately need undoing.
const LEVERAGE_BORROW_BAND = Number(
  process.env.ERIS_LST_LEVERAGE_BORROW_BAND ?? "1.25",
);
// Dust floor: below this, an action costs more in gas than it can earn.
const MIN_ACTION_WEI = 10n ** 15n; // 0.001 WETH

/// Aave's health factor as a readable number, or -1 when there is no debt (it reports a sentinel
/// near uint256 max, which does not survive a plain Number()).
function hfForLog(raw: string | undefined): number {
  if (raw === undefined) return -1;
  const hf = BigInt(raw);
  return hf > 10n ** 30n ? -1 : Number(hf / 10n ** 14n) / 1e4;
}

function minBI(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function fraction(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.max(0, Math.round(bps)))) / 10_000n;
}

/// Whether a redemption queued now would finalize with room to spare before the run ends. When the
/// run has no block limit the queue is always reachable.
///
/// Takes the *effective* wait, not the vault's floor: once the queue is rate-limited (issue #38
/// phase 2) the wait grows with what is already queued ahead and with the size being redeemed, so
/// a decision made against the floor would queue exits that cannot finish.
export function queueFitsInRun(
  blocksRemaining: number | undefined,
  queueDelayBlocks: number,
): boolean {
  if (blocksRemaining === undefined) return true;
  return blocksRemaining > queueDelayBlocks + QUEUE_MARGIN_BLOCKS;
}

/// How much of a share balance is worth queueing right now.
///
/// The queue drains at a fixed rate, so a large position cannot all finalize before the run ends
/// even when a small one could. Queueing the whole thing anyway leaves the overflow stranded (it
/// scores as unrealizable), and refusing to queue at all forfeits the part that would have made it.
/// So take the slice that fits: partial exits are what a real staker does against a busy queue.
export function queueableShares(
  input: {
    lst: LstObservation;
    blocksRemaining: number | undefined;
  },
  shares: bigint,
): bigint {
  const throughput = BigInt(input.lst.queueThroughputWeiPerBlock ?? "0");
  const redemptionValue = BigInt(input.lst.lstRedemptionValueWethWei);
  if (
    throughput <= 0n ||
    input.blocksRemaining === undefined ||
    redemptionValue <= 0n
  ) {
    return shares;
  }
  // Blocks left for draining once the wait *and* the safety margin are paid for. The wait has to
  // be the marginal one the vault is quoting right now (floor plus whatever is booked ahead), not
  // the advertised floor: with the queue already booked out, sizing off the floor queues more than
  // can finalize -- precisely the stranded-WETH loss this function exists to prevent. decideCarry
  // already uses the quoted wait for the fit check; the two must not disagree.
  const marginalWait =
    input.lst.queueDelayPerWethBlocks ?? input.lst.withdrawalDelayBlocks;
  const drainBlocks =
    input.blocksRemaining - marginalWait - QUEUE_MARGIN_BLOCKS;
  if (drainBlocks <= 0) return 0n;
  const affordableAssets = BigInt(drainBlocks) * throughput;
  if (affordableAssets >= redemptionValue) return shares;
  return (shares * affordableAssets) / redemptionValue;
}

/// The decision, split out from the observation plumbing so it can be reasoned about (and tested)
/// on its own.
export type CarryDecision =
  | { kind: "claim" }
  | { kind: "carry"; wethIn: bigint }
  | { kind: "queue"; lstIn: bigint }
  | { kind: "harvest"; lstIn: bigint }
  | { kind: "stake"; wethIn: bigint }
  // Phase 3 leverage: post LST as collateral, borrow WETH against it, unwind when the health
  // factor gets close.
  | { kind: "collateralize"; lstIn: bigint }
  | { kind: "borrow"; wethOut: bigint }
  | { kind: "deleverage"; wethIn: bigint }
  | { kind: "hold"; reason: string };

/// The leverage leg (issue #38 phase 3), kept separate because it is opt-in and reads a different
/// part of the observation -- Aave's account state -- from everything else here.
///
/// The loop is stake -> post -> borrow -> stake. Each turn buys more yield and more slashing
/// exposure, so it is bounded by a target health factor rather than run to the LTV ceiling.
/// Unwinding comes first and unconditionally: a health factor under the floor is worth more than
/// any yield, because liquidation hands over the bonus on top of the debt.
export function decideLeverage(input: {
  lst: LstObservation;
  // Whether the spot path has a premium worth selling into; leverage yields to it.
  premiumWorthHarvesting?: boolean;
  aave:
    | {
        healthFactor: string;
        availableBorrowsBase: string;
        totalDebtBase: string;
      }
    | undefined;
  wethBalanceWei: bigint;
  fairPriceUsd: number;
}): CarryDecision | null {
  if (LEVERAGE_TARGET_HF <= 0) return null; // opt-in
  if (!input.lst.aaveCollateral || !input.aave) return null;
  // Finalized WETH in the queue and a market paying above par are both free, and neither has
  // anything to do with the loop. Posting collateral unconditionally in front of them made them
  // unreachable for a levered agent, which holds LST continuously by construction: claimable WETH
  // sat in the queue untouched for the rest of the run.
  if (BigInt(input.lst.claimableWithdrawalWethWei) > 0n) return null;
  if (input.premiumWorthHarvesting) return null;
  const lstBalance = BigInt(input.lst.lstBalanceWei);
  const hfRaw = BigInt(input.aave.healthFactor);
  // Aave reports a sentinel near uint256 max when there is no debt at all.
  const hasDebt = hfRaw < 10n ** 30n;
  const hf = hasDebt
    ? Number(hfRaw) / Number(10n ** 18n)
    : Number.POSITIVE_INFINITY;

  // 1. Too close to liquidation: repay before anything else.
  if (hf < LEVERAGE_MIN_HF && input.wethBalanceWei >= MIN_ACTION_WEI) {
    return { kind: "deleverage", wethIn: input.wethBalanceWei };
  }
  // 2. Unposted LST earns yield but supports no borrowing. Post it.
  if (lstBalance >= MIN_ACTION_WEI) {
    return { kind: "collateralize", lstIn: lstBalance };
  }
  // 3. Borrowed WETH is not leverage until it is staked and posted again. Hand back to the spot
  //    decisions while there is WETH in hand: borrowing on top of an unstaked balance piles debt
  //    against collateral that never grew (measured as 38 borrows against 18 forced repayments,
  //    oscillating 1.16 <-> 2.14).
  if (input.wethBalanceWei >= MIN_ACTION_WEI) return null;
  // 4. Borrow against what is posted, sized to land *on* the target rather than past it.
  //
  //    Health factor is collateral x LT / debt, so scaling the existing debt by hf/target puts the
  //    position exactly at the target. Sizing off the headroom instead overshoots: measured as 24
  //    borrows against 22 forced repayments, oscillating 2.89 <-> 1.56, because each borrow blew
  //    straight through the target and the floor beneath it. With no debt yet there is nothing to
  //    scale from, so the first turn takes half the headroom and the next turn corrects.
  if (
    hf > LEVERAGE_TARGET_HF * LEVERAGE_BORROW_BAND &&
    input.fairPriceUsd > 0
  ) {
    const availableUsd = Number(BigInt(input.aave.availableBorrowsBase)) / 1e8;
    const debtUsd = Number(BigInt(input.aave.totalDebtBase)) / 1e8;
    const borrowUsd = hasDebt
      ? Math.min(debtUsd * (hf / LEVERAGE_TARGET_HF - 1), availableUsd)
      : availableUsd * 0.5;
    const wethOut = BigInt(
      Math.floor((borrowUsd / input.fairPriceUsd) * 1e18),
    );
    if (wethOut >= MIN_ACTION_WEI) return { kind: "borrow", wethOut };
  }
  return null;
}

// ---------------------------------------------------------------------------
// entry: buying the WETH this venue is denominated in
//
// Funding is USDC-only in every official regime, so the venue is unreachable until the agent buys
// its way in. That is a trade with a price -- one AMM fee plus slippage -- and it is only worth
// paying when the LST side offers more than it costs. Two things can pay for it:
//
//   the discount   the pool is selling LST below what the vault owes, and the gap is wider than the
//                  cost of getting in and back out again.
//   the yield      staking pays yieldPerBlockBps for as long as the run has left. Over a short
//                  horizon that is a few basis points and cannot cover an entry; over a long one it
//                  can. Without a horizon the run length is unknown, so the yield is not counted.
//
// Neither is a reason to convert the whole book: ENTRY_BPS leaves the rest in the numéraire the
// score is denominated in, so a wrong entry is a position rather than the run.

type EntryVenue = { swapType: "swap" | "balancerSwap" | "curveSwap"; price: number };

function cheapestWethVenue(obs: AgentObservation): EntryVenue | null {
  const p = obs.protocols ?? {};
  const venues: EntryVenue[] = [];
  if (p.uniswap?.pool)
    venues.push({ swapType: "swap", price: p.uniswap.pool.priceUsdcPerWeth });
  if (p.balancer)
    venues.push({ swapType: "balancerSwap", price: p.balancer.priceUsdcPerWeth });
  if (p.curve)
    venues.push({ swapType: "curveSwap", price: p.curve.priceUsdcPerWeth });
  let best: EntryVenue | null = null;
  for (const v of venues) {
    if (!Number.isFinite(v.price) || v.price <= 0) continue;
    if (best === null || v.price < best.price) best = v;
  }
  return best;
}

export function decideEntry(
  obs: AgentObservation,
  lst: LstObservation,
): { action: AgentAction; reason: string } {
  // The discount is only actionable if the pool answered; an unquoted market is par by fallback and
  // must not be read as "the peg held" (issue #27's discipline applies here too).
  const discountBps = lst.marketQuoted === false ? 0 : -lst.discountBps;
  const blocksRemaining = obs.blocksRemaining;
  const yieldBps =
    blocksRemaining === undefined
      ? 0
      : lst.yieldPerBlockBps * blocksRemaining;

  // Two paths in, and they do not cost the same. Staking mints at the vault's par and the scorer
  // marks the position at par too, so holding to the end never touches the pool: the only cost is
  // buying the WETH. Buying the LST cheap on the secondary market does touch it, twice, so it pays
  // the pool cost and the noise margin on top. Charging the pool round trip to the stake path was
  // wrong, and it was the difference between a hurdle the yield can clear and one it cannot.
  const stakeHurdle = ENTRY_COST_BPS;
  const discountHurdle = ENTRY_COST_BPS + POOL_COST_BPS + SAFETY_BPS;
  const worthIt = discountBps > discountHurdle || yieldBps > stakeHurdle;
  if (!worthIt)
    return {
      action: {
        type: "noop",
        reason: `buying in costs ${ENTRY_COST_BPS.toFixed(0)}bps: the yield left is ${yieldBps.toFixed(1)}bps against that, and the discount is ${discountBps.toFixed(1)}bps against ${discountHurdle.toFixed(0)}bps — neither pays for the entry`,
      },
      reason: "no WETH: the venue is not offering enough to pay for buying in",
    };

  const venue = cheapestWethVenue(obs);
  if (venue === null)
    return {
      action: {
        type: "noop",
        reason: "no WETH and no AMM venue quoting a price to buy it on",
      },
      reason: "no WETH and nowhere to buy it",
    };

  const budget = BigInt(obs.balances.usdcUnits || "0");
  const amountIn = (budget * BigInt(ENTRY_BPS)) / 10_000n;
  if (amountIn === 0n)
    return {
      action: { type: "noop", reason: "no USDC to buy the entry with" },
      reason: "no WETH and no USDC to buy it with",
    };

  return {
    action: {
      type: venue.swapType,
      tokenIn: "USDC",
      amountIn: amountIn.toString(),
      maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
      slippageBps: SLIPPAGE_BPS,
    },
    reason:
      discountBps > discountHurdle
        ? `buying in: the LST is ${discountBps.toFixed(1)}bps below par against a ${discountHurdle.toFixed(0)}bps round trip`
        : `buying in: ${yieldBps.toFixed(1)}bps of yield left over ${blocksRemaining} blocks against a ${stakeHurdle.toFixed(0)}bps entry`,
  };
}

export function decideCarry(input: {
  lst: LstObservation;
  wethBalanceWei: bigint;
  maxStakeWei: bigint;
  maxSwapWei: bigint;
  blocksRemaining: number | undefined;
}): CarryDecision {
  const { lst } = input;
  const lstBalance = BigInt(lst.lstBalanceWei);
  const claimable = BigInt(lst.claimableWithdrawalWethWei);

  // 1. Anything already finalized is free to take, and leaving it queued earns nothing.
  if (claimable > 0n) return { kind: "claim" };

  // Is the queue open at all? Judged on a *marginal* exit rather than on liquidating the whole
  // position: how much of the position fits is a sizing question, handled by queueableShares. The
  // two differ once a balance grows past what the queue can drain in the time left, and conflating
  // them shuts the venue down early -- measured as the last 38 blocks of a run spent holding.
  const queueDelay = lst.estimatedQueueDelayBlocks ?? lst.withdrawalDelayBlocks;
  const marginalDelay = lst.queueDelayPerWethBlocks ?? queueDelay;
  const canQueue = queueFitsInRun(input.blocksRemaining, marginalDelay);
  // No quote means no tradable market, whatever discountBps says. Every branch below that touches
  // the pool is gated on this.
  const quoted = lst.marketQuoted !== false;
  const edgeBps = quoted
    ? lst.discountBps - POOL_COST_BPS - SAFETY_BPS
    : Number.NEGATIVE_INFINITY;

  // 2. Close out what you already hold before buying more. The carry is buy-then-redeem, and it is
  //    the redemption that turns the discount into WETH you can trade again -- so queueing comes
  //    first, otherwise the agent just keeps buying until the discount closes and never collects
  //    (measured: five buys, no redemption, the whole edge left on the table as an open position).
  //
  //    Gated on the *same* edge as the buy, not a looser one. With a looser gate the agent also
  //    queues its staked position the moment the market drifts below par at all -- which in a live
  //    run became stake -> queue -> stake churn and left 14 WETH in a queue that outlived the run.
  //    Below this level, holding and earning the yield is the better trade.
  if (canQueue && lstBalance >= MIN_ACTION_WEI && edgeBps > 0) {
    const lstIn = queueableShares(input, lstBalance);
    if (lstIn >= MIN_ACTION_WEI) return { kind: "queue", lstIn };
  }

  // 3. The market is cheap enough to buy and redeem at par -- the carry this agent is named for.
  //    Only while the queue still fits: past that point the discount is not recoverable.
  if (canQueue && edgeBps > 0 && input.wethBalanceWei > 0n) {
    const size = minBI(
      minBI(
        fraction(input.wethBalanceWei, CARRY_FRACTION_BPS),
        input.maxSwapWei,
      ),
      input.wethBalanceWei,
    );
    if (size >= MIN_ACTION_WEI) return { kind: "carry", wethIn: size };
  }

  // 4. The mirror image: the market is paying above redemption, so sell into it instead of
  //    queueing. (discountBps < 0 is a premium.)
  if (
    quoted &&
    lstBalance >= MIN_ACTION_WEI &&
    -lst.discountBps > POOL_COST_BPS + SAFETY_BPS
  ) {
    const size = minBI(lstBalance, input.maxSwapWei);
    if (size >= MIN_ACTION_WEI) return { kind: "harvest", lstIn: size };
  }

  // 5. No dislocation to trade, so earn the yield -- if it is worth earning, and if an exit can
  //    still be queued. Staking into the last blocks of a run buys yield you cannot collect and an
  //    exit that has to pay the pool's discount; staking through a lean stretch collects the
  //    slashing exposure without being paid for it.
  const yieldWorthIt = lst.apyBps >= MIN_STAKE_APY_BPS;
  if (
    canQueue &&
    yieldWorthIt &&
    input.wethBalanceWei > 0n &&
    lst.yieldPerBlockBps > 0
  ) {
    // Measured against the whole WETH-denominated book, so once the target is reached this stops
    // firing instead of nibbling at the remaining balance forever.
    const staked =
      BigInt(lst.lstRedemptionValueWethWei) +
      BigInt(lst.pendingWithdrawalWethWei);
    const book = input.wethBalanceWei + staked;
    // With the leverage loop on, holding a WETH buffer defeats the point: the loop only turns when
    // borrowed WETH is staked and re-posted. Measured with the 70% target: ten stake/post pairs
    // and not a single borrow.
    const target = fraction(
      book,
      LEVERAGE_TARGET_HF > 0 ? 10_000 : STAKE_TARGET_BPS,
    );
    if (target > staked + fraction(book, STAKE_REBALANCE_BAND_BPS)) {
      const size = minBI(
        minBI(target - staked, input.maxStakeWei),
        input.wethBalanceWei,
      );
      if (size >= MIN_ACTION_WEI) return { kind: "stake", wethIn: size };
    }
  }

  if (!canQueue && lstBalance > 0n) {
    // Late in the run, holding beats selling: scoring already marks the shares at what the pool
    // would pay, so an exit here just donates the fee.
    return {
      kind: "hold",
      reason: `queue no longer fits in the run (${input.blocksRemaining ?? "?"} blocks left, a marginal exit needs ${marginalDelay + QUEUE_MARGIN_BLOCKS} at the current congestion, this whole position ${queueDelay}); holding, since selling only pays the pool fee`,
    };
  }
  if (!yieldWorthIt && input.wethBalanceWei > 0n) {
    return {
      kind: "hold",
      reason: `yield ${lst.apyBps.toFixed(0)}bps is below the ${MIN_STAKE_APY_BPS}bps floor; holding WETH rather than taking slashing exposure for it`,
    };
  }
  return {
    kind: "hold",
    reason: `discount ${lst.discountBps.toFixed(1)}bps does not clear cost ${POOL_COST_BPS + SAFETY_BPS}bps`,
  };
}

export function decide(
  obs: AgentObservation,
  ctx?: AgentContext,
): AgentAction | Record<string, unknown> | null {
  const lst = obs.protocols.lst;
  if (!lst) {
    return { type: "noop", reason: "the lst venue is not enabled this run" };
  }
  const wethBalanceWei = BigInt(obs.balances.wethWei || "0");
  // Empty hands are only a dead end if there is nothing posted either. A levered position holds
  // its whole book as Aave collateral, so checking the wallet alone reads that as "this venue is
  // unusable" -- and because this return happens before the decision log, a run doing exactly that
  // looks like an agent that stopped responding. It cost an afternoon of misdiagnosis.
  const collateralBase = BigInt(obs.protocols.aave?.totalCollateralBase ?? "0");
  const queued =
    BigInt(lst.pendingWithdrawalWethWei) +
    BigInt(lst.claimableWithdrawalWethWei);
  if (
    wethBalanceWei === 0n &&
    BigInt(lst.lstBalanceWei) === 0n &&
    collateralBase === 0n &&
    queued === 0n
  ) {
    // This venue is denominated in WETH and the wallet holds none. Buy it, when the venue is
    // offering enough to cover what buying costs -- see decideEntry.
    const entry = decideEntry(obs, lst);
    ctx?.log({
      round: obs.round,
      reason: entry.reason,
      signals: {
        discountBps: lst.discountBps,
        apyBps: lst.apyBps,
        blocksRemaining: obs.blocksRemaining,
      },
    });
    return entry.action;
  }

  // Leverage first when it is switched on: an unhealthy borrow outranks any trade, and posting
  // collateral is what makes the loop turn. Falls through to the spot decisions otherwise.
  const decision =
    decideLeverage({
      lst,
      aave: obs.protocols.aave,
      wethBalanceWei,
      fairPriceUsd: obs.fairPriceUsdcPerWeth,
      premiumWorthHarvesting:
        lst.marketQuoted !== false &&
        BigInt(lst.lstBalanceWei) >= MIN_ACTION_WEI &&
        -lst.discountBps > POOL_COST_BPS + SAFETY_BPS,
    }) ??
    decideCarry({
      lst,
      wethBalanceWei,
      // Balance-bound on both sides: neither the stake nor the secondary-market swap has a
      // configured cap any more, so the carry sizes itself against what it actually holds.
      maxStakeWei: wethBalanceWei,
      maxSwapWei: wethBalanceWei,
      blocksRemaining: obs.blocksRemaining,
    });
  const fee = obs.limits.defaultPriorityFeePerGasWei;

  // Record why, every cycle. A rule agent's noop leaves no trace on chain and none in the mempool
  // log, so without this a run where the agent correctly sat out is indistinguishable from one
  // where it was broken -- and phase 2 is full of reasons to correctly sit out.
  ctx?.log({
    round: obs.round,
    reason: decision.kind === "hold" ? decision.reason : decision.kind,
    signals: {
      discountBps: Number(lst.discountBps.toFixed(2)),
      apyBps: Number(lst.apyBps.toFixed(0)),
      queueDelayBlocks: lst.estimatedQueueDelayBlocks,
      blocksRemaining: obs.blocksRemaining ?? -1,
      // 1e18 fixed point; Aave's no-debt sentinel is astronomically large, so it is reported as -1.
      healthFactor: hfForLog(obs.protocols.aave?.healthFactor),
    },
  });

  switch (decision.kind) {
    case "claim":
      return { type: "lstClaimWithdraw", maxPriorityFeePerGasWei: fee };
    case "carry":
      return {
        type: "lstSwap",
        tokenIn: "WETH",
        amountIn: decision.wethIn.toString(),
        slippageBps: SLIPPAGE_BPS,
        maxPriorityFeePerGasWei: fee,
      };
    case "queue":
      return {
        type: "lstRequestWithdraw",
        amountLstWei: decision.lstIn.toString(),
        maxPriorityFeePerGasWei: fee,
      };
    case "harvest":
      return {
        type: "lstSwap",
        tokenIn: "LST",
        amountIn: decision.lstIn.toString(),
        slippageBps: SLIPPAGE_BPS,
        maxPriorityFeePerGasWei: fee,
      };
    case "stake":
      return {
        type: "lstDeposit",
        amountWethWei: decision.wethIn.toString(),
        maxPriorityFeePerGasWei: fee,
      };
    case "collateralize":
      return {
        type: "aaveSupply",
        asset: "LST",
        amount: decision.lstIn.toString(),
        maxPriorityFeePerGasWei: fee,
      };
    case "borrow":
      return {
        type: "aaveBorrow",
        asset: "WETH",
        amount: decision.wethOut.toString(),
        maxPriorityFeePerGasWei: fee,
      };
    case "deleverage":
      return {
        type: "aaveRepay",
        asset: "WETH",
        amount: decision.wethIn.toString(),
        maxPriorityFeePerGasWei: fee,
      };
    default:
      return { type: "noop", reason: decision.reason };
  }
}
