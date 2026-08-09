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
import type { ResolvedStressEvent } from "./events.js";
import type { FlowOrderWire } from "../flowProcess.js";
import { tokenInfo } from "@eris/sdk/markets.js";

// The flow-wallet key the whale trades from. Registered in flowWalletMap only when the schedule
// actually contains a whale, so ordinary runs are unaffected.
export const WHALE_WALLET_KEY = "whale:uninformed";

// How much more than the largest scheduled order to endow the whale wallet with. Swaps quote at the
// pool price rather than at fair, and a buy has to cover slippage on the way in, so funding exactly
// the notional would make the largest whale of a run fail on balance -- silently turning the regime
// into `calm` for that seed.
const WHALE_FUNDING_HEADROOM = 3n;

const SWAP_TYPE = {
  uniswap: "swap",
  balancer: "balancerSwap",
  curve: "curveSwap",
} as const;

// Inventory the whale wallet needs so every scheduled order can actually be placed.
// `sell` orders spend the base, `buy` orders spend USDC, and which one a seed drew is already
// resolved, but funding both sides is simpler than reasoning about it and costs nothing on a mock
// chain.
export function whaleFunding(
  events: ResolvedStressEvent[],
  fairPriceUsdcPerBase: number,
  baseSymbol = "WETH",
): { baseWei: bigint; usdcUnits: bigint } {
  const largest = events
    .filter((e) => e.type === "whale")
    .reduce((max, e) => Math.max(max, e.magnitude), 0);
  if (largest <= 0) return { baseWei: 0n, usdcUnits: 0n };
  const decimals = tokenInfo(baseSymbol).decimals;
  const baseWei =
    parseUnits(largest.toFixed(decimals), decimals) * WHALE_FUNDING_HEADROOM;
  const usdcUnits =
    parseUnits(
      (largest * fairPriceUsdcPerBase).toFixed(tokenInfo("USDC").decimals),
      tokenInfo("USDC").decimals,
    ) * WHALE_FUNDING_HEADROOM;
  return { baseWei, usdcUnits };
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
