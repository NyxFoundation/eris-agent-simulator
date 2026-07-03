import type { AgentAction, AgentObservation } from "@eris/sdk";

let minted = false;

export function decide(obs: AgentObservation): AgentAction | null {
  const uni = obs.protocols.uniswap;
  if (!uni) return { type: "noop", reason: "uniswap unavailable" };
  if (minted || uni.positions.length > 0) {
    return { type: "noop", reason: "LP already opened" };
  }

  const spacing = uni.pool.tickSpacing;
  const center = Math.floor(uni.pool.tick / spacing) * spacing;
  minted = true;
  return {
    type: "mintLiquidity",
    tickLower: center - spacing * 20,
    tickUpper: center + spacing * 20,
    amountWethDesired: (BigInt(obs.limits.maxLpWethWei) / 10n).toString(),
    amountUsdcDesired: (BigInt(obs.limits.maxLpUsdcUnits) / 10n).toString(),
    maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
    slippageBps: 100,
  };
}
