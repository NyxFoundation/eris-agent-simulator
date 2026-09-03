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
    // A tenth of the wallet on each side. There is no LP size cap any more, so the fraction is
    // this agent's own statement of how much inventory it is willing to tie up in a range.
    amountWethDesired: (BigInt(obs.balances.wethWei) / 10n).toString(),
    amountUsdcDesired: (BigInt(obs.balances.usdcUnits) / 10n).toString(),
    maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
    slippageBps: 100,
  };
}
