// cross-venue-arb (GitHub #4): 2-leg arbitrage that buys on the cheapest venue and sells on the most
// expensive among uniswap/balancer/curve. Generalizes cv-bal-arb.ts (limited to bal<->curve) to the
// max-deviation pair across all 3 venues.
// Note: other fee tiers / Uniswap v2 are not in the observation, so they are out of scope (uni 0.05% + balancer + curve only).
// No RPC needed; semantic actions only.
//
// env:
//   CROSS_VENUE_SPREAD_BPS  minimum spread to trade (bps, default 10)
import type { AgentAction, AgentObservation } from "@eris/sdk";
import { marketViews } from "../lib/markets.js";

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
    // Scan every active base, not just WETH (ADR 0013). The bundle is delta-neutral inside one
    // market, so the base has to be the same on both legs -- what changes is which market offers
    // the widest venue-to-venue spread this round.
    type Pick = {
      base: string;
      decimals: number;
      lo: { swapType: string; price: number };
      hi: { swapType: string; price: number };
      spread: number;
    };
    let pick: Pick | null = null;
    for (const view of marketViews(obs)) {
      if (view.venues.length < 2) continue;
      let lo = view.venues[0];
      let hi = view.venues[0];
      for (const v of view.venues) {
        if (v.price < lo.price) lo = v;
        if (v.price > hi.price) hi = v;
      }
      if (lo.swapType === hi.swapType) continue;
      const spread = hi.price / lo.price - 1;
      if (spread < SPREAD_BPS / 10_000) continue;
      if (pick === null || spread > pick.spread)
        pick = {
          base: view.base,
          decimals: view.baseDecimals,
          lo,
          hi,
          spread,
        };
    }
    if (pick === null) {
      return { type: "noop", reason: "spread too small" };
    }
    const spread = pick.spread;
    const lo = pick.lo;
    const hi = pick.hi;
    const sizeBps = Math.min(
      SIZE_BPS_MAX,
      Math.max(SIZE_BPS_MIN, Math.floor(spread * 200_000)),
    );
    // Delta neutralization: buy with USDC and sell exactly what was bought, so net delta ~ 0. The
    // buy leg is sized as a fraction of the USDC balance -- there is no per-order cap to size
    // against, and the sell leg follows the buy rather than being capped independently (capping the
    // two separately is what used to leave a residual directional position every round).
    const usdcBal = BigInt(obs.balances.usdcUnits || "0");
    const baseScale = 10n ** BigInt(pick.decimals);
    const priceScaled = BigInt(Math.max(1, Math.round(lo.price * 100))); // USDC*100/base
    const usdcIn = (usdcBal * BigInt(sizeBps)) / 10_000n;
    // base acquired by the buy leg at lo.price
    const boughtBase = (usdcIn * 100n * baseScale) / (priceScaled * 1_000_000n);
    // Sell 98% since slippage shrinks the received amount (matches delta while avoiding a naked
    // short / exceeding balance).
    const baseIn = (boughtBase * 98n) / 100n;
    if (usdcIn <= 0n || baseIn <= 0n) {
      return { type: "noop", reason: "computed size zero" };
    }
    const withBase = (a: Record<string, unknown>): Record<string, unknown> =>
      pick.base === "WETH" ? a : { ...a, base: pick.base };
    const bundle = {
      type: "bundle",
      actions: [
        withBase({
          type: lo.swapType,
          tokenIn: "USDC",
          amountIn: usdcIn.toString(),
          slippageBps: SLIPPAGE_BPS,
        }),
        withBase({
          type: hi.swapType,
          tokenIn: pick.base,
          amountIn: baseIn.toString(),
          slippageBps: SLIPPAGE_BPS,
        }),
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
