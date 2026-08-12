// Liquity venue: the environment's side of the CDP stablecoin (issue #39).
//
// Two jobs, and they are the two things about this venue that cannot live in the adapter.
//
// *The oracle.* Liquity renounces ownership once wired, so the price feed address baked into
// TroveManager is permanent -- while this environment deploys a fresh PriceFeed every run. The
// LiquityPriceFeedAdapter sits between them and each run points it at its own feed. Until that
// happens the venue marks collateral at the price it was deployed with, which would silently make
// every ratio in the observation fiction, so the setup below refuses to start without it.
//
// *The peg.* eUSD trades against USDC on the stableswap pool the deploy seeded at par, and at par
// there is nothing to trade: redemption arb only exists when the market has moved away from the $1
// the protocol will always redeem at. `eusdDepeg` is the stress event that puts it there -- the
// environment sells eUSD into the pool for the length of a window and buys it back afterwards, the
// same reconcile-to-a-target shape as the liquidity pull (issue #52) and for the same reason: the
// coordinator drops block notifications while it is busy, so a state that is re-derived every block
// costs a block of lag where a one-shot would strand the pool.
import { encodeFunctionData, maxUint256, type Address, type Hex } from "viem";
import {
  curveStableSwapNgAbi,
  erc20Abi,
  troveManagerAbi,
} from "@eris/sdk/abis.js";
import { accountAddress, sendAndMine, sendNoMine } from "@eris/sdk/chain.js";
import { liquityPriceFeedAdapterAbi } from "@eris/sdk/abis.js";
import { LIQUITY, requireEusdMarket } from "@eris/sdk/constants.js";
import {
  getLiquityState,
  type LiquityState,
} from "@eris/sdk/protocols/liquity.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import type { RunLogger } from "../logger.js";
import type { EventSchedule } from "./events.js";

// How far the oracle the venue serves may sit from the run's fair price before the run refuses to
// start. This is not calibration noise: either the adapter points at this run's PriceFeed or it does
// not, and if it does not, every Trove is marked against a price from another run entirely.
const ORACLE_TOLERANCE_BPS = 100;

// The eUSD market is seeded at par by the deploy, so a gap this large at startup means the pool is
// not the one the deployment thinks it is (or the run inherited a chain a previous run left
// depegged). Either way the redemption arb would open as a freebie for whoever looks first.
export const LIQUITY_STARTUP_WARN_BPS = 25;
export const LIQUITY_STARTUP_FAIL_BPS = 200;

// Swaps against a stableswap pool are a fixed shape; pinning the gas skips an eth_estimateGas (a
// whole extra EVM execution) on a transaction the environment may send every block of a window.
const DEPEG_GAS = 600_000n;

// Slippage bound on the environment's own depeg trades. It is not being protected from a bad price
// -- moving the price is the point -- only from a pathological fill.
const DEPEG_SLIPPAGE_BPS = 500n;

// Deltas below this fraction of the pool's seeded eUSD depth are rounding, not schedule. Closing the
// window is exempt: leaving the peg broken would hand the rest of the run a different venue.
const MIN_DELTA_BPS = 50n;

// Blocks to wait for a submitted swap before treating it as lost. Under interval mining a
// transaction lands on the next block, so this is slack for a busy block rather than a normal path.
const PENDING_TIMEOUT_BLOCKS = 3;

export type LiquityRuntime = {
  troveManager: Address;
  priceFeedAdapter: Address;
  // Whether the environment's admin key could repoint the oracle. False means the run is marking
  // against whatever the adapter already served, which the setup refuses -- kept for the log.
  oracleRepointed: boolean;
};

/// Point Liquity's permanent oracle at this run's PriceFeed, then refuse to start on a venue that
/// would trade against the wrong price or a peg that is already broken.
export async function setupLiquity(
  ctx: SimContext,
  opts: { priceFeed: Address; fairPrice: number },
  logger: RunLogger,
): Promise<LiquityRuntime> {
  if (!LIQUITY) {
    throw new Error(
      "the liquity protocol is enabled but no Liquity deployment is available: the venue exists " +
        "only under local deploy (issue #39). Enable run.localDeploy with a state dump that " +
        "includes liquity, or drop liquity from run.protocols.",
    );
  }
  const admin = accountAddress(ctx.adminPk);
  const operator = (await ctx.publicClient.readContract({
    address: LIQUITY.priceFeed,
    abi: liquityPriceFeedAdapterAbi,
    functionName: "operator",
  })) as Address;
  if (operator.toLowerCase() !== admin.toLowerCase()) {
    // Without the operator key the oracle keeps serving whatever it last served. Liquity would still
    // run -- it never reverts on a stale price, by design -- and every ICR, TCR and liquidation in
    // the run would be computed against a price this run never set.
    throw new Error(
      `the Liquity oracle adapter (${LIQUITY.priceFeed}) is owned by ${operator}, but this run's ` +
        `admin key is ${admin}, so the venue cannot be pointed at this run's PriceFeed. It would ` +
        "mark every Trove against the price baked in at deploy time (deployer/contracts/LiquityPriceFeedAdapter.sol).",
    );
  }
  await sendAndMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: LIQUITY.priceFeed,
      data: encodeFunctionData({
        abi: liquityPriceFeedAdapterAbi,
        functionName: "setSource",
        args: [opts.priceFeed],
      }),
    },
  );

  // What the venue would actually serve now. Simulated rather than read: `fetchPrice` caches, so
  // `lastGoodPrice` only tells us what some earlier transaction saw.
  const served = (
    await ctx.publicClient.simulateContract({
      account: admin,
      address: LIQUITY.priceFeed,
      abi: liquityPriceFeedAdapterAbi,
      functionName: "fetchPrice",
    })
  ).result as bigint;
  const servedUsd = Number(served) / 1e18;
  const driftBps =
    opts.fairPrice > 0
      ? Math.abs((servedUsd - opts.fairPrice) / opts.fairPrice) * 10_000
      : 10_000;
  if (driftBps > ORACLE_TOLERANCE_BPS) {
    throw new Error(
      `the Liquity oracle serves ${servedUsd.toFixed(2)} USD/ETH while this run's fair price is ` +
        `${opts.fairPrice.toFixed(2)} (${driftBps.toFixed(0)}bps apart, limit ${ORACLE_TOLERANCE_BPS}). ` +
        `The adapter was pointed at ${opts.priceFeed}; a gap here means it is not reading it.`,
    );
  }

  const state = await getLiquityState(ctx, opts.fairPrice);
  logger.event({
    type: "liquity_setup",
    troveManager: LIQUITY.troveManager,
    eusd: LIQUITY.eusd,
    market: LIQUITY.eusdUsdcPool ?? null,
    priceFeed: opts.priceFeed,
    oracleServedUsd: servedUsd,
    oracleDriftBps: Number(driftBps.toFixed(2)),
    tcr: state.tcr,
    recoveryMode: state.recoveryMode,
    troveCount: state.troveCount,
    totalDebtEusdWei: state.totalDebtEusdWei.toString(),
    borrowingRateBps: state.borrowingRateBps,
    redemptionRateBps: state.redemptionRateBps,
    stabilityPoolEusdWei: state.spTotalDepositsEusdWei.toString(),
    marketPriceUsdc: state.midPriceUsdc,
    marketQuoted: state.marketQuoted,
    discountBps: state.discountBps,
  });

  // Recovery Mode at block zero would make the whole run about the seeded Troves rather than about
  // the agents: borrowing is restricted and everything under CCR is liquidatable from the start.
  if (state.recoveryMode) {
    throw new Error(
      `the Liquity system opens in Recovery Mode (TCR ${state.tcr.toFixed(3)} < CCR ${state.ccr}). ` +
        "The genesis Trove is calibrated against the deploy-time price, so this usually means the " +
        "run's fair price is far below it (deployer/src/protocols/liquity.ts GENESIS_PRICE_USD).",
    );
  }
  if (state.market && !state.marketQuoted) {
    throw new Error(
      "the eUSD/USDC pool did not quote at startup: it reverted or has no liquidity at probe size. " +
        "Check that the deploy seeded it (deployer/src/protocols/liquity.ts seedEusdPool).",
    );
  }
  const absDiscount = Math.abs(state.discountBps);
  if (absDiscount > LIQUITY_STARTUP_FAIL_BPS) {
    throw new Error(
      `liquity no-arbitrage check failed at startup: eUSD trades ${state.discountBps.toFixed(1)}bps ` +
        `off par (limit ${LIQUITY_STARTUP_FAIL_BPS}bps). The pool is seeded at par, so this is a ` +
        "dirty chain or a mis-deploy, and it would open as a risk-free redemption for whoever looks first.",
    );
  }
  if (absDiscount > LIQUITY_STARTUP_WARN_BPS) {
    console.warn(
      `[liquity] eUSD opens ${state.discountBps.toFixed(1)}bps off par (warn above ${LIQUITY_STARTUP_WARN_BPS}bps)`,
    );
  }

  return {
    troveManager: LIQUITY.troveManager,
    priceFeedAdapter: LIQUITY.priceFeed,
    oracleRepointed: true,
  };
}

/// Per-block telemetry. Cheap (the coordinator already reads this state) and the primary post-run
/// source for whether the venue behaved: where the peg sat, how the fee curve moved, and whether the
/// system ever went into Recovery Mode.
export function liquityBlockEvent(
  state: LiquityState,
  blockNumber: number,
): Record<string, unknown> {
  return {
    type: "liquity_block",
    blockNumber,
    priceUsd: state.priceUsd,
    tcr: state.tcr,
    recoveryMode: state.recoveryMode,
    troveCount: state.troveCount,
    totalDebtEusdWei: state.totalDebtEusdWei.toString(),
    marketPriceUsdc: state.midPriceUsdc,
    discountBps: state.discountBps,
    redemptionRateBps: state.redemptionRateBps,
    borrowingRateBps: state.borrowingRateBps,
    stabilityPoolEusdWei: state.spTotalDepositsEusdWei.toString(),
    riskiestIcr: state.troves[0]?.icr ?? null,
  };
}

/// What the venue actually did in a range of blocks, from its own logs.
///
/// The block telemetry above can only say that a Trove disappeared; it cannot say whether it was
/// closed, redeemed away or liquidated. Issue #39's open question -- whether Liquity's ordering
/// sensitivity needs special handling in an environment that rewrites the oracle every block ahead
/// of every agent -- is a question about liquidations specifically, so it has to be counted rather
/// than inferred.
///
/// Scanned over a range because the coordinator drops block notifications while it is busy, the same
/// reason every other catch-up consumer here takes fromBlock..toBlock.
export async function watchLiquityEvents(
  ctx: SimContext,
  fromBlock: number,
  toBlock: number,
  logger: RunLogger,
): Promise<void> {
  if (!LIQUITY || fromBlock > toBlock) return;
  const range = {
    address: LIQUITY.troveManager,
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
  } as const;
  const [liquidated, redeemed] = await Promise.all([
    ctx.publicClient.getLogs({
      ...range,
      event: troveManagerAbi.find(
        (e) => e.type === "event" && e.name === "TroveLiquidated",
      ) as never,
      strict: false,
    }),
    ctx.publicClient.getLogs({
      ...range,
      event: troveManagerAbi.find(
        (e) => e.type === "event" && e.name === "Redemption",
      ) as never,
      strict: false,
    }),
  ]);
  for (const raw of liquidated) {
    const log = raw as unknown as {
      args?: Record<string, unknown>;
      blockNumber?: bigint;
      transactionHash?: string;
    };
    const args = log.args ?? {};
    logger.event({
      type: "liquity_liquidation",
      blockNumber: Number(log.blockNumber ?? 0n),
      borrower: String(args._borrower ?? ""),
      debtEusdWei: String(args._debt ?? ""),
      collWei: String(args._coll ?? ""),
      // Liquity's TroveManagerOperation: 0 = applyPendingRewards, 1 = liquidateInNormalMode,
      // 2 = liquidateInRecoveryMode, 3 = redeemCollateral. Which mode it was is the finding.
      operation: Number(args._operation ?? 0),
      txHash: log.transactionHash,
    });
  }
  for (const raw of redeemed) {
    const log = raw as unknown as {
      args?: Record<string, unknown>;
      blockNumber?: bigint;
      transactionHash?: string;
    };
    const args = log.args ?? {};
    logger.event({
      type: "liquity_redemption",
      blockNumber: Number(log.blockNumber ?? 0n),
      attemptedEusdWei: String(args._attemptedLUSDAmount ?? ""),
      actualEusdWei: String(args._actualLUSDAmount ?? ""),
      ethSentWei: String(args._ETHSent ?? ""),
      ethFeeWei: String(args._ETHFee ?? ""),
      txHash: log.transactionHash,
    });
  }
}

// ---------------------------------------------------------------------------
// eUSD depeg (the stress overlay's eusdDepeg, issue #39)
// ---------------------------------------------------------------------------

export type EusdDepegRuntime = {
  actor: Address;
  actorPk: Hex;
  pool: Address;
  eusdIndex: number;
  usdcIndex: number;
  eusd: Address;
  usdc: Address;
  // The pool's eUSD depth at run start. The event's magnitude is a fraction of this, so the same
  // config means the same imbalance whatever the deploy seeded.
  seededPoolEusdWei: bigint;
  // The actor's eUSD balance at run start, which bounds how far the peg can be pushed.
  startEusdWei: bigint;
  pending: { hash: Hex; blockIndex: number } | null;
  // Whether the inventory limit has already been reported. Once is enough; it is a calibration
  // finding, not a per-block event.
  cappedReported: boolean;
};

/// Stage the account that will move the peg, and record what it has to work with.
///
/// The actor is the deployer, which is where the genesis Trove's eUSD ended up (issue #39 phase 1:
/// LUSDToken has no admin mint, so every eUSD in existence came out of that Trove). It is not a
/// participant and is excluded from scoring, the same arrangement as the ADR 0009 stress victims.
export async function setupEusdDepeg(
  ctx: SimContext,
  opts: { localDeploy: boolean; actorPk: Hex },
  logger: RunLogger,
): Promise<EusdDepegRuntime> {
  if (!opts.localDeploy) {
    throw new Error(
      "stress event eusdDepeg requires run.localDeploy: the liquity venue and its eUSD market exist " +
        "only under local deploy (issue #39)",
    );
  }
  const market = requireEusdMarket();
  const l = LIQUITY!;
  const actor = accountAddress(opts.actorPk);

  const [poolEusd, actorEusd, actorUsdc] = (await Promise.all([
    ctx.publicClient.readContract({
      address: market.pool,
      abi: curveStableSwapNgAbi,
      functionName: "balances",
      args: [BigInt(market.eusdIndex)],
    }),
    ctx.publicClient.readContract({
      address: l.eusd,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [actor],
    }),
    ctx.publicClient.readContract({
      address: market.stable,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [actor],
    }),
  ])) as [bigint, bigint, bigint];

  if (actorEusd === 0n) {
    throw new Error(
      `stress event eusdDepeg has nothing to sell: the actor (${actor}) holds no eUSD. The deploy ` +
        "leaves the genesis Trove's surplus with the deployer account (deployer/src/protocols/liquity.ts), " +
        "so an empty balance means a different account deployed the venue, or a previous run spent it.",
    );
  }

  // The deploy approved the pool for exactly the amounts it seeded, so both legs need standing
  // approval before the window opens. Sequential: one key, one nonce.
  for (const token of [l.eusd, market.stable]) {
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      opts.actorPk,
      {
        to: token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [market.pool, maxUint256],
        }),
      },
    );
  }

  logger.event({
    type: "stress_eusd_depeg_setup",
    actor,
    pool: market.pool,
    poolEusdWei: poolEusd.toString(),
    actorEusdWei: actorEusd.toString(),
    actorUsdcUnits: actorUsdc.toString(),
    // What fraction of the pool the actor could sell at most. Below the configured magnitude the
    // window will simply be shallower than asked for, which the reconcile reports.
    maxFractionOfPool:
      poolEusd > 0n ? Number((actorEusd * 10_000n) / poolEusd) / 10_000 : 0,
  });

  return {
    actor,
    actorPk: opts.actorPk,
    pool: market.pool,
    eusdIndex: market.eusdIndex,
    usdcIndex: market.usdcIndex,
    eusd: l.eusd,
    usdc: market.stable,
    seededPoolEusdWei: poolEusd,
    startEusdWei: actorEusd,
    pending: null,
    cappedReported: false,
  };
}

/// Move the peg toward where the schedule wants it on this block.
///
/// Every decision is made against the eUSD the actor *actually* still holds, read back each block,
/// rather than against what was submitted: a swap can revert (slippage, an empty float, an agent
/// arriving first in the same block) and a target derived from an assumed fill would then be wrong
/// for the rest of the window.
export async function reconcileEusdDepeg(
  ctx: SimContext,
  runtime: EusdDepegRuntime,
  schedule: EventSchedule,
  blockIndex: number,
  blockNumber: number,
  opts: { priorityFeeWei: bigint },
  logger: RunLogger,
): Promise<Hex[]> {
  const fraction = schedule.eusdDepegFractionAt(blockIndex);

  if (runtime.pending) {
    const settled = await settlePending(ctx, runtime, blockIndex, logger);
    if (!settled) return [];
  }

  const balance = (await ctx.publicClient.readContract({
    address: runtime.eusd,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [runtime.actor],
  })) as bigint;
  const sold =
    runtime.startEusdWei > balance ? runtime.startEusdWei - balance : 0n;

  const asked =
    (runtime.seededPoolEusdWei * BigInt(Math.round(fraction * 1e9))) /
    1_000_000_000n;
  // Bounded by what the actor can still sell. A window that cannot reach its magnitude is a
  // calibration finding, so it is reported rather than silently delivering a shallower depeg.
  const target = asked > runtime.startEusdWei ? runtime.startEusdWei : asked;
  if (target < asked && !runtime.cappedReported) {
    runtime.cappedReported = true;
    logger.event({
      type: "stress_eusd_depeg_capped",
      blockIndex,
      askedEusdWei: asked.toString(),
      availableEusdWei: runtime.startEusdWei.toString(),
      note: "the depeg is shallower than the configured magnitude: the actor's eUSD ran out",
    });
  }

  if (target === sold) return [];
  const delta = target > sold ? target - sold : sold - target;
  const closing = target === 0n;
  if (
    !closing &&
    (delta * 10_000n) / (runtime.seededPoolEusdWei || 1n) < MIN_DELTA_BPS
  )
    return [];

  try {
    const call =
      target > sold
        ? await buildSell(ctx, runtime, delta)
        : await buildBuyBack(ctx, runtime, delta);
    if (!call) return [];
    const hash = await sendNoMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      runtime.actorPk,
      { to: call.to, data: call.data, gas: DEPEG_GAS },
      opts.priorityFeeWei,
    );
    runtime.pending = { hash, blockIndex };
    logger.event({
      type: "stress_eusd_depeg",
      blockIndex,
      blockNumber,
      direction: target > sold ? "sell" : "buyback",
      targetFraction: Number(fraction.toFixed(4)),
      targetSoldEusdWei: target.toString(),
      soldEusdWei: sold.toString(),
      deltaEusdWei: delta.toString(),
      hash,
    });
    return [hash];
  } catch (error) {
    // `sold` is re-derived from the chain next block, so a failed send costs one block of lag
    // rather than desynchronizing the window.
    logger.event({
      type: "stress_eusd_depeg_failed",
      blockIndex,
      blockNumber,
      targetSoldEusdWei: target.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function buildSell(
  ctx: SimContext,
  runtime: EusdDepegRuntime,
  amountEusd: bigint,
): Promise<{ to: Address; data: Hex } | null> {
  const quoted = (await ctx.publicClient.readContract({
    address: runtime.pool,
    abi: curveStableSwapNgAbi,
    functionName: "get_dy",
    args: [BigInt(runtime.eusdIndex), BigInt(runtime.usdcIndex), amountEusd],
  })) as bigint;
  if (quoted <= 0n) return null;
  return {
    to: runtime.pool,
    data: encodeFunctionData({
      abi: curveStableSwapNgAbi,
      functionName: "exchange",
      args: [
        BigInt(runtime.eusdIndex),
        BigInt(runtime.usdcIndex),
        amountEusd,
        (quoted * (10_000n - DEPEG_SLIPPAGE_BPS)) / 10_000n,
      ],
    }),
  };
}

/// The buy-back leg sizes on the *output*: the target is an amount of eUSD to take back off the
/// market, not an amount of USDC to spend, so it is get_dx rather than get_dy. Spending the USDC the
/// sale produced would come up short by exactly the round trip's cost and leave the peg permanently
/// a little broken.
async function buildBuyBack(
  ctx: SimContext,
  runtime: EusdDepegRuntime,
  amountEusd: bigint,
): Promise<{ to: Address; data: Hex } | null> {
  const [needed, usdcBalance] = (await Promise.all([
    ctx.publicClient.readContract({
      address: runtime.pool,
      abi: curveStableSwapNgAbi,
      functionName: "get_dx",
      args: [BigInt(runtime.usdcIndex), BigInt(runtime.eusdIndex), amountEusd],
    }),
    ctx.publicClient.readContract({
      address: runtime.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [runtime.actor],
    }),
  ])) as [bigint, bigint];
  const spend = needed > usdcBalance ? usdcBalance : needed;
  if (spend <= 0n) return null;
  const quoted = (await ctx.publicClient.readContract({
    address: runtime.pool,
    abi: curveStableSwapNgAbi,
    functionName: "get_dy",
    args: [BigInt(runtime.usdcIndex), BigInt(runtime.eusdIndex), spend],
  })) as bigint;
  if (quoted <= 0n) return null;
  return {
    to: runtime.pool,
    data: encodeFunctionData({
      abi: curveStableSwapNgAbi,
      functionName: "exchange",
      args: [
        BigInt(runtime.usdcIndex),
        BigInt(runtime.eusdIndex),
        spend,
        (quoted * (10_000n - DEPEG_SLIPPAGE_BPS)) / 10_000n,
      ],
    }),
  };
}

async function settlePending(
  ctx: SimContext,
  runtime: EusdDepegRuntime,
  blockIndex: number,
  logger: RunLogger,
): Promise<boolean> {
  const pending = runtime.pending;
  if (!pending) return true;
  let status: "success" | "reverted" | null = null;
  try {
    const receipt = await ctx.publicClient.getTransactionReceipt({
      hash: pending.hash,
    });
    status = receipt.status === "success" ? "success" : "reverted";
  } catch {
    status = null;
  }
  if (status === null) {
    if (blockIndex - pending.blockIndex < PENDING_TIMEOUT_BLOCKS) return false;
    logger.event({
      type: "stress_eusd_depeg_stuck",
      blockIndex,
      hash: pending.hash,
      submittedAtBlockIndex: pending.blockIndex,
    });
  }
  if (status === "reverted") {
    logger.event({
      type: "stress_eusd_depeg_reverted",
      blockIndex,
      hash: pending.hash,
    });
  }
  runtime.pending = null;
  return true;
}

/// Put the peg back before the run ends, whatever the schedule managed to do.
///
/// The block loop can simply stop with a window still open (`EventSchedule` clamps the start so the
/// window can end on the last block, and a run can also end early on its time limit). Under the
/// scenario matrix the per-scenario revert would hide it, but a plain `sim:realtime` on a shared
/// anvil would hand the next run a permanently depegged stablecoin -- and the startup check above
/// would then refuse to start it. Mined rather than mempool: there is no next block to settle on.
export async function restoreEusdDepeg(
  ctx: SimContext,
  runtime: EusdDepegRuntime,
  logger: RunLogger,
): Promise<void> {
  runtime.pending = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const balance = (await ctx.publicClient.readContract({
      address: runtime.eusd,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [runtime.actor],
    })) as bigint;
    const sold =
      runtime.startEusdWei > balance ? runtime.startEusdWei - balance : 0n;
    if ((sold * 10_000n) / (runtime.seededPoolEusdWei || 1n) < MIN_DELTA_BPS) {
      logger.event({
        type: "stress_eusd_depeg_restored",
        phase: "teardown",
        outstandingEusdWei: sold.toString(),
        attempts: attempt,
      });
      return;
    }
    try {
      const call = await buildBuyBack(ctx, runtime, sold);
      if (!call) break;
      await sendAndMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        runtime.actorPk,
        { to: call.to, data: call.data },
      );
    } catch (error) {
      logger.event({
        type: "stress_eusd_depeg_teardown_failed",
        outstandingEusdWei: sold.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  const balance = (await ctx.publicClient.readContract({
    address: runtime.eusd,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [runtime.actor],
  })) as bigint;
  const outstanding =
    runtime.startEusdWei > balance ? runtime.startEusdWei - balance : 0n;
  logger.event({
    type:
      (outstanding * 10_000n) / (runtime.seededPoolEusdWei || 1n) <
      MIN_DELTA_BPS
        ? "stress_eusd_depeg_restored"
        : "stress_eusd_depeg_restore_incomplete",
    phase: "teardown",
    outstandingEusdWei: outstanding.toString(),
  });
}
