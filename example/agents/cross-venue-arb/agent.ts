// cross-venue-arb (GitHub #4): 2-leg arbitrage that buys on the cheapest venue and sells on the most
// expensive among uniswap/balancer/curve. Generalizes cv-bal-arb.ts (limited to bal<->curve) to the
// max-deviation pair across all 3 venues.
// Note: other fee tiers / Uniswap v2 are not in the observation, so they are out of scope (uni 0.05% + balancer + curve only).
// No RPC needed; semantic actions only.
//
// env:
//   CROSS_VENUE_SPREAD_BPS  minimum spread to trade (bps, default 10)
import type { AgentAction, AgentObservation } from "@eris/sdk";

const SPREAD_BPS = intEnv("CROSS_VENUE_SPREAD_BPS", 10);
const SIZE_BPS_MIN = 250;
const SIZE_BPS_MAX = 5000;
const SLIPPAGE_BPS = 75;

export function decide(
  obs: AgentObservation,
): AgentAction | Record<string, unknown> | null {
  try {
    const p = obs.protocols ?? {};
    const fee = obs.limits.defaultPriorityFeePerGasWei;
    const venues: Array<{ swapType: string; price: number }> = [];
    const uni = p.uniswap?.pool?.priceUsdcPerWeth;
    if (typeof uni === "number" && uni > 0)
      venues.push({ swapType: "swap", price: uni });
    const bal = p.balancer?.priceUsdcPerWeth;
    if (typeof bal === "number" && bal > 0)
      venues.push({ swapType: "balancerSwap", price: bal });
    const cv = p.curve?.priceUsdcPerWeth;
    if (typeof cv === "number" && cv > 0)
      venues.push({ swapType: "curveSwap", price: cv });
    if (venues.length < 2) {
      return { type: "noop", reason: "need >=2 venues" };
    }
    let lo = venues[0];
    let hi = venues[0];
    for (const v of venues) {
      if (v.price < lo.price) lo = v;
      if (v.price > hi.price) hi = v;
    }
    const spread = hi.price / lo.price - 1;
    if (spread < SPREAD_BPS / 10_000 || lo.swapType === hi.swapType) {
      return { type: "noop", reason: "spread too small" };
    }
    const sizeBps = Math.min(
      SIZE_BPS_MAX,
      Math.max(SIZE_BPS_MIN, Math.floor(spread * 200_000)),
    );
    // Delta neutralization: capping the buy leg and sell leg with independent USDC/WETH limits leaves the
    // WETH amounts mismatched, so a residual (directional) position accumulates every round. Instead, cap the
    // buy leg by "the USDC needed to buy the sellable WETH limit" and sell exactly the WETH bought (buy==sell so net delta~0).
    const maxUsdc = BigInt(obs.limits.maxUsdcInUnits);
    const maxWeth = BigInt(obs.limits.maxWethInWei);
    const priceScaled = BigInt(Math.max(1, Math.round(lo.price * 100))); // USDC*100/WETH
    // USDC (1e6) needed to buy maxWeth (wei) at lo.price = maxWeth * priceScaled / (100 * 1e12)
    const usdcForWethCap = (maxWeth * priceScaled) / (100n * 10n ** 12n);
    const usdcCap = maxUsdc < usdcForWethCap ? maxUsdc : usdcForWethCap;
    const usdcIn = (usdcCap * BigInt(sizeBps)) / 10_000n;
    // WETH (wei) acquired by the buy leg = usdcIn (1e6) * 1e18 / (lo.price * 1e6) = usdcIn * 1e12 * 100 / priceScaled
    const boughtWethWei = (usdcIn * 10n ** 12n * 100n) / priceScaled;
    // Sell 98% since slippage shrinks the received amount (matches delta while avoiding a naked short / exceeding balance).
    const wethIn = (boughtWethWei * 98n) / 100n;
    if (usdcIn <= 0n || wethIn <= 0n) {
      return { type: "noop", reason: "computed size zero" };
    }
    const bundle = {
      type: "bundle",
      actions: [
        {
          type: lo.swapType,
          tokenIn: "USDC",
          amountIn: usdcIn.toString(),
          slippageBps: SLIPPAGE_BPS,
        },
        {
          type: hi.swapType,
          tokenIn: "WETH",
          amountIn: wethIn.toString(),
          slippageBps: SLIPPAGE_BPS,
        },
      ],
      maxPriorityFeePerGasWei: fee,
    };
    return bundle;
  } catch (error) {
    return { type: "noop", reason: `error: ${error}` };
  }
}

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}
