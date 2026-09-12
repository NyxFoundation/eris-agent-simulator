/**
 * launch-confirm: waits for the tape to confirm demand before buying a new listing (issue #29).
 *
 * The judgment side of the `launch` regime. The only evidence that a wave is coming is the first
 * blocks of its ramp -- net USDC flowing *into* the pool, block after block. This strategy reads
 * the pool's Swap logs, enters only after `ERIS_LAUNCH_CONFIRM_BLOCKS` consecutive blocks of net
 * buying above a floor, sizes against the pool's USDC reserve rather than against its own stack,
 * and exits on the first block of net selling, on a maximum hold, or when the run is about to end.
 *
 * It forgoes the first part of every move (the confirmation lag is the price of not buying duds)
 * and it can be shaken out by one noisy block. Both are the trade-off the regime is about.
 *
 * Everything about the token is read from the chain through `ctx.publicClient`; see
 * lib/launchSwap.ts for the reads and the two transactions.
 */
import type { Address } from "viem";
import type { AgentAction, AgentContext, AgentObservation } from "@eris/sdk";
import { TOKENS } from "@eris/sdk/constants.js";
import {
  applySlippage,
  bpsOf,
  launchPoolState,
  launchPools,
  numberEnv,
  poolFee,
  poolFlow,
  quoteLaunch,
  swapBundle,
  tokenBalance,
  type LaunchPool,
} from "../lib/launchSwap.js";

// Consecutive blocks of net buying before the strategy believes a wave is real.
const CONFIRM_BLOCKS = numberEnv("ERIS_LAUNCH_CONFIRM_BLOCKS", 3);
// A block counts as net buying only if the net USDC into the pool is at least this fraction of
// the pool's USDC reserve. Below it the tape is noise, not a ramp.
const MIN_FLOW_BPS = numberEnv("ERIS_LAUNCH_MIN_FLOW_BPS", 25);
// Fraction of the USDC balance committed per launch, in bps ...
const SIZE_BPS = numberEnv("ERIS_LAUNCH_SIZE_BPS", 2000);
// ... capped at this fraction of the pool's USDC reserve, so a $20k pool is not hit with a $5k
// order that moves it 25% against itself.
const MAX_RESERVE_BPS = numberEnv("ERIS_LAUNCH_MAX_RESERVE_BPS", 1000);
// Sell on the first block whose net flow is out of the pool by at least this much of the reserve.
const EXIT_FLOW_BPS = numberEnv("ERIS_LAUNCH_EXIT_FLOW_BPS", 10);
// Sell anyway after this many blocks, and when this many remain.
const MAX_HOLD_BLOCKS = numberEnv("ERIS_LAUNCH_MAX_HOLD_BLOCKS", 60);
const EXIT_BEFORE_END_BLOCKS = numberEnv("ERIS_LAUNCH_EXIT_BLOCKS", 12);
const SLIPPAGE_BPS = numberEnv("ERIS_LAUNCH_SLIPPAGE_BPS", 300);
const MIN_USDC_UNITS = 1_000_000n;

type Watch = {
  pool: LaunchPool;
  fee: number;
  // The last block whose Swap logs were read.
  readThrough: number;
  buyStreak: number;
  entered?: { block: number; exiting: boolean; done: boolean };
};

const watches = new Map<string, Watch>();

export async function decide(
  obs: AgentObservation,
  ctx: AgentContext,
): Promise<AgentAction | Record<string, unknown>> {
  const block = Number(obs.blockNumber);
  const fee = obs.limits.defaultPriorityFeePerGasWei;
  const self = ctx.address as Address;
  const remaining = obs.blocksRemaining ?? Number.POSITIVE_INFINITY;

  // ---- register every launch pool the registry shows ----
  for (const pool of launchPools(obs)) {
    if (pool.mine) continue;
    const key = pool.pool.toLowerCase();
    if (watches.has(key)) continue;
    watches.set(key, {
      pool,
      fee: await poolFee(ctx.publicClient, pool.pool),
      // Start reading from the block after registration: the listing's own seed is not demand.
      readThrough: Math.max(pool.registeredAtBlock, block - 1),
      buyStreak: 0,
    });
  }

  // ---- read the tape since the last look, one pool at a time ----
  let action: Record<string, unknown> | null = null;
  const notes: string[] = [];
  for (const w of watches.values()) {
    if (w.entered?.done) continue;
    const state = await launchPoolState(ctx.publicClient, w.pool);
    const reserve = state.usdcReserveUnits;
    const flow = await poolFlow(
      ctx.publicClient,
      w.pool,
      w.readThrough + 1,
      block,
    );
    w.readThrough = block;
    const net = flow.usdcInUnits - flow.usdcOutUnits;
    const netBps = reserve > 0n ? Number((net * 10_000n) / reserve) : 0;
    if (net > 0n && netBps >= MIN_FLOW_BPS) w.buyStreak++;
    else if (net < 0n) w.buyStreak = 0;
    notes.push(
      `${w.pool.pool.slice(0, 8)} net ${netBps}bps streak ${w.buyStreak}`,
    );
    if (action) continue;

    if (w.entered) {
      // ---- exit? ----
      const held = await tokenBalance(ctx.publicClient, w.pool.token, self);
      if (held === 0n) {
        if (w.entered.exiting) w.entered.done = true;
        continue;
      }
      const sellSignal = net < 0n && -netBps >= EXIT_FLOW_BPS;
      const due =
        sellSignal ||
        block - w.entered.block >= MAX_HOLD_BLOCKS ||
        remaining <= EXIT_BEFORE_END_BLOCKS;
      if (!due) continue;
      let quoted: bigint;
      try {
        quoted = await quoteLaunch(ctx.publicClient, {
          tokenIn: w.pool.token,
          tokenOut: TOKENS.USDC.address,
          fee: w.fee,
          amountIn: held,
        });
      } catch (error) {
        notes.push(`sell quote failed: ${String(error).split("\n")[0]}`);
        continue;
      }
      if (quoted < MIN_USDC_UNITS) {
        w.entered.done = true;
        continue;
      }
      w.entered.exiting = true;
      ctx.log({
        round: obs.round,
        reason: `selling ${held} tokens on ${w.pool.pool}: ${
          sellSignal
            ? `net selling ${-netBps}bps of reserve`
            : remaining <= EXIT_BEFORE_END_BLOCKS
              ? `${remaining} blocks remain`
              : `held ${block - w.entered.block} blocks`
        }`,
        signals: { quotedUsdcUnits: Number(quoted), netFlowBps: netBps },
      });
      action = swapBundle({
        tokenIn: w.pool.token,
        tokenOut: TOKENS.USDC.address,
        fee: w.fee,
        recipient: self,
        amountIn: held,
        minOut: applySlippage(quoted, SLIPPAGE_BPS),
        reason: "launch-confirm exit",
        maxPriorityFeePerGasWei: fee,
      });
      continue;
    }

    // ---- enter? ----
    if (w.buyStreak < CONFIRM_BLOCKS || remaining <= EXIT_BEFORE_END_BLOCKS)
      continue;
    const usdc = BigInt(obs.balances.usdcUnits);
    const amountIn = min(
      bpsOf(usdc, SIZE_BPS),
      bpsOf(reserve, MAX_RESERVE_BPS),
    );
    if (amountIn < MIN_USDC_UNITS) continue;
    let quoted: bigint;
    try {
      quoted = await quoteLaunch(ctx.publicClient, {
        tokenIn: TOKENS.USDC.address,
        tokenOut: w.pool.token,
        fee: w.fee,
        amountIn,
      });
    } catch (error) {
      notes.push(`buy quote failed: ${String(error).split("\n")[0]}`);
      continue;
    }
    w.entered = { block, exiting: false, done: false };
    ctx.log({
      round: obs.round,
      reason: `buying ${amountIn} USDC units of ${w.pool.token}: ${w.buyStreak} blocks of net buying, last ${netBps}bps of a ${reserve} USDC-unit reserve, price ${state.priceUsdcPerToken.toFixed(4)}`,
      signals: {
        amountInUsdcUnits: Number(amountIn),
        quotedTokens: Number(quoted),
        buyStreak: w.buyStreak,
        priceUsdcPerToken: state.priceUsdcPerToken,
      },
    });
    action = swapBundle({
      tokenIn: TOKENS.USDC.address,
      tokenOut: w.pool.token,
      fee: w.fee,
      recipient: self,
      amountIn,
      minOut: applySlippage(quoted, SLIPPAGE_BPS),
      reason: "launch-confirm entry",
      maxPriorityFeePerGasWei: fee,
    });
  }

  if (action) return action;
  ctx.log({
    round: obs.round,
    reason:
      watches.size === 0
        ? "no launch pool on the registry yet"
        : `watching ${watches.size} pool(s): ${notes.join("; ")}`,
    signals: {
      launchPools: watches.size,
      blocksRemaining: Number.isFinite(remaining) ? remaining : -1,
    },
  });
  return { type: "noop", reason: "no confirmed demand" };
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
