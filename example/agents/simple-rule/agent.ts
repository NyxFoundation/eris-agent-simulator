import type { AgentAction, AgentObservation } from "@eris/sdk";

export function decide(obs: AgentObservation): AgentAction | null {
  const pool = obs.protocols.uniswap!.pool.priceUsdcPerWeth;
  const fair = obs.fairPriceUsdcPerWeth;
  const gap = fair / pool - 1;
  if (Math.abs(gap) < 0.0015) {
    return { type: "noop", reason: "gap too small" };
  }
  const tokenIn = gap > 0 ? "USDC" : "WETH";
  // Size against the balance: nothing else bounds an order, so how much of the stack to commit is
  // the strategy's call.
  const held = BigInt(
    tokenIn === "WETH" ? obs.balances.wethWei : obs.balances.usdcUnits,
  );
  const sizeBps = Math.min(
    2500,
    Math.max(250, Math.floor(Math.abs(gap) * 200_000)),
  );
  const amountIn = (held * BigInt(sizeBps)) / 10_000n;
  if (amountIn <= 0n) return { type: "noop", reason: "nothing to trade with" };
  return {
    type: "swap",
    tokenIn,
    amountIn: amountIn.toString(),
    maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
    slippageBps: 50,
  };
}
