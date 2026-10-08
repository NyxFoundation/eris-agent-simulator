// Whale order stress event (ADR 0017 regime 3).
//
// A single large market order that knocks the pool mid away from an unchanged fair price. That is
// the opposite dislocation from `crash`, where fair moves and the pools lag: here fair is where it
// always was and the *pool* is wrong, so the trade to find is the other side of the print rather
// than a directional call. It is also the one event whose entire content is market impact, which
// makes it the direct test of whether an agent sizes against depth.
//
// Executed by the coordinator on one block (it is a trade, not a multiplier on the price path), and
// placed by the same seed-driven schedule as every other stress event (ADR 0009).
import { parseUnits } from "viem";
import type { ResolvedStressEvent, StressEventConfig } from "./events.js";
import type { FlowOrderWire } from "../flowProcess.js";
import { tokenInfo } from "@eris/sdk/markets.js";

// The flow-wallet key the whale trades from. Registered and funded in every run, whale or not: a
// wallet that exists only when the schedule has a whale names the regime at block 0 to anyone who
// counts the setup blocks' senders or reads the wallet's balance (rules §3.3). See WHALE_ENDOWMENT.
export const WHALE_WALLET_KEY = "whale:uninformed";

// Multiplier over the *cumulative* same-side notional. Swaps quote at the pool price rather than at
// fair, and a buy has to cover slippage on the way in, so funding exactly the notional would make a
// whale fail on balance -- silently turning the regime into `calm` for the rest of that seed.
//
// Cumulative, not the largest single order: sizing on the max looks sufficient only because buys and
// sells replenish each other, and a seed that draws every whale on the same side (p ~ 1/4 to 1/16
// for the three to five config/regimes/whale.yaml draws) spends more than any single order. That is
// exactly the tail the headroom is supposed to cover.
const WHALE_FUNDING_HEADROOM = 2n;

const SWAP_TYPE = {
  uniswap: "swap",
  balancer: "balancerSwap",
  curve: "curveSwap",
} as const;

// Inventory the whale wallet needs so every scheduled order can actually be placed.
//
// `sell` spends the base, `buy` spends USDC. Both sides are funded for their own cumulative total
// rather than netted, because the schedule's order matters: three sells followed by a buy needs the
// full three sells' worth of base up front, no matter what the buy would have replenished later.
//
// Per base, because an event may target one (`{ type: whale, base: WBTC }`), and a WBTC whale funded
// in WETH is a whale that silently never happens. `prices` is the coordinator's per-base fair map.
export function whaleFunding(
  events: ResolvedStressEvent[],
  prices: Record<string, number>,
): { baseWei: Record<string, bigint>; usdcUnits: bigint } {
  const baseWei: Record<string, bigint> = {};
  let usdcTotal = 0;
  for (const event of events) {
    if (event.type !== "whale" || event.magnitude <= 0) continue;
    const base = event.base;
    const price = prices[base];
    if (!price || !Number.isFinite(price))
      throw new Error(
        `whale event targets ${base} but no fair price is available for it ` +
          `(known: ${Object.keys(prices).join(", ") || "none"})`,
      );
    if (event.side === "buy") {
      usdcTotal += event.magnitude * price;
    } else {
      const decimals = tokenInfo(base).decimals;
      baseWei[base] =
        (baseWei[base] ?? 0n) +
        parseUnits(event.magnitude.toFixed(decimals), decimals);
    }
  }
  for (const base of Object.keys(baseWei))
    baseWei[base] *= WHALE_FUNDING_HEADROOM;
  const usdcDecimals = tokenInfo("USDC").decimals;
  return {
    baseWei,
    usdcUnits:
      parseUnits(usdcTotal.toFixed(usdcDecimals), usdcDecimals) *
      WHALE_FUNDING_HEADROOM,
  };
}

// What the whale wallet is endowed with in every run, whatever the schedule drew.
//
// The amount used to be `whaleFunding` of the drawn schedule, funded only when there was a whale.
// Both named the regime before the first block: the wallet's WETH deposit is a transaction in the
// setup blocks, which an agent reads from the chain's history, and the balance itself is readable
// by address in every later epoch of the same matrix process (the environment's keys are fixed per
// process, walletKeys.ts). So every run funds the same amount, sized to cover the largest draw any
// official regime can make: config/regimes/whale.yaml at its ceiling is five 60 WETH orders on one
// side, 300 WETH, times the headroom -- 600 WETH, or 1.8M USDC at the $3,000 opening price. The USDC
// floor leaves a third on top so the opening fair can sit up to $4,000 before a buy-side draw needs
// more. test/regimeStartInvariance.test.ts holds every official regime's ceiling under this.
export const WHALE_ENDOWMENT: { baseWei: Record<string, bigint>; usdcUnits: bigint } = {
  baseWei: { WETH: parseUnits("600", 18) },
  usdcUnits: parseUnits("2400000", 6),
};

// The endowment a run funds: WHALE_ENDOWMENT, raised per asset only where the schedule needs more.
// An official regime never does (the test above), so its whale wallet is identical in every regime.
// A schedule that does -- the practice period funds a month of whales at its start -- gets what it
// needs rather than whales that fail on balance, and its regime is no secret anyway (the episode
// list is published).
export function whaleEndowment(
  events: ResolvedStressEvent[],
  prices: Record<string, number>,
): { baseWei: Record<string, bigint>; usdcUnits: bigint } {
  const needed = whaleFunding(events, prices);
  const baseWei: Record<string, bigint> = { ...WHALE_ENDOWMENT.baseWei };
  for (const [base, wei] of Object.entries(needed.baseWei))
    if (wei > (baseWei[base] ?? 0n)) baseWei[base] = wei;
  return {
    baseWei,
    usdcUnits:
      needed.usdcUnits > WHALE_ENDOWMENT.usdcUnits
        ? needed.usdcUnits
        : WHALE_ENDOWMENT.usdcUnits,
  };
}

// The most `whaleFunding` can ask for under these event configs, over every seed: each whale entry
// at its largest count and magnitude, all on the side that costs the most. Pure, so the test can hold
// a regime's ceiling under WHALE_ENDOWMENT without enumerating seeds.
export function whaleFundingCeiling(
  configs: StressEventConfig[],
  prices: Record<string, number>,
): { baseWei: Record<string, bigint>; usdcUnits: bigint } {
  const worst: ResolvedStressEvent[] = [];
  for (const c of configs) {
    if (c.type !== "whale") continue;
    const count = c.count ? c.count[1] : 1;
    const magnitude = c.magnitudeRange[1];
    const base = c.base ?? "WETH";
    const sides: Array<"buy" | "sell"> =
      c.side === "buy" ? ["buy"] : c.side === "sell" ? ["sell"] : ["buy", "sell"];
    for (let i = 0; i < count; i++)
      for (const side of sides)
        worst.push({ type: "whale", base, side, magnitude } as ResolvedStressEvent);
  }
  return whaleFunding(worst, prices);
}

// The order a whale event places. Pure: the caller submits it through the ordinary flow relay, so
// the print goes through the same signing, ordering and attribution path as any other flow order.
//
// A buy spends USDC (price up), a sell spends the base (price down) -- the same convention the flow
// bot uses, so an agent reading the tape cannot tell a whale from ordinary flow by its shape. Only
// its size gives it away, which is the point.
export function buildWhaleOrder(
  event: ResolvedStressEvent,
  fairPriceUsdcPerBase: number,
  priorityFeeWei: bigint,
): FlowOrderWire {
  if (event.type !== "whale")
    throw new Error(`buildWhaleOrder called with a ${event.type} event`);
  const venue = event.venue ?? "uniswap";
  const base = event.base;
  const baseDecimals = tokenInfo(base).decimals;
  const usdcDecimals = tokenInfo("USDC").decimals;
  const side = event.side ?? "sell";

  const amount =
    side === "sell"
      ? parseUnits(event.magnitude.toFixed(baseDecimals), baseDecimals)
      : parseUnits(
          (event.magnitude * fairPriceUsdcPerBase).toFixed(usdcDecimals),
          usdcDecimals,
        );

  return {
    protocol: venue,
    kind: "uninformed",
    walletKey: WHALE_WALLET_KEY,
    priorityFeeWei: priorityFeeWei.toString(),
    action: {
      type: SWAP_TYPE[venue],
      tokenIn: side === "buy" ? "USDC" : base,
      amountIn: amount.toString(),
      // A whale takes whatever the book gives: the whole content of this event is the impact, so
      // capping slippage would cap the event itself. minAmountOut 0 is deliberate.
      minAmountOut: "0",
      // Non-WETH bases need the market tag so the adapter can resolve the right pool; WETH omits it
      // to keep the action byte-identical to ordinary WETH flow.
      ...(base === "WETH" ? {} : { base }),
    } as unknown as FlowOrderWire["action"],
  };
}
