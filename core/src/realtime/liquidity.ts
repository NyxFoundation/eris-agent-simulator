// Liquidity-pull stress event (issue #52): withdraw seeded pool depth for the length of a window and
// put it back when the window closes.
//
// Why it is a state rather than an overlay: spike/crash are pure functions of the block index, and
// the price writer applies the multiplier every block. Depth has to actually leave the pool, so the
// schedule's trapezoid drives a *target depth* that the coordinator reconciles the venue against
// each block. Reconciling to a target (rather than removing once and restoring once) is what makes
// it survive the coordinator's dropped-block behaviour: `onBlock` skips notifications while it is
// still processing the previous one, and matching a single index exactly is what once let a dropped
// block swallow the whole lstSlash axis.
//
// Why it is not a freebie: the withdrawal is proportional -- the environment gives up a fraction of
// its own claim and gets both sides back at the pool's current ratio -- so the mid does not move and
// no risk-free edge opens. What changes is the cost of size, which is the point of the regime (ADR
// 0017 regime 6): the price gap says what is on offer, the depth says how much of it anyone can
// actually take.
//
// The per-venue paths live in liquidityVenues.ts. This file is venue-agnostic because all three
// expose the same thing: a proportional claim measured in its own unit (position liquidity, BPT, LP
// balance), where a fraction of the claim is a fraction of the depth. GMX and Aave are a different
// axis entirely and out of scope.
import { encodeFunctionData, maxUint256, type Address, type Hex } from "viem";
import { erc20Abi } from "@eris/sdk/abis.js";
import { accountAddress, sendAndMine, sendNoMine } from "@eris/sdk/chain.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import type { RunLogger } from "../logger.js";
import type { EventSchedule } from "./events.js";
import {
  approvalsFor,
  buildDeposit,
  buildWithdraw,
  discoverPullPositions,
  readPoolDepth,
  readShare,
  RECONCILE_GAS,
  type PullPosition,
  type PullVenue,
} from "./liquidityVenues.js";

// Deltas below this fraction of the seeded depth are not worth a transaction (they come from
// rounding the multiplier, not from the schedule). The final restore is exempt -- see reconcile.
const MIN_DELTA_BPS = 1n;

// How far the restored depth may sit from the seeded depth before it is reported as a problem. The
// arithmetic round trip is exact to a few wei; anything at this scale means a transaction failed or
// the owner ran out of one side.
const RESTORE_TOLERANCE_BPS = 10n;

// Blocks to wait for a submitted write before treating it as lost and resynchronizing from the
// chain. Under interval mining a transaction lands on the next block, so this is slack for a busy
// block rather than an expected path.
const PENDING_TIMEOUT_BLOCKS = 3;

// A restore is recomputed at a price that has moved since the previous attempt, so it converges in a
// block or two. This bounds the pathological case where it never quite lands and would otherwise
// re-send for the rest of the run.
const MAX_RESTORE_ATTEMPTS = 5;

export type LiquidityPullRuntime = {
  owner: Address;
  ownerPk: Hex;
  positions: PullPosition[];
  // The claim each position actually holds, keyed by venue:market -- read back from the chain after
  // each write mines, never assumed from what was submitted. Each block sends only the delta.
  applied: Map<string, bigint>;
  // Write submitted but not yet confirmed. While one is outstanding the position is left alone:
  // re-deriving the delta from pre-transaction depth would double the withdrawal.
  pending: Map<string, { hash: Hex; blockIndex: number }>;
  // Restore attempts since the window closed (see MAX_RESTORE_ATTEMPTS).
  restoreAttempts: Map<string, number>;
  // Whether this window's outcome has already been logged.
  restoreReported: boolean;
};

// One position per (venue, market). Not the tokenId: only Uniswap has one.
function keyOf(pos: PullPosition): string {
  return `${pos.venue}:${pos.marketKey}`;
}

/// Discover the environment-owned full-range positions backing the pools a liquidityPull targets,
/// and record their depth at run start.
///
/// Fails fast rather than degrading: a run that logs a liquidity-pull schedule and then silently
/// withdraws nothing is a crash regime that is still only a price gap, which is the exact defect
/// issue #52 exists to fix.
export async function setupLiquidityPull(
  ctx: SimContext,
  schedule: EventSchedule,
  opts: { localDeploy: boolean; ownerPk: Hex; enabledVenues: PullVenue[] },
  logger: RunLogger,
): Promise<LiquidityPullRuntime> {
  const bases = schedule.liquidityPullBases();
  if (!opts.localDeploy) {
    throw new Error(
      "stress event liquidityPull requires run.localDeploy: on a fork the seeded pools belong to " +
        "real Arbitrum LPs, not to this run, so there is nothing the environment may withdraw",
    );
  }
  const venues = schedule.liquidityPullVenues(opts.enabledVenues);
  if (venues.length === 0) {
    throw new Error(
      "stress event liquidityPull has no venue to withdraw from: none of uniswap/balancer/curve " +
        "is in run.protocols",
    );
  }

  const owner = accountAddress(opts.ownerPk);
  const { positions, misses } = await discoverPullPositions(
    ctx,
    venues,
    bases,
    owner,
  );
  // Every requested (venue, base) has to resolve. A partial pull is a quieter version of the defect
  // this event exists to fix -- the regime would look complete while the cost of size stayed put on
  // whichever venue was missed.
  if (misses.length > 0) {
    throw new Error(
      `stress event liquidityPull found no environment-owned liquidity for ${misses.join(", ")} ` +
        `(owner ${owner}). The seeded positions belong to the deployer account (ADR 0016 §4 assumes ` +
        "the anvil default keys hold them); a custom MNEMONIC in deployer/.env would put them " +
        "somewhere this run cannot reach. Narrow the event with `venue:` if a venue is meant to be " +
        "left alone",
    );
  }

  // The decay leg deposits tokens back, so each venue's spender needs standing approval: the
  // deploy-time approvals covered only the exact seeding amounts. Sequential because they all come
  // from one key and each mines a block -- concurrent sends would race on the nonce.
  const approvals = new Map<string, { token: Address; spender: Address }>();
  for (const pos of positions)
    for (const a of approvalsFor(pos))
      approvals.set(`${a.token.toLowerCase()}:${a.spender.toLowerCase()}`, a);
  for (const { token, spender } of approvals.values()) {
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      opts.ownerPk,
      {
        to: token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [spender, maxUint256],
        }),
      },
    );
  }

  // Balances matter for the restore: putting depth back after the price has moved needs a different
  // mix than the withdrawal returned, and the shortfall (if any) comes from the owner's own float.
  const tokens = [...new Set([...approvals.values()].map((a) => a.token))];
  const balanceValues = (await Promise.all(
    tokens.map((token) =>
      ctx.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
    ),
  )) as bigint[];
  const balances: Record<string, string> = {};
  tokens.forEach((token, i) => {
    balances[token] = balanceValues[i].toString();
  });

  logger.event({
    type: "stress_liquidity_pull_setup",
    owner,
    venues,
    positions: positions.map((p) => ({
      venue: p.venue,
      market: p.marketKey,
      seededShare: p.seededShare.toString(),
    })),
    ownerBalances: balances,
  });

  return {
    owner,
    ownerPk: opts.ownerPk,
    positions,
    applied: new Map(),
    pending: new Map(),
    restoreAttempts: new Map(),
    restoreReported: true,
  };
}

/// Move each tracked pool toward the depth the schedule asks for on this block. Returns the hashes
/// it submitted so the coordinator can attribute them.
///
/// Every decision is made against the depth the position *actually* holds, read back after each
/// write mines, rather than against the depth that was submitted. Two failures make that necessary
/// and neither is exotic:
///   - `sendNoMine` returns when anvil accepts the transaction, not when it succeeds. A revert
///     (deadline, gas, a token float that ran dry) would otherwise leave the pool at its old depth
///     while this run recorded the new target, and the delta would never be recomputed again.
///   - Uniswap's `increaseLiquidity` and Curve's `add_liquidity` both derive the claim from token
///     amounts at *execution* price, so amounts computed from a read one block earlier land short by
///     roughly the price move in between -- and the decay leg runs precisely while a crash is
///     recovering, so the price is moving by construction. Re-reading turns that shortfall into the
///     next block's delta instead of a silent permanent loss of depth. (Balancer's proportional join
///     names the BPT exactly and does not have this problem.)
export async function reconcileLiquidityPull(
  ctx: SimContext,
  runtime: LiquidityPullRuntime,
  schedule: EventSchedule,
  blockIndex: number,
  blockNumber: number,
  opts: { priorityFeeWei: bigint },
  logger: RunLogger,
): Promise<Hex[]> {
  const mults = schedule.depthMultiplierAt(blockIndex);
  const windowOpen = Object.keys(mults).length > 0;
  if (windowOpen) runtime.restoreReported = false;
  const hashes: Hex[] = [];
  let deadline = 0n;
  let allSettled = true;

  for (const pos of runtime.positions) {
    const key = keyOf(pos);

    // Settle the previous write before deciding anything: re-deriving a delta while one is still in
    // the mempool would withdraw the same depth twice.
    if (runtime.pending.has(key)) {
      const settled = await settlePending(
        ctx,
        runtime,
        pos,
        blockIndex,
        logger,
      );
      if (!settled) {
        allSettled = false;
        continue;
      }
    }

    const mult = mults[pos.base] ?? 1;
    const target = scaleLiquidity(pos.seededShare, mult);
    const applied = runtime.applied.get(key) ?? pos.seededShare;
    if (target === applied) continue;
    const delta = target > applied ? target - applied : applied - target;
    const isRestore = target === pos.seededShare;
    // Rounding noise is not worth a transaction. Closing the window is worth chasing -- leaving the
    // pool short hands the rest of the run a thinner venue -- but not forever: each restore is
    // computed at a price that has since moved, so a pathological case could otherwise re-send every
    // block for the rest of the run.
    if (!isRestore && (delta * 10_000n) / pos.seededShare < MIN_DELTA_BPS)
      continue;
    if (isRestore) {
      const attempts = runtime.restoreAttempts.get(key) ?? 0;
      if (attempts >= MAX_RESTORE_ATTEMPTS) continue;
      if ((delta * 10_000n) / pos.seededShare < MIN_DELTA_BPS && attempts > 0)
        continue;
      runtime.restoreAttempts.set(key, attempts + 1);
    } else {
      runtime.restoreAttempts.set(key, 0);
    }

    if (deadline === 0n) {
      const block = await ctx.publicClient.getBlock();
      deadline = block.timestamp + 3600n;
    }

    // What the book actually looks like right now, so post-run attribution can show the depth left
    // rather than only the depth asked for. Whole-pool depth rather than this position's share,
    // because that is what decides an agent's slippage -- participant liquidity included.
    const depthBefore = await readPoolDepth(ctx, pos);

    try {
      const call =
        target < applied
          ? await buildWithdraw(
              ctx,
              pos,
              runtime.owner,
              applied - target,
              deadline,
            )
          : await buildDeposit(
              ctx,
              pos,
              runtime.owner,
              target - applied,
              deadline,
            );
      const hash = await sendNoMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        runtime.ownerPk,
        { to: call.to, data: call.data, gas: RECONCILE_GAS },
        opts.priorityFeeWei,
      );
      runtime.pending.set(key, { hash, blockIndex });
      allSettled = false;
      hashes.push(hash);
      logger.event({
        type: "stress_liquidity_pull",
        blockIndex,
        blockNumber,
        venue: pos.venue,
        market: pos.marketKey,
        direction: target < applied ? "withdraw" : "restore",
        depthMultiplier: mult,
        ...(depthBefore !== undefined
          ? { poolDepthBefore: depthBefore.toString() }
          : {}),
        seededShare: pos.seededShare.toString(),
        previousShare: applied.toString(),
        targetShare: target.toString(),
        hash,
      });
    } catch (error) {
      // `applied` is untouched, so the next block recomputes the same delta and retries: a failed
      // send costs one block of depth rather than desynchronizing the pool for the whole run.
      logger.event({
        type: "stress_liquidity_pull_failed",
        blockIndex,
        blockNumber,
        venue: pos.venue,
        market: pos.marketKey,
        targetShare: target.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Report the outcome once per window, and only when nothing is still in flight -- checking while a
  // restore sits in the mempool would read the pre-restore depth and cry incomplete.
  if (!windowOpen && allSettled && !runtime.restoreReported) {
    const anyMoved = runtime.positions.some(
      (p) => (runtime.applied.get(keyOf(p)) ?? p.seededShare) !== p.seededShare,
    );
    const exhausted = runtime.positions.every(
      (p) =>
        (runtime.restoreAttempts.get(keyOf(p)) ?? 0) >= MAX_RESTORE_ATTEMPTS,
    );
    if (!anyMoved || exhausted) {
      runtime.restoreReported = true;
      reportRestored(runtime, { blockIndex, blockNumber }, logger);
    }
  }
  return hashes;
}

// Resolve an in-flight write: confirm it mined, then resynchronize `applied` with what the position
// actually holds. Returns false while the transaction is still pending, meaning "leave this position
// alone this block".
async function settlePending(
  ctx: SimContext,
  runtime: LiquidityPullRuntime,
  pos: PullPosition,
  blockIndex: number,
  logger: RunLogger,
): Promise<boolean> {
  const key = keyOf(pos);
  const pending = runtime.pending.get(key);
  if (!pending) return true;

  let status: "success" | "reverted" | null = null;
  try {
    const receipt = await ctx.publicClient.getTransactionReceipt({
      hash: pending.hash,
    });
    status = receipt.status === "success" ? "success" : "reverted";
  } catch {
    status = null; // not mined yet
  }

  if (status === null) {
    if (blockIndex - pending.blockIndex < PENDING_TIMEOUT_BLOCKS) return false;
    // Stuck in the mempool for several blocks. Give up on it and resynchronize from the chain: the
    // delta is always re-derived from actual depth, so even if the transaction lands later the next
    // block corrects for it rather than compounding it.
    logger.event({
      type: "stress_liquidity_pull_stuck",
      blockIndex,
      venue: pos.venue,
      market: pos.marketKey,
      hash: pending.hash,
      submittedAtBlockIndex: pending.blockIndex,
    });
  }
  runtime.pending.delete(key);

  const actual = await readShare(ctx, pos, runtime.owner).catch(() => null);
  if (actual !== null) runtime.applied.set(key, actual);
  if (status === "reverted") {
    logger.event({
      type: "stress_liquidity_pull_reverted",
      blockIndex,
      venue: pos.venue,
      market: pos.marketKey,
      hash: pending.hash,
      share: actual === null ? undefined : actual.toString(),
    });
  }
  return true;
}

// Record how the window closed. `applied` is depth read back from the chain after the last write
// settled, so this reports rather than checks -- the reconcile loop is what chases the pool back.
function reportRestored(
  runtime: LiquidityPullRuntime,
  at: { blockIndex: number; blockNumber: number } | null,
  logger: RunLogger,
): void {
  for (const pos of runtime.positions) {
    const key = keyOf(pos);
    const actual = runtime.applied.get(key) ?? pos.seededShare;
    const diff =
      actual > pos.seededShare
        ? actual - pos.seededShare
        : pos.seededShare - actual;
    const driftBps = (diff * 10_000n) / pos.seededShare;
    logger.event({
      type:
        driftBps > RESTORE_TOLERANCE_BPS
          ? "stress_liquidity_restore_incomplete"
          : "stress_liquidity_restored",
      ...(at ?? { phase: "teardown" }),
      venue: pos.venue,
      market: pos.marketKey,
      seededShare: pos.seededShare.toString(),
      actualShare: actual.toString(),
      driftBps: Number(driftBps),
      attempts: runtime.restoreAttempts.get(key) ?? 0,
    });
  }
}

/// Put the depth back before the run ends, whatever the schedule managed to do.
///
/// The block loop can simply stop with a window still open: `EventSchedule` clamps `startBlock` to
/// `runBlocks - span`, so `endBlock` can equal `runBlocks` and the only block that could issue the
/// restore is the last one -- and the run may also end early on its time limit. Under the scenario
/// matrix the per-scenario snapshot/revert would hide it, but a plain `sim:realtime` on a shared
/// anvil would hand the next run a permanently thinner venue, which is exactly the contamination
/// this module exists to avoid. Mined rather than mempool: there is no next block to settle on.
export async function restoreLiquidityPull(
  ctx: SimContext,
  runtime: LiquidityPullRuntime,
  logger: RunLogger,
): Promise<void> {
  for (const pos of runtime.positions) {
    const key = keyOf(pos);
    runtime.pending.delete(key);
    for (let attempt = 0; attempt < MAX_RESTORE_ATTEMPTS; attempt++) {
      let actual: bigint;
      try {
        actual = await readShare(ctx, pos, runtime.owner);
      } catch (error) {
        logger.event({
          type: "stress_liquidity_teardown_failed",
          venue: pos.venue,
          market: pos.marketKey,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
      runtime.applied.set(key, actual);
      if (actual >= pos.seededShare) break;
      const shortfall = pos.seededShare - actual;
      if ((shortfall * 10_000n) / pos.seededShare < MIN_DELTA_BPS) break;
      try {
        const block = await ctx.publicClient.getBlock();
        const call = await buildDeposit(
          ctx,
          pos,
          runtime.owner,
          shortfall,
          block.timestamp + 3600n,
        );
        await sendAndMine(
          ctx.publicClient,
          ctx.walletClient,
          ctx.chain,
          runtime.ownerPk,
          { to: call.to, data: call.data },
        );
        logger.event({
          type: "stress_liquidity_teardown_restore",
          venue: pos.venue,
          market: pos.marketKey,
          attempt: attempt + 1,
          shortfall: shortfall.toString(),
        });
      } catch (error) {
        logger.event({
          type: "stress_liquidity_teardown_failed",
          market: pos.marketKey,
          tokenId: key,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
  }
  reportRestored(runtime, null, logger);
}

// The envelope is a float; depth is a uint128. Scale through a fixed 1e9 grid so the same block
// index always produces the same target (a float multiply would not be reproducible across runs).
export function scaleLiquidity(seeded: bigint, mult: number): bigint {
  if (mult >= 1) return seeded;
  if (mult <= 0) return 0n;
  return (seeded * BigInt(Math.round(mult * 1e9))) / 1_000_000_000n;
}
