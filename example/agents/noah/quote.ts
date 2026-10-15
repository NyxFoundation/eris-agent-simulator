/**
 * Executable quotes at the size noah would actually trade, read from the venues' own quoting
 * contracts through the read-only client (Uniswap QuoterV2 / BalancerQueries.querySwap / Curve
 * get_dy). The observation only carries probe-size prices (0.1 base), and balancer/curve carry no
 * depth at all, so it cannot say what a 5 WETH sale clears at -- which is the number the whole
 * strategy is decided on. A read that fails returns null and the candidate is dropped: an unquoted
 * trade is the one this agent must not take.
 *
 * JP: 実サイズでの約定見積もり。観測には 0.1 base の probe 価格しか無く、balancer/curve は板の厚みも
 * 無いので、各 venue の見積もりコントラクトを読取専用クライアントで直接叩く。失敗は null（取引しない）。
 */
import type { Address, PublicClient } from "viem";
import { encodeFunctionData, decodeFunctionResult, zeroAddress } from "viem";
import { balancerQueriesAbi, curveTricryptoAbi, quoterV2Abi } from "@eris/sdk/abis.js";
import { BALANCER, UNISWAP } from "@eris/sdk/constants.js";
import { marketsFor, tokenInfo } from "@eris/sdk/markets.js";

export type Venue = "uniswap" | "balancer" | "curve";
export type Side = "sell" | "buy"; // sell: base -> USDC, buy: USDC -> base

type Leg = { tokenIn: Address; tokenOut: Address };

function legFor(venue: Venue, base: string, side: Side): Leg & { market: ReturnType<typeof marketsFor>[number] } | null {
  const market = marketsFor(venue).find((m) => m.base === base);
  if (!market) return null;
  const baseAddr = tokenInfo(market.base).address;
  const quoteAddr =
    venue === "balancer"
      ? market.balancer?.stable
      : venue === "curve"
        ? market.curve?.stable
        : tokenInfo(market.quote).address;
  if (!quoteAddr) return null;
  return side === "sell"
    ? { market, tokenIn: baseAddr, tokenOut: quoteAddr }
    : { market, tokenIn: quoteAddr, tokenOut: baseAddr };
}

async function quoteUniswap(client: PublicClient, leg: NonNullable<ReturnType<typeof legFor>>, amountIn: bigint): Promise<bigint> {
  const fee = leg.market.uniswap?.fee;
  if (fee === undefined) throw new Error("uniswap leg missing");
  const data = encodeFunctionData({
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: leg.tokenIn, tokenOut: leg.tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  const result = await client.call({ to: UNISWAP.quoterV2, data });
  const [out] = decodeFunctionResult({
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    data: result.data ?? "0x",
  });
  return out;
}

async function quoteBalancer(client: PublicClient, leg: NonNullable<ReturnType<typeof legFor>>, amountIn: bigint): Promise<bigint> {
  const poolId = leg.market.balancer?.poolId;
  if (!poolId) throw new Error("balancer leg missing");
  const data = encodeFunctionData({
    abi: balancerQueriesAbi,
    functionName: "querySwap",
    args: [
      { poolId, kind: 0, assetIn: leg.tokenIn, assetOut: leg.tokenOut, amount: amountIn, userData: "0x" },
      { sender: zeroAddress, fromInternalBalance: false, recipient: zeroAddress, toInternalBalance: false },
    ],
  });
  const result = await client.call({ to: BALANCER.queries, data });
  return decodeFunctionResult({
    abi: balancerQueriesAbi,
    functionName: "querySwap",
    data: result.data ?? "0x",
  });
}

async function quoteCurve(client: PublicClient, leg: NonNullable<ReturnType<typeof legFor>>, side: Side, amountIn: bigint): Promise<bigint> {
  const c = leg.market.curve;
  if (!c) throw new Error("curve leg missing");
  const [i, j] = side === "sell" ? [c.baseIndex, c.quoteIndex] : [c.quoteIndex, c.baseIndex];
  return (await client.readContract({
    address: c.pool,
    abi: curveTricryptoAbi,
    functionName: "get_dy",
    args: [BigInt(i), BigInt(j), amountIn],
  })) as bigint;
}

export type QuoteResult = { ok: true; out: bigint } | { ok: false; error: string };

// Output amount (raw units of the out token) for swapping amountIn on one venue. A revert is the
// venue refusing the size (no liquidity, range exhausted) -- an answer, not a bug: the caller drops
// the candidate and logs the reason.
export async function quoteOut(
  client: PublicClient,
  venue: Venue,
  base: string,
  side: Side,
  amountIn: bigint,
): Promise<QuoteResult> {
  if (amountIn <= 0n) return { ok: false, error: "non-positive amount" };
  const leg = legFor(venue, base, side);
  if (!leg) return { ok: false, error: `no ${venue} market for ${base}` };
  try {
    const out =
      venue === "uniswap"
        ? await quoteUniswap(client, leg, amountIn)
        : venue === "balancer"
          ? await quoteBalancer(client, leg, amountIn)
          : await quoteCurve(client, leg, side, amountIn);
    return { ok: true, out };
  } catch (err) {
    return { ok: false, error: `${venue} ${base} ${side} quote: ${(err as Error).message.split("\n")[0]}` };
  }
}
