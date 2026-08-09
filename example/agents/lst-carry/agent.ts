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
// Dust floor: below this, an action costs more in gas than it can earn.
const MIN_ACTION_WEI = 10n ** 15n; // 0.001 WETH

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
  // Blocks left for draining once the floor and the safety margin are paid for.
  const drainBlocks =
    input.blocksRemaining -
    input.lst.withdrawalDelayBlocks -
    QUEUE_MARGIN_BLOCKS;
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
  | { kind: "hold"; reason: string };

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
  const edgeBps = lst.discountBps - POOL_COST_BPS - SAFETY_BPS;

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
    const target = fraction(book, STAKE_TARGET_BPS);
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
  if (wethBalanceWei === 0n && BigInt(lst.lstBalanceWei) === 0n) {
    // This venue is denominated in WETH. A USDC-only funding profile leaves nothing to work with,
    // which is a configuration mismatch rather than a market judgement -- say so plainly.
    return {
      type: "noop",
      reason:
        "no WETH and no LST: the lst venue is WETH-denominated, so this run needs funding.wethWei > 0",
    };
  }

  const decision = decideCarry({
    lst,
    wethBalanceWei,
    maxStakeWei:
      BigInt(obs.limits.maxLstDepositWethWei ?? "0") || wethBalanceWei,
    maxSwapWei: BigInt(obs.limits.maxWethInWei) || wethBalanceWei,
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
    default:
      return { type: "noop", reason: decision.reason };
  }
}
