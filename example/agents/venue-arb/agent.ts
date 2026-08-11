// venue-arb: a cross-venue arbitrage agent that swaps toward fair on the pool most deviated from
// fairPrice among the active AMM venues (uniswap/balancer/curve).
//
// "Most deviated" is qualified by "and fundable": under USDC-only funding the agent starts with no
// WETH, so a rich pool -- the one it would sell into -- is not a trade it can make. It buys the
// cheap venue instead and only sells once it is holding inventory. Taking the largest gap
// unconditionally is what made this agent self-reject every action it produced (issue #54).
import type { AgentAction, AgentObservation } from "@eris/sdk";
import { affordable, canFund } from "../lib/affordable.js";

type Venue = {
  id: "uniswap" | "balancer" | "curve";
  swapType: "swap" | "balancerSwap" | "curveSwap";
  price: number;
};

export function decide(obs: AgentObservation): AgentAction | null {
  const fair = obs.fairPriceUsdcPerWeth;
  const p = obs.protocols ?? {};
  const venues: Venue[] = [];
  if (p.uniswap?.pool)
    venues.push({
      id: "uniswap",
      swapType: "swap",
      price: p.uniswap.pool.priceUsdcPerWeth,
    });
  if (p.balancer)
    venues.push({
      id: "balancer",
      swapType: "balancerSwap",
      price: p.balancer.priceUsdcPerWeth,
    });
  if (p.curve)
    venues.push({
      id: "curve",
      swapType: "curveSwap",
      price: p.curve.priceUsdcPerWeth,
    });

  let best: Venue | undefined;
  let bestGap = 0;
  let skippedUnfundable = false;
  for (const v of venues) {
    if (!Number.isFinite(v.price) || v.price <= 0) continue; // exclude broken/uninitialized venues
    const gap = Math.abs(fair / v.price - 1);
    if (gap <= bestGap) continue;
    // Pool below fair -> WETH is cheap -> buy it with USDC. Pool above fair -> sell WETH.
    if (!canFund(obs, v.price < fair ? "USDC" : "WETH")) {
      skippedUnfundable = true;
      continue;
    }
    bestGap = gap;
    best = v;
  }

  if (!best || bestGap < 0.001) {
    return {
      type: "noop",
      reason: skippedUnfundable
        ? "the widest gaps need inventory this agent does not hold"
        : "no venue gap",
    };
  }

  const tokenIn = best.price < fair ? "USDC" : "WETH";
  const sizeBps = Math.min(2500, Math.max(250, Math.floor(bestGap * 200_000)));
  const amountIn = affordable(
    obs,
    tokenIn,
    (BigInt(
      tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits,
    ) *
      BigInt(sizeBps)) /
      10_000n,
  );
  // canFund said the wallet clears the dust floor, but the rule cap or the gap-derived size can
  // still land under it. Proposing it anyway would just be rejected.
  if (amountIn === 0n)
    return { type: "noop", reason: "affordable size is below the dust floor" };

  return {
    type: best.swapType,
    tokenIn,
    amountIn: amountIn.toString(),
    maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
    slippageBps: 75,
  };
}
