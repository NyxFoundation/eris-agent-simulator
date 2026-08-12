// Pushing a stablecoin off its peg, and putting it back (issues #39 and #27 (c)).
//
// The environment sells a market-priced stable into its own USDC pool for the length of a window and
// buys it back afterwards. Everything here is stable-agnostic: it needs a stableswap-ng pool, the two
// coin indices, and an actor holding enough of the stable to move the price. eUSD (#39) and DAI
// (#27 (c)) both run through it, differing only in which account holds the float and what the events
// are called.
//
// Two decisions are worth keeping in view, because both were paid for once already.
//
// *Reconciled per block, not applied once.* The target is a pure function of the block index, so a
// dropped block costs a block of lag instead of leaving the peg stuck wherever it happened to be.
// `pointEventsAt` was written the other way and broke exactly there (issue #52's liquidity pull
// carries the same note).
//
// *Measured against the chain, not against what was submitted.* Every decision reads the actor's
// balance back. A swap can revert -- slippage, an empty float, an agent arriving first in the same
// block -- and a target derived from an assumed fill would then be wrong for the rest of the window.
//
// Why the environment injects the dislocation rather than letting one emerge: an emergent depeg
// depends on who entered the competition, since a redemption-heavy field would hold the peg and a
// passive one would let it collapse. That makes the regime's character a function of the roster,
// which breaks "the same market conditions in every scenario" (ADR 0009). The dislocation is
// injected; the *resolution* is left to the real mechanism -- redemption for eUSD, arbitrage for DAI.
import { encodeFunctionData, maxUint256, type Address, type Hex } from "viem";
import { curveStableSwapNgAbi, erc20Abi } from "@eris/sdk/abis.js";
import { accountAddress, sendAndMine, sendNoMine } from "@eris/sdk/chain.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import type { RunLogger } from "../logger.js";

// Swaps against a stableswap pool are a fixed shape; pinning the gas skips an eth_estimateGas (a
// whole extra EVM execution) on a transaction the environment may send every block of a window.
const DEPEG_GAS = 600_000n;

// Slippage bound on the environment's own depeg trades. It is not being protected from a bad price
// -- moving the price is the point -- only from a pathological fill.
const DEPEG_SLIPPAGE_BPS = 500n;

// Deltas below this fraction of the pool's seeded depth are rounding, not schedule. Closing the
// window is exempt: leaving the peg broken would hand the rest of the run a different venue.
const MIN_DELTA_BPS = 50n;

// Blocks to wait for a submitted swap before treating it as lost. Under interval mining a
// transaction lands on the next block, so this is slack for a busy block rather than a normal path.
const PENDING_TIMEOUT_BLOCKS = 3;

// The pool a depeg pushes against, and who pushes it.
export type StableDepegMarket = {
  // Registry symbol, carried into every event so a run with two depegs is readable.
  symbol: string;
  stable: Address;
  quote: Address;
  pool: Address;
  stableIndex: number;
  quoteIndex: number;
};

export type StableDepegRuntime = StableDepegMarket & {
  // Event-name prefix. eUSD keeps `stress_eusd_depeg` from #39 so its diagnostics stay readable
  // against past runs; everything else is `stress_depeg` with the symbol in the payload.
  label: string;
  actor: Address;
  actorPk: Hex;
  // The pool's depth in the stable at run start. The event's magnitude is a fraction of this, so the
  // same config means the same imbalance whatever the deploy seeded.
  seededPoolStableWei: bigint;
  // The actor's balance at run start, which bounds how far the peg can be pushed.
  startStableWei: bigint;
  pending: { hash: Hex; blockIndex: number } | null;
  // Whether the inventory limit has already been reported. Once is enough; it is a calibration
  // finding, not a per-block event.
  cappedReported: boolean;
};

/// Stage the account that will move the peg, and record what it has to work with.
///
/// The actor is not a participant and is excluded from scoring, the same arrangement as the ADR 0009
/// stress victims.
export async function setupStableDepeg(
  ctx: SimContext,
  opts: {
    market: StableDepegMarket;
    label: string;
    actorPk: Hex;
    // What to say when the actor holds none of the stable. Deployment-specific, and the difference
    // between "redeploy" and "a previous run spent it" is exactly what the operator needs.
    emptyInventoryHint: string;
  },
  logger: RunLogger,
): Promise<StableDepegRuntime> {
  const { market, label } = opts;
  const actor = accountAddress(opts.actorPk);

  const [poolStable, actorStable, actorQuote] = (await Promise.all([
    ctx.publicClient.readContract({
      address: market.pool,
      abi: curveStableSwapNgAbi,
      functionName: "balances",
      args: [BigInt(market.stableIndex)],
    }),
    ctx.publicClient.readContract({
      address: market.stable,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [actor],
    }),
    ctx.publicClient.readContract({
      address: market.quote,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [actor],
    }),
  ])) as [bigint, bigint, bigint];

  if (actorStable === 0n) {
    throw new Error(
      `stress event depeg has nothing to sell: the actor (${actor}) holds no ${market.symbol}. ` +
        opts.emptyInventoryHint,
    );
  }

  // The deploy approved the pool for exactly the amounts it seeded, so both legs need standing
  // approval before the window opens. Sequential: one key, one nonce.
  for (const token of [market.stable, market.quote]) {
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
    type: `${label}_setup`,
    stable: market.symbol,
    actor,
    pool: market.pool,
    poolStableWei: poolStable.toString(),
    actorStableWei: actorStable.toString(),
    actorQuoteUnits: actorQuote.toString(),
    // What fraction of the pool the actor could sell at most. Below the configured magnitude the
    // window will simply be shallower than asked for, which the reconcile reports.
    maxFractionOfPool:
      poolStable > 0n
        ? Number((actorStable * 10_000n) / poolStable) / 10_000
        : 0,
  });

  return {
    ...market,
    label,
    actor,
    actorPk: opts.actorPk,
    seededPoolStableWei: poolStable,
    startStableWei: actorStable,
    pending: null,
    cappedReported: false,
  };
}

/// Move the peg toward where the schedule wants it on this block.
export async function reconcileStableDepeg(
  ctx: SimContext,
  runtime: StableDepegRuntime,
  fraction: number,
  blockIndex: number,
  blockNumber: number,
  opts: { priorityFeeWei: bigint },
  logger: RunLogger,
): Promise<Hex[]> {
  if (runtime.pending) {
    const settled = await settlePending(ctx, runtime, blockIndex, logger);
    if (!settled) return [];
  }

  const balance = (await ctx.publicClient.readContract({
    address: runtime.stable,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [runtime.actor],
  })) as bigint;
  const sold =
    runtime.startStableWei > balance ? runtime.startStableWei - balance : 0n;

  const asked =
    (runtime.seededPoolStableWei * BigInt(Math.round(fraction * 1e9))) /
    1_000_000_000n;
  // Bounded by what the actor can still sell. A window that cannot reach its magnitude is a
  // calibration finding, so it is reported rather than silently delivering a shallower depeg.
  const target =
    asked > runtime.startStableWei ? runtime.startStableWei : asked;
  if (target < asked && !runtime.cappedReported) {
    runtime.cappedReported = true;
    logger.event({
      type: `${runtime.label}_capped`,
      stable: runtime.symbol,
      blockIndex,
      askedStableWei: asked.toString(),
      availableStableWei: runtime.startStableWei.toString(),
      note: `the depeg is shallower than the configured magnitude: the actor's ${runtime.symbol} ran out`,
    });
  }

  if (target === sold) return [];
  const delta = target > sold ? target - sold : sold - target;
  const closing = target === 0n;
  if (
    !closing &&
    (delta * 10_000n) / (runtime.seededPoolStableWei || 1n) < MIN_DELTA_BPS
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
      type: runtime.label,
      stable: runtime.symbol,
      blockIndex,
      blockNumber,
      direction: target > sold ? "sell" : "buyback",
      targetFraction: Number(fraction.toFixed(4)),
      targetSoldStableWei: target.toString(),
      soldStableWei: sold.toString(),
      deltaStableWei: delta.toString(),
      hash,
    });
    return [hash];
  } catch (error) {
    // `sold` is re-derived from the chain next block, so a failed send costs one block of lag
    // rather than desynchronizing the window.
    logger.event({
      type: `${runtime.label}_failed`,
      stable: runtime.symbol,
      blockIndex,
      blockNumber,
      targetSoldStableWei: target.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function buildSell(
  ctx: SimContext,
  runtime: StableDepegRuntime,
  amountStable: bigint,
): Promise<{ to: Address; data: Hex } | null> {
  const quoted = (await ctx.publicClient.readContract({
    address: runtime.pool,
    abi: curveStableSwapNgAbi,
    functionName: "get_dy",
    args: [
      BigInt(runtime.stableIndex),
      BigInt(runtime.quoteIndex),
      amountStable,
    ],
  })) as bigint;
  if (quoted <= 0n) return null;
  return {
    to: runtime.pool,
    data: encodeFunctionData({
      abi: curveStableSwapNgAbi,
      functionName: "exchange",
      args: [
        BigInt(runtime.stableIndex),
        BigInt(runtime.quoteIndex),
        amountStable,
        (quoted * (10_000n - DEPEG_SLIPPAGE_BPS)) / 10_000n,
      ],
    }),
  };
}

/// The buy-back leg sizes on the *output*: the target is an amount of the stable to take back off
/// the market, not an amount of USDC to spend, so it is get_dx rather than get_dy. Spending the USDC
/// the sale produced would come up short by exactly the round trip's cost and leave the peg
/// permanently a little broken.
async function buildBuyBack(
  ctx: SimContext,
  runtime: StableDepegRuntime,
  amountStable: bigint,
): Promise<{ to: Address; data: Hex } | null> {
  const [needed, quoteBalance] = (await Promise.all([
    ctx.publicClient.readContract({
      address: runtime.pool,
      abi: curveStableSwapNgAbi,
      functionName: "get_dx",
      args: [
        BigInt(runtime.quoteIndex),
        BigInt(runtime.stableIndex),
        amountStable,
      ],
    }),
    ctx.publicClient.readContract({
      address: runtime.quote,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [runtime.actor],
    }),
  ])) as [bigint, bigint];
  const spend = needed > quoteBalance ? quoteBalance : needed;
  if (spend <= 0n) return null;
  const quoted = (await ctx.publicClient.readContract({
    address: runtime.pool,
    abi: curveStableSwapNgAbi,
    functionName: "get_dy",
    args: [BigInt(runtime.quoteIndex), BigInt(runtime.stableIndex), spend],
  })) as bigint;
  if (quoted <= 0n) return null;
  return {
    to: runtime.pool,
    data: encodeFunctionData({
      abi: curveStableSwapNgAbi,
      functionName: "exchange",
      args: [
        BigInt(runtime.quoteIndex),
        BigInt(runtime.stableIndex),
        spend,
        (quoted * (10_000n - DEPEG_SLIPPAGE_BPS)) / 10_000n,
      ],
    }),
  };
}

async function settlePending(
  ctx: SimContext,
  runtime: StableDepegRuntime,
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
      type: `${runtime.label}_stuck`,
      stable: runtime.symbol,
      blockIndex,
      hash: pending.hash,
      submittedAtBlockIndex: pending.blockIndex,
    });
  }
  if (status === "reverted") {
    logger.event({
      type: `${runtime.label}_reverted`,
      stable: runtime.symbol,
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
/// anvil would hand the next run a permanently depegged stablecoin -- and the liquity startup check
/// would then refuse to start it. Mined rather than mempool: there is no next block to settle on.
export async function restoreStableDepeg(
  ctx: SimContext,
  runtime: StableDepegRuntime,
  logger: RunLogger,
): Promise<void> {
  runtime.pending = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const balance = (await ctx.publicClient.readContract({
      address: runtime.stable,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [runtime.actor],
    })) as bigint;
    const sold =
      runtime.startStableWei > balance ? runtime.startStableWei - balance : 0n;
    if (
      (sold * 10_000n) / (runtime.seededPoolStableWei || 1n) <
      MIN_DELTA_BPS
    ) {
      logger.event({
        type: `${runtime.label}_restored`,
        stable: runtime.symbol,
        phase: "teardown",
        outstandingStableWei: sold.toString(),
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
        type: `${runtime.label}_teardown_failed`,
        stable: runtime.symbol,
        outstandingStableWei: sold.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  const balance = (await ctx.publicClient.readContract({
    address: runtime.stable,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [runtime.actor],
  })) as bigint;
  const outstanding =
    runtime.startStableWei > balance ? runtime.startStableWei - balance : 0n;
  logger.event({
    type:
      (outstanding * 10_000n) / (runtime.seededPoolStableWei || 1n) <
      MIN_DELTA_BPS
        ? `${runtime.label}_restored`
        : `${runtime.label}_restore_incomplete`,
    stable: runtime.symbol,
    phase: "teardown",
    outstandingStableWei: outstanding.toString(),
  });
}
