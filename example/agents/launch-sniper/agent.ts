/**
 * launch-sniper: buys every new listing at first sight and sells after a fixed hold (issue #29).
 *
 * The naive side of the `launch` regime. A token and its USDC pool appear mid-run through the
 * registry; this strategy does not ask whether demand will follow -- it buys a fixed fraction of
 * its USDC the block it sees the pool, holds `ERIS_LAUNCH_HOLD_BLOCKS`, and sells whatever it
 * holds. It wins on a launch whose wave arrives early (it is in before the ramp) and loses on a
 * dud (it bought a token nobody else will, and sells it back into its own price impact).
 *
 * Under the round-trip rule (ADR 0022) a token balance is worth nothing at the bell, so the exit
 * is not optional: the strategy also sells when the run is about to end, whatever the hold says.
 *
 * Everything about the token is read from the chain through `ctx.publicClient` -- the observation
 * carries the registry entry and nothing else about a token the run does not price. See
 * lib/launchSwap.ts for the reads and the two transactions.
 */
import type { Address } from "viem";
import type { AgentAction, AgentContext, AgentObservation } from "@eris/sdk";
import { TOKENS } from "@eris/sdk/constants.js";
import {
  applySlippage,
  bpsOf,
  launchPools,
  numberEnv,
  poolFee,
  quoteLaunch,
  swapBundle,
  tokenBalance,
  type LaunchPool,
} from "../lib/launchSwap.js";

// Fraction of the USDC balance spent per launch, in bps. Three launches at 20% each is 60% of the
// stack committed to tokens that may be worth nothing.
const SIZE_BPS = numberEnv("ERIS_LAUNCH_SIZE_BPS", 2000);
// Blocks to hold before selling. The wave's ramp is 6-12 blocks and its hold 20-40; selling inside
// the hold is selling into the wave's own bid.
const HOLD_BLOCKS = numberEnv("ERIS_LAUNCH_HOLD_BLOCKS", 30);
// Sell everything when this many blocks remain, hold or no hold: a token at the bell is worth zero.
const EXIT_BEFORE_END_BLOCKS = numberEnv("ERIS_LAUNCH_EXIT_BLOCKS", 12);
const SLIPPAGE_BPS = numberEnv("ERIS_LAUNCH_SLIPPAGE_BPS", 300);
// Below this the position is dust; selling it costs more gas than it returns.
const MIN_USDC_UNITS = 1_000_000n;

type Position = {
  pool: LaunchPool;
  fee: number;
  enteredBlock: number;
  // A sell has been submitted; the next block confirms it by the balance reading zero.
  exiting: boolean;
  done: boolean;
};

const positions = new Map<string, Position>();

export async function decide(
  obs: AgentObservation,
  ctx: AgentContext,
): Promise<AgentAction | Record<string, unknown>> {
  const block = Number(obs.blockNumber);
  const fee = obs.limits.defaultPriorityFeePerGasWei;
  const self = ctx.address as Address;
  const pools = launchPools(obs).filter((p) => !p.mine);
  const remaining = obs.blocksRemaining ?? Number.POSITIVE_INFINITY;

  // ---- exits first: a sale that is due matters more than a new entry ----
  for (const pos of positions.values()) {
    if (pos.done) continue;
    const held = await tokenBalance(ctx.publicClient, pos.pool.token, self);
    if (held === 0n) {
      if (pos.exiting) pos.done = true;
      continue;
    }
    const due =
      block - pos.enteredBlock >= HOLD_BLOCKS ||
      remaining <= EXIT_BEFORE_END_BLOCKS;
    if (!due) continue;
    let quoted: bigint;
    try {
      quoted = await quoteLaunch(ctx.publicClient, {
        tokenIn: pos.pool.token,
        tokenOut: TOKENS.USDC.address,
        fee: pos.fee,
        amountIn: held,
      });
    } catch (error) {
      ctx.log({
        round: obs.round,
        reason: `sell quote failed on ${pos.pool.pool}: ${String(error).split("\n")[0]}`,
      });
      continue;
    }
    if (quoted < MIN_USDC_UNITS) {
      // Not worth a transaction, and not worth tracking: the loss is already in the balance.
      pos.done = true;
      ctx.log({
        round: obs.round,
        reason: `abandoning ${pos.pool.pool}: ${held} tokens quote ${quoted} USDC units`,
      });
      continue;
    }
    pos.exiting = true;
    ctx.log({
      round: obs.round,
      reason: `selling ${held} tokens on ${pos.pool.pool} for ~${quoted} USDC units after ${block - pos.enteredBlock} blocks`,
      signals: {
        quotedUsdcUnits: Number(quoted),
        heldBlocks: block - pos.enteredBlock,
      },
    });
    return swapBundle({
      tokenIn: pos.pool.token,
      tokenOut: TOKENS.USDC.address,
      fee: pos.fee,
      recipient: self,
      amountIn: held,
      minOut: applySlippage(quoted, SLIPPAGE_BPS),
      reason: "launch-sniper exit",
      maxPriorityFeePerGasWei: fee,
    });
  }

  // ---- entries: the first pool this agent has not bought ----
  if (remaining > EXIT_BEFORE_END_BLOCKS) {
    for (const pool of pools) {
      if (positions.has(pool.pool.toLowerCase())) continue;
      const usdc = BigInt(obs.balances.usdcUnits);
      const amountIn = bpsOf(usdc, SIZE_BPS);
      if (amountIn < MIN_USDC_UNITS) {
        ctx.log({
          round: obs.round,
          reason: `new listing ${pool.pool} but only ${usdc} USDC units left`,
        });
        break;
      }
      const tier = await poolFee(ctx.publicClient, pool.pool);
      let quoted: bigint;
      try {
        quoted = await quoteLaunch(ctx.publicClient, {
          tokenIn: TOKENS.USDC.address,
          tokenOut: pool.token,
          fee: tier,
          amountIn,
        });
      } catch (error) {
        ctx.log({
          round: obs.round,
          reason: `buy quote failed on ${pool.pool}: ${String(error).split("\n")[0]}`,
        });
        continue;
      }
      positions.set(pool.pool.toLowerCase(), {
        pool,
        fee: tier,
        enteredBlock: block,
        exiting: false,
        done: false,
      });
      ctx.log({
        round: obs.round,
        reason: `buying ${amountIn} USDC units of ${pool.token} on ${pool.pool} at first sight (registered block ${pool.registeredAtBlock})`,
        signals: {
          amountInUsdcUnits: Number(amountIn),
          quotedTokens: Number(quoted),
        },
      });
      return swapBundle({
        tokenIn: TOKENS.USDC.address,
        tokenOut: pool.token,
        fee: tier,
        recipient: self,
        amountIn,
        minOut: applySlippage(quoted, SLIPPAGE_BPS),
        reason: "launch-sniper entry",
        maxPriorityFeePerGasWei: fee,
      });
    }
  }

  const open = [...positions.values()].filter((p) => !p.done).length;
  ctx.log({
    round: obs.round,
    reason:
      pools.length === 0
        ? "no launch pool on the registry yet"
        : `${pools.length} launch pool(s), ${open} position(s) held, none due`,
    signals: { launchPools: pools.length, openPositions: open },
  });
  return { type: "noop", reason: "nothing due" };
}
