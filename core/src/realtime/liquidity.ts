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
// Why it is not a freebie: the withdrawal is proportional -- a full-range position gives back both
// sides at the pool's current ratio -- so the mid does not move and no risk-free edge opens. What
// changes is the cost of size, which is the point of the regime (ADR 0017 regime 6): the price gap
// says what is on offer, the depth says how much of it anyone can actually take.
//
// Phase 1 is Uniswap V3 only. Balancer and Curve have their own proportional exit paths (issue #52
// phase 2); GMX and Aave are a different axis entirely and out of scope.
import {
  encodeFunctionData,
  maxUint128,
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import {
  erc20Abi,
  nonfungiblePositionManagerAbi,
  poolAbi,
} from "@eris/sdk/abis.js";
import { accountAddress, sendAndMine, sendNoMine } from "@eris/sdk/chain.js";
import { UNISWAP } from "@eris/sdk/constants.js";
import { marketsFor, tokenInfo } from "@eris/sdk/markets.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import type { TokenSymbol } from "@eris/sdk/types.js";
import type { RunLogger } from "../logger.js";
import type { EventSchedule } from "./events.js";
import { getAmountsForLiquidity, getSqrtRatioAtTick } from "./tickMath.js";

// Generous enough for decreaseLiquidity+collect in one multicall; a fixed value avoids an
// estimateGas round trip on the critical path of every window block.
const RECONCILE_GAS = 900_000n;

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

export type LiquidityPullPosition = {
  tokenId: bigint;
  base: string;
  marketKey: string;
  pool: Address;
  token0: Address;
  token1: Address;
  tickLower: number;
  tickUpper: number;
  // Depth at run start. Every target is a fraction of this, and the window has to end back here.
  seededLiquidity: bigint;
};

export type LiquidityPullRuntime = {
  owner: Address;
  ownerPk: Hex;
  positions: LiquidityPullPosition[];
  // Depth the position actually holds, keyed by tokenId -- read back from the chain after each write
  // mines, never assumed from what was submitted. Each block sends only the delta against this.
  applied: Map<string, bigint>;
  // Write submitted but not yet confirmed, keyed by tokenId. While one is outstanding the position
  // is left alone: re-deriving the delta from pre-transaction depth would double the withdrawal.
  pending: Map<string, { hash: Hex; blockIndex: number }>;
  // Restore attempts since the window closed, keyed by tokenId (see MAX_RESTORE_ATTEMPTS).
  restoreAttempts: Map<string, number>;
  // Whether this window's outcome has already been logged.
  restoreReported: boolean;
};

type PositionTuple = readonly [
  bigint, // nonce
  Address, // operator
  Address, // token0
  Address, // token1
  number, // fee
  number, // tickLower
  number, // tickUpper
  bigint, // liquidity
  bigint,
  bigint,
  bigint,
  bigint,
];

// Sorted (token0, token1) for a market, matching how the pool stores them.
function sortedTokens(
  base: TokenSymbol,
  quote: TokenSymbol,
): [Address, Address] {
  const b = tokenInfo(base).address;
  const q = tokenInfo(quote).address;
  return b.toLowerCase() < q.toLowerCase() ? [b, q] : [q, b];
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
  opts: { localDeploy: boolean; ownerPk: Hex },
  logger: RunLogger,
): Promise<LiquidityPullRuntime> {
  const bases = schedule.liquidityPullBases();
  if (!opts.localDeploy) {
    throw new Error(
      "stress event liquidityPull requires run.localDeploy: on a fork the seeded pools belong to " +
        "real Arbitrum LPs, not to this run, so there is nothing the environment may withdraw",
    );
  }
  const markets = marketsFor("uniswap").filter((m) => bases.includes(m.base));
  const missing = bases.filter((b) => !markets.some((m) => m.base === b));
  if (missing.length > 0) {
    throw new Error(
      `stress event liquidityPull targets ${missing.join(", ")}, which has no uniswap market configured`,
    );
  }

  const owner = accountAddress(opts.ownerPk);
  const count = (await ctx.publicClient.readContract({
    address: UNISWAP.nonfungiblePositionManager,
    abi: nonfungiblePositionManagerAbi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;

  const wanted = new Map<
    string,
    { base: string; key: string; pool: Address }
  >();
  for (const m of markets) {
    if (!m.uniswap) continue;
    const [token0, token1] = sortedTokens(m.base, m.quote);
    wanted.set(
      `${token0.toLowerCase()}:${token1.toLowerCase()}:${m.uniswap.fee}`,
      {
        base: m.base,
        key: m.key,
        pool: m.uniswap.pool,
      },
    );
  }

  // Two dependent rounds of independent reads, not 2N sequential round trips: every scenario in a
  // matrix run pays this before its first block.
  const tokenIds = (await Promise.all(
    Array.from({ length: Number(count) }, (_, i) =>
      ctx.publicClient.readContract({
        address: UNISWAP.nonfungiblePositionManager,
        abi: nonfungiblePositionManagerAbi,
        functionName: "tokenOfOwnerByIndex",
        args: [owner, BigInt(i)],
      }),
    ),
  )) as bigint[];
  const raws = (await Promise.all(
    tokenIds.map((tokenId) =>
      ctx.publicClient.readContract({
        address: UNISWAP.nonfungiblePositionManager,
        abi: nonfungiblePositionManagerAbi,
        functionName: "positions",
        args: [tokenId],
      }),
    ),
  )) as PositionTuple[];

  const positions: LiquidityPullPosition[] = [];
  raws.forEach((raw, i) => {
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = raw;
    const match = wanted.get(
      `${token0.toLowerCase()}:${token1.toLowerCase()}:${fee}`,
    );
    if (!match || liquidity <= 0n) return;
    positions.push({
      tokenId: tokenIds[i],
      base: match.base,
      marketKey: match.key,
      pool: match.pool,
      token0,
      token1,
      tickLower: Number(tickLower),
      tickUpper: Number(tickUpper),
      seededLiquidity: liquidity,
    });
  });

  const uncovered = bases.filter((b) => !positions.some((p) => p.base === b));
  if (uncovered.length > 0) {
    throw new Error(
      `stress event liquidityPull found no environment-owned liquidity for ${uncovered.join(", ")} ` +
        `(looked at ${owner}, which holds ${count} position(s)). The seeded positions are minted by ` +
        "the deployer account (ADR 0016 §4 assumes the anvil default keys hold them); a custom " +
        "MNEMONIC in deployer/.env would put them somewhere this run cannot reach",
    );
  }

  // The decay leg deposits tokens back through the position manager, so it needs standing approval:
  // the deploy-time approval covered only the exact seeding amounts. Sequential because they all
  // come from one key and each mines a block -- concurrent sends would race on the nonce.
  const tokens = [...new Set(positions.flatMap((p) => [p.token0, p.token1]))];
  for (const token of tokens) {
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
          args: [UNISWAP.nonfungiblePositionManager, maxUint256],
        }),
      },
    );
  }

  // Balances matter for the restore: putting depth back after the price has moved needs a different
  // mix than the withdrawal returned, and the shortfall (if any) comes from the owner's own float.
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
    positions: positions.map((p) => ({
      tokenId: p.tokenId.toString(),
      market: p.marketKey,
      pool: p.pool,
      seededLiquidity: p.seededLiquidity.toString(),
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
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
///   - `increaseLiquidity` derives liquidity from token amounts at *execution* price, taking the
///     minimum of the two sides. The amounts are computed from a `slot0` read one block earlier, so
///     any price move in between makes the restore land short -- and the decay leg runs precisely
///     while a crash is recovering, so the price is moving by construction. Re-reading turns that
///     shortfall into the next block's delta instead of a silent permanent loss of depth.
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
    const key = pos.tokenId.toString();

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
    const target = scaleLiquidity(pos.seededLiquidity, mult);
    const applied = runtime.applied.get(key) ?? pos.seededLiquidity;
    if (target === applied) continue;
    const delta = target > applied ? target - applied : applied - target;
    const isRestore = target === pos.seededLiquidity;
    // Rounding noise is not worth a transaction. Closing the window is worth chasing -- leaving the
    // pool short hands the rest of the run a thinner venue -- but not forever: each restore is
    // computed at a price that has since moved, so a pathological case could otherwise re-send every
    // block for the rest of the run.
    if (!isRestore && (delta * 10_000n) / pos.seededLiquidity < MIN_DELTA_BPS)
      continue;
    if (isRestore) {
      const attempts = runtime.restoreAttempts.get(key) ?? 0;
      if (attempts >= MAX_RESTORE_ATTEMPTS) continue;
      if (
        (delta * 10_000n) / pos.seededLiquidity < MIN_DELTA_BPS &&
        attempts > 0
      )
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
    // rather than only the depth asked for. In-range pool liquidity rather than this position's,
    // because that is what decides an agent's slippage -- participant LPs included.
    let poolLiquidityBefore: string | undefined;
    try {
      poolLiquidityBefore = (
        (await ctx.publicClient.readContract({
          address: pos.pool,
          abi: poolAbi,
          functionName: "liquidity",
        })) as bigint
      ).toString();
    } catch {
      // Diagnostics only: a failed read must not hold up the withdrawal.
    }

    try {
      const hash =
        target < applied
          ? await withdraw(ctx, runtime, pos, applied - target, deadline, opts)
          : await deposit(ctx, runtime, pos, target - applied, deadline, opts);
      runtime.pending.set(key, { hash, blockIndex });
      allSettled = false;
      hashes.push(hash);
      logger.event({
        type: "stress_liquidity_pull",
        blockIndex,
        blockNumber,
        market: pos.marketKey,
        tokenId: key,
        direction: target < applied ? "withdraw" : "restore",
        depthMultiplier: mult,
        ...(poolLiquidityBefore !== undefined ? { poolLiquidityBefore } : {}),
        seededLiquidity: pos.seededLiquidity.toString(),
        previousLiquidity: applied.toString(),
        targetLiquidity: target.toString(),
        hash,
      });
    } catch (error) {
      // `applied` is untouched, so the next block recomputes the same delta and retries: a failed
      // send costs one block of depth rather than desynchronizing the pool for the whole run.
      logger.event({
        type: "stress_liquidity_pull_failed",
        blockIndex,
        blockNumber,
        market: pos.marketKey,
        tokenId: key,
        targetLiquidity: target.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Report the outcome once per window, and only when nothing is still in flight -- checking while a
  // restore sits in the mempool would read the pre-restore depth and cry incomplete.
  if (!windowOpen && allSettled && !runtime.restoreReported) {
    const anyMoved = runtime.positions.some(
      (p) =>
        (runtime.applied.get(p.tokenId.toString()) ?? p.seededLiquidity) !==
        p.seededLiquidity,
    );
    const exhausted = runtime.positions.every(
      (p) =>
        (runtime.restoreAttempts.get(p.tokenId.toString()) ?? 0) >=
        MAX_RESTORE_ATTEMPTS,
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
  pos: LiquidityPullPosition,
  blockIndex: number,
  logger: RunLogger,
): Promise<boolean> {
  const key = pos.tokenId.toString();
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
      market: pos.marketKey,
      tokenId: key,
      hash: pending.hash,
      submittedAtBlockIndex: pending.blockIndex,
    });
  }
  runtime.pending.delete(key);

  const actual = await readPositionLiquidity(ctx, pos).catch(() => null);
  if (actual !== null) runtime.applied.set(key, actual);
  if (status === "reverted") {
    logger.event({
      type: "stress_liquidity_pull_reverted",
      blockIndex,
      market: pos.marketKey,
      tokenId: key,
      hash: pending.hash,
      liquidity: actual === null ? undefined : actual.toString(),
    });
  }
  return true;
}

async function readPositionLiquidity(
  ctx: SimContext,
  pos: LiquidityPullPosition,
): Promise<bigint> {
  const raw = (await ctx.publicClient.readContract({
    address: UNISWAP.nonfungiblePositionManager,
    abi: nonfungiblePositionManagerAbi,
    functionName: "positions",
    args: [pos.tokenId],
  })) as PositionTuple;
  return raw[7];
}

// Withdraw depth and take the tokens out of the pool. decreaseLiquidity only credits tokensOwed, so
// the collect has to ride in the same multicall -- two sends from one key race on the nonce.
async function withdraw(
  ctx: SimContext,
  runtime: LiquidityPullRuntime,
  pos: LiquidityPullPosition,
  liquidity: bigint,
  deadline: bigint,
  opts: { priorityFeeWei: bigint },
): Promise<Hex> {
  const decrease = encodeFunctionData({
    abi: nonfungiblePositionManagerAbi,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId: pos.tokenId,
        liquidity,
        // Proportional exit at whatever the ratio is now: this event must change depth, not price,
        // so it takes both sides as the pool currently holds them rather than demanding a mix.
        amount0Min: 0n,
        amount1Min: 0n,
        deadline,
      },
    ],
  });
  const collect = encodeFunctionData({
    abi: nonfungiblePositionManagerAbi,
    functionName: "collect",
    args: [
      {
        tokenId: pos.tokenId,
        recipient: runtime.owner,
        amount0Max: maxUint128,
        amount1Max: maxUint128,
      },
    ],
  });
  return sendNoMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    runtime.ownerPk,
    {
      to: UNISWAP.nonfungiblePositionManager,
      data: encodeFunctionData({
        abi: nonfungiblePositionManagerAbi,
        functionName: "multicall",
        args: [[decrease, collect]],
      }),
      gas: RECONCILE_GAS,
    },
    opts.priorityFeeWei,
  );
}

// Put depth back. increaseLiquidity takes token amounts and derives the liquidity from them at
// *execution* price, taking the minimum of the two sides -- so these amounts, computed from the
// price as it is now, come up short by roughly the price move between this read and the mine. No
// safety margin is added for that: overshooting would just be withdrawn again next block. The
// reconcile loop reads the position back once the write settles and carries any shortfall into the
// next delta, which converges while the price is still moving.
async function depositCalldata(
  ctx: SimContext,
  pos: LiquidityPullPosition,
  liquidity: bigint,
  deadline: bigint,
): Promise<Hex> {
  const slot0 = (await ctx.publicClient.readContract({
    address: pos.pool,
    abi: poolAbi,
    functionName: "slot0",
  })) as readonly [bigint, number, number, number, number, number, boolean];
  const { amount0, amount1 } = getAmountsForLiquidity(
    slot0[0],
    getSqrtRatioAtTick(pos.tickLower),
    getSqrtRatioAtTick(pos.tickUpper),
    liquidity,
  );
  return encodeFunctionData({
    abi: nonfungiblePositionManagerAbi,
    functionName: "increaseLiquidity",
    args: [
      {
        tokenId: pos.tokenId,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline,
      },
    ],
  });
}

async function deposit(
  ctx: SimContext,
  runtime: LiquidityPullRuntime,
  pos: LiquidityPullPosition,
  liquidity: bigint,
  deadline: bigint,
  opts: { priorityFeeWei: bigint },
): Promise<Hex> {
  return sendNoMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    runtime.ownerPk,
    {
      to: UNISWAP.nonfungiblePositionManager,
      data: await depositCalldata(ctx, pos, liquidity, deadline),
      gas: RECONCILE_GAS,
    },
    opts.priorityFeeWei,
  );
}

// Teardown only: there is no next block to settle on, so this one waits for its receipt.
async function depositMined(
  ctx: SimContext,
  runtime: LiquidityPullRuntime,
  pos: LiquidityPullPosition,
  liquidity: bigint,
  deadline: bigint,
): Promise<Hex> {
  return sendAndMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    runtime.ownerPk,
    {
      to: UNISWAP.nonfungiblePositionManager,
      data: await depositCalldata(ctx, pos, liquidity, deadline),
    },
  );
}

// Record how the window closed. `applied` is depth read back from the chain after the last write
// settled, so this reports rather than checks -- the reconcile loop is what chases the pool back.
function reportRestored(
  runtime: LiquidityPullRuntime,
  at: { blockIndex: number; blockNumber: number } | null,
  logger: RunLogger,
): void {
  for (const pos of runtime.positions) {
    const key = pos.tokenId.toString();
    const actual = runtime.applied.get(key) ?? pos.seededLiquidity;
    const diff =
      actual > pos.seededLiquidity
        ? actual - pos.seededLiquidity
        : pos.seededLiquidity - actual;
    const driftBps = (diff * 10_000n) / pos.seededLiquidity;
    logger.event({
      type:
        driftBps > RESTORE_TOLERANCE_BPS
          ? "stress_liquidity_restore_incomplete"
          : "stress_liquidity_restored",
      ...(at ?? { phase: "teardown" }),
      market: pos.marketKey,
      tokenId: key,
      seededLiquidity: pos.seededLiquidity.toString(),
      actualLiquidity: actual.toString(),
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
    const key = pos.tokenId.toString();
    runtime.pending.delete(key);
    for (let attempt = 0; attempt < MAX_RESTORE_ATTEMPTS; attempt++) {
      let actual: bigint;
      try {
        actual = await readPositionLiquidity(ctx, pos);
      } catch (error) {
        logger.event({
          type: "stress_liquidity_teardown_failed",
          market: pos.marketKey,
          tokenId: key,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
      runtime.applied.set(key, actual);
      if (actual >= pos.seededLiquidity) break;
      const shortfall = pos.seededLiquidity - actual;
      if ((shortfall * 10_000n) / pos.seededLiquidity < MIN_DELTA_BPS) break;
      try {
        const block = await ctx.publicClient.getBlock();
        await depositMined(
          ctx,
          runtime,
          pos,
          shortfall,
          block.timestamp + 3600n,
        );
        logger.event({
          type: "stress_liquidity_teardown_restore",
          market: pos.marketKey,
          tokenId: key,
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
