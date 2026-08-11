// my-arb: the starting point for a submission. Copy this directory, rename it, and edit.
//
// It is deliberately the simplest thing that trades: compare each venue's pool price against fair,
// and swap toward fair on the venue that has moved furthest. Everything interesting -- sizing,
// fee awareness, two-leg execution, inventory management -- is left out so there is room to add it.
// See venue-arb, clean-arb and multi-arb for progressively less naive versions.
//
// The one thing that is NOT simplified is the funding check, because leaving it out does not make
// an agent naive, it makes it broken: with USDC-only funding the sell leg has no inventory behind
// it, the runtime rejects the action, and the agent scores exactly like one that chose not to trade
// (issue #54 -- four bundled agents shipped with that bug).
import type { AgentAction, AgentObservation } from "@eris/sdk";
import { affordable, canFund } from "../lib/affordable.js";

// Only trade when a venue is this far from fair. Too low and fees eat the edge; too high and the
// agent sits out the run. A good first thing to tune.
const MIN_GAP = 0.001; // 10 bps
// Fraction of the per-round limit to send. Flat on purpose -- scaling this with the gap is an
// obvious improvement.
const SIZE_BPS = 1000n; // 10%

type Venue = {
  swapType: "swap" | "balancerSwap" | "curveSwap";
  price: number;
};

export function decide(obs: AgentObservation): AgentAction | null {
  const fair = obs.fairPriceUsdcPerWeth;
  const p = obs.protocols ?? {};
  const venues: Venue[] = [];
  if (p.uniswap?.pool)
    venues.push({ swapType: "swap", price: p.uniswap.pool.priceUsdcPerWeth });
  if (p.balancer)
    venues.push({
      swapType: "balancerSwap",
      price: p.balancer.priceUsdcPerWeth,
    });
  if (p.curve)
    venues.push({ swapType: "curveSwap", price: p.curve.priceUsdcPerWeth });

  let best: Venue | undefined;
  let bestGap = MIN_GAP;
  for (const v of venues) {
    if (!Number.isFinite(v.price) || v.price <= 0) continue;
    const gap = Math.abs(fair / v.price - 1);
    // Pool below fair -> WETH is cheap -> buy it with USDC. Above -> sell WETH, which needs WETH.
    if (gap <= bestGap || !canFund(obs, v.price < fair ? "USDC" : "WETH"))
      continue;
    bestGap = gap;
    best = v;
  }
  if (!best) return { type: "noop", reason: "no fundable gap worth taking" };

  const tokenIn = best.price < fair ? "USDC" : "WETH";
  const amountIn = affordable(
    obs,
    tokenIn,
    (BigInt(
      tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits,
    ) *
      SIZE_BPS) /
      10_000n,
  );
  if (amountIn === 0n) return { type: "noop", reason: "size below the floor" };

  return {
    type: best.swapType,
    tokenIn,
    amountIn: amountIn.toString(),
    maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
    slippageBps: 75,
  };
}
