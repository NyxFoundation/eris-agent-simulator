import type { AgentAction, AgentObservation } from "@eris/sdk";

export function decide(obs: AgentObservation): AgentAction | null {
  const pool = obs.protocols.uniswap!.pool.priceUsdcPerWeth;
  const fair = obs.fairPriceUsdcPerWeth;
  const gap = fair / pool - 1;
  if (Math.abs(gap) < 0.0015) {
    return { type: "noop", reason: "gap too small" };
  }
  const tokenIn = gap > 0 ? "USDC" : "WETH";
  const max = BigInt(
    tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits,
  );
  const sizeBps = Math.min(
    2500,
    Math.max(250, Math.floor(Math.abs(gap) * 200_000)),
  );
  const amountIn = (max * BigInt(sizeBps)) / 10_000n;
  return {
    type: "swap",
    tokenIn,
    amountIn: amountIn.toString(),
    maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
    slippageBps: 50,
  };
}
