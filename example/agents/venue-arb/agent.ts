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
    if (skippedUnfundable) {
      const acquire = acquireInventory(obs, venues);
      if (acquire) return acquire;
    }
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

// The round trip a cross-venue arbitrageur pays: one venue fee on the way in, one on the way out,
// plus slippage on both. Below this the spread does not cover getting in and out again.
const ROUND_TRIP_COST = 0.008; // 80bps

// Every venue above fair means the only trade on offer is "sell WETH", which USDC-only funding makes
// impossible (ADR 0019 §6 hands out no inventory). Doing nothing is one answer; the other is to buy
// the inventory, and the difference between them is a judgement about price, not about funding.
//
// The judgement here: buying above fair is only worth it when the *cross-venue* spread pays for the
// round trip. Selling to the richest venue is what earns; buying from the cheapest is the cost of
// being able to. Below the cost of getting in and out, buying inventory is just taking naked beta
// with extra steps -- which `mean - lambda*std` charges for twice (the drift and the variance).
function acquireInventory(
  obs: AgentObservation,
  venues: Venue[],
): AgentAction | null {
  const priced = venues.filter((v) => Number.isFinite(v.price) && v.price > 0);
  if (priced.length < 2) return null;
  const cheapest = priced.reduce((a, b) => (b.price < a.price ? b : a));
  const richest = priced.reduce((a, b) => (b.price > a.price ? b : a));
  const spread = richest.price / cheapest.price - 1;
  if (spread <= ROUND_TRIP_COST) return null;
  if (!canFund(obs, "USDC")) return null;

  // Size it to the leg that has to close: buying more than the rich venue can absorb leaves the
  // remainder as inventory this agent has no plan for.
  const amountIn = affordable(
    obs,
    "USDC",
    (BigInt(obs.limits.maxUsdcInUnits) *
      BigInt(Math.min(2500, Math.floor(spread * 200_000)))) /
      10_000n,
  );
  if (amountIn === 0n) return null;
  return {
    type: cheapest.swapType,
    tokenIn: "USDC",
    amountIn: amountIn.toString(),
    maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
    slippageBps: 75,
  };
}
