// A heartbeat, not a strategy. Once per window it swaps 1 USDC for WETH on Uniswap, and in the next
// window sells about that much WETH back, so the chain itself shows -- a blocks.csv row per window --
// that a transaction sent from outside the box still lands (infra/devnet/CHECKLIST.md, "canary").
// The operator keeps one registered for the whole practice period, so it has to cost nothing that
// adds up: two ~$1 swaps per pair of windows is a few dollars of fees over a month, where `random`
// (half its balance, most blocks) would be out of capital within the first day and stop beating.
import type { AgentAction, AgentObservation } from "@eris/sdk";

// 150 blocks = 5 minutes at the practice cadence: a dozen rows an hour, so the check "at least one
// row every hour" fails only when the path is actually down, not when a window happened to revert.
const EVERY_BLOCKS = Number(process.env.ERIS_CANARY_EVERY_BLOCKS ?? 150);
const USDC_IN = 1_000_000n; // 1 USDC (6 decimals)

/** The action for this observation, given the last window that already beat. Pure, for the test. */
export function canaryAction(
  obs: AgentObservation,
  lastWindow: number,
  everyBlocks: number = EVERY_BLOCKS,
): { window: number; action: AgentAction } {
  const window = Math.floor(Number(obs.blockNumber) / everyBlocks);
  if (window === lastWindow)
    return {
      window,
      action: { type: "noop", reason: "waiting for the next window" },
    };
  // Alternate the direction so the inventory stays where it started instead of drifting into WETH.
  const buy = window % 2 === 0;
  const amountIn = buy
    ? USDC_IN
    : BigInt(Math.floor(1e18 / obs.fairPriceUsdcPerWeth));
  const held = BigInt(buy ? obs.balances.usdcUnits : obs.balances.wethWei);
  if (held < amountIn)
    return {
      window,
      action: {
        type: "noop",
        reason: `not enough ${buy ? "USDC" : "WETH"} for the heartbeat`,
      },
    };
  return {
    window,
    action: {
      type: "swap",
      tokenIn: buy ? "USDC" : "WETH",
      amountIn: amountIn.toString(),
      maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
      slippageBps: 100,
    },
  };
}

// Module state resets when the runtime replaces the strategy worker (runtime/strategyRunner.ts);
// the cost of that is one extra beat, which is harmless.
let lastWindow = -1;

export function decide(obs: AgentObservation): AgentAction {
  const { window, action } = canaryAction(obs, lastWindow);
  lastWindow = window;
  return action;
}
