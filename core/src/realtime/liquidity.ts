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

// Blocks to wait after the window closes before reading depth back: transactions are sent to the
// mempool (not mined inline), so the restore lands on the next block.
const RESTORE_VERIFY_LAG = 2;

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
  // Target depth already sent to the chain, keyed by tokenId. Each block sends only the delta
  // against this, so a target that has not changed costs nothing.
  applied: Map<string, bigint>;
  // Block index at which to verify the pools came back to their seeded depth (null = nothing to
  // verify right now).
  verifyAt: number | null;
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

  const positions: LiquidityPullPosition[] = [];
  for (let i = 0n; i < count; i++) {
    const tokenId = (await ctx.publicClient.readContract({
      address: UNISWAP.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "tokenOfOwnerByIndex",
      args: [owner, i],
    })) as bigint;
    const raw = (await ctx.publicClient.readContract({
      address: UNISWAP.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "positions",
      args: [tokenId],
    })) as PositionTuple;
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = raw;
    const match = wanted.get(
      `${token0.toLowerCase()}:${token1.toLowerCase()}:${fee}`,
    );
    if (!match || liquidity <= 0n) continue;
    positions.push({
      tokenId,
      base: match.base,
      marketKey: match.key,
      pool: match.pool,
      token0,
      token1,
      tickLower: Number(tickLower),
      tickUpper: Number(tickUpper),
      seededLiquidity: liquidity,
    });
  }

  const uncovered = bases.filter((b) => !positions.some((p) => p.base === b));
  if (uncovered.length > 0) {
    throw new Error(
      `stress event liquidityPull found no environment-owned liquidity for ${uncovered.join(", ")} ` +
        `(looked at ${owner}, which holds ${count} position(s)). The seeded positions are minted by ` +
        "the deployer account (ADR 0016 §4 assumes the anvil default keys hold them); a custom " +
        "MNEMONIC in deployer/.env would put them somewhere this run cannot reach",
    );
  }

  // The decay leg deposits tokens back through the position manager, so it needs standing approval.
  // The deploy-time approval covered only the exact seeding amounts.
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
  const balances: Record<string, string> = {};
  for (const token of tokens) {
    const bal = (await ctx.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
    balances[token] = bal.toString();
  }

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
    verifyAt: null,
  };
}

/// Move each tracked pool toward the depth the schedule asks for on this block. Returns the hashes
/// it submitted so the coordinator can attribute them.
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
  const hashes: Hex[] = [];
  let deadline = 0n;

  for (const pos of runtime.positions) {
    const key = pos.tokenId.toString();
    const mult = mults[pos.base] ?? 1;
    const target = scaleLiquidity(pos.seededLiquidity, mult);
    const applied = runtime.applied.get(key) ?? pos.seededLiquidity;
    if (target === applied) continue;
    // Rounding noise is not worth a transaction -- but closing the window is, however small the
    // remainder, because leaving it un-restored hands the next scenario a thinner venue.
    const delta = target > applied ? target - applied : applied - target;
    const isRestore = target === pos.seededLiquidity;
    if (!isRestore && (delta * 10_000n) / pos.seededLiquidity < MIN_DELTA_BPS)
      continue;

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
      runtime.applied.set(key, target);
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
        previousTarget: applied.toString(),
        targetLiquidity: target.toString(),
        hash,
      });
    } catch (error) {
      // Leave `applied` untouched: the next block recomputes the same delta and retries, so a single
      // failed send costs one block of depth rather than desynchronizing the pool for the whole run.
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

  const windowOpen = Object.keys(mults).length > 0;
  if (windowOpen) {
    runtime.verifyAt = blockIndex + RESTORE_VERIFY_LAG;
  } else if (runtime.verifyAt !== null && blockIndex >= runtime.verifyAt) {
    runtime.verifyAt = null;
    await verifyRestored(ctx, runtime, blockIndex, blockNumber, logger);
  }
  return hashes;
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

// Put depth back. increaseLiquidity takes token amounts and derives the liquidity from them, so the
// amounts are computed from the current price for exactly the liquidity being restored.
async function deposit(
  ctx: SimContext,
  runtime: LiquidityPullRuntime,
  pos: LiquidityPullPosition,
  liquidity: bigint,
  deadline: bigint,
  opts: { priorityFeeWei: bigint },
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
  return sendNoMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    runtime.ownerPk,
    {
      to: UNISWAP.nonfungiblePositionManager,
      data: encodeFunctionData({
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
      }),
      gas: RECONCILE_GAS,
    },
    opts.priorityFeeWei,
  );
}

// Read the depth back after a window closes. The window has to end with the venue where it started,
// or the rest of the run (and, under the scenario matrix, the next scenario) trades a pool this
// event quietly drained.
async function verifyRestored(
  ctx: SimContext,
  runtime: LiquidityPullRuntime,
  blockIndex: number,
  blockNumber: number,
  logger: RunLogger,
): Promise<void> {
  for (const pos of runtime.positions) {
    let actual: bigint;
    try {
      actual = (await ctx.publicClient
        .readContract({
          address: UNISWAP.nonfungiblePositionManager,
          abi: nonfungiblePositionManagerAbi,
          functionName: "positions",
          args: [pos.tokenId],
        })
        .then((raw) => (raw as PositionTuple)[7])) as bigint;
    } catch (error) {
      logger.event({
        type: "stress_liquidity_restore_unverified",
        blockIndex,
        market: pos.marketKey,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
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
      blockIndex,
      blockNumber,
      market: pos.marketKey,
      tokenId: pos.tokenId.toString(),
      seededLiquidity: pos.seededLiquidity.toString(),
      actualLiquidity: actual.toString(),
      driftBps: Number(driftBps),
    });
  }
}

// The envelope is a float; depth is a uint128. Scale through a fixed 1e9 grid so the same block
// index always produces the same target (a float multiply would not be reproducible across runs).
export function scaleLiquidity(seeded: bigint, mult: number): bigint {
  if (mult >= 1) return seeded;
  if (mult <= 0) return 0n;
  return (seeded * BigInt(Math.round(mult * 1e9))) / 1_000_000_000n;
}
