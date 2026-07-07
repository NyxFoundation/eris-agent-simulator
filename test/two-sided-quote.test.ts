import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeFunctionData,
  encodeFunctionResult,
  type PublicClient,
} from "viem";
import { twoSidedQuote } from "@eris/sdk/protocols/marketHelpers.js";
import { getCurveState } from "@eris/sdk/protocols/curve.js";
import { getBalancerState } from "@eris/sdk/protocols/balancer.js";
import { marketsFor, tokenInfo } from "@eris/sdk/markets.js";
import { balancerQueriesAbi } from "@eris/sdk/abis.js";

// Executable one-sided prices used by the mocks (per base). buy > sell = the pool charges a
// fee/impact on both directions, like a real venue.
const SELL_PX: Record<string, number> = { WETH: 2985, WBTC: 59700 };
const BUY_PX: Record<string, number> = { WETH: 3015, WBTC: 60300 };

function approx(actual: number, expected: number, tolBps = 0.5): void {
  const diffBps = Math.abs(actual / expected - 1) * 10_000;
  assert.ok(
    diffBps < tolBps,
    `expected ~${expected}, got ${actual} (${diffBps.toFixed(2)}bps off)`,
  );
}

test("twoSidedQuote: mid is the geometric mean and halfSpread the per-side cost", () => {
  const q = twoSidedQuote(2985, 3015);
  approx(q.priceUsdcPerWeth, Math.sqrt(2985 * 3015));
  approx(q.effectiveHalfSpreadBps, (Math.sqrt(3015 / 2985) - 1) * 10_000);
  assert.equal(q.sellPriceUsdcPerWeth, 2985);
  assert.equal(q.buyPriceUsdcPerWeth, 3015);
});

test("twoSidedQuote: a degenerate buy<sell clamps halfSpread at 0 (never negative cost)", () => {
  const q = twoSidedQuote(3010, 3000);
  assert.equal(q.effectiveHalfSpreadBps, 0);
});

// ---- curve: two-sided get_dy probe --------------------------------------------------------------

// Mock get_dy for every configured curve market: sell (i=baseIndex) quotes SELL_PX, buy quotes
// BUY_PX, decimals derived from the market config (works in both fork and local constants modes).
function curveMockClient(opts?: { failBuy?: boolean }): PublicClient {
  const byPool = new Map(
    marketsFor("curve").map((m) => [m.curve!.pool.toLowerCase(), m]),
  );
  return {
    readContract: async ({
      address,
      args,
    }: {
      address: string;
      args: readonly [bigint, bigint, bigint];
    }) => {
      const market = byPool.get(address.toLowerCase());
      if (!market) throw new Error(`unexpected pool ${address}`);
      const leg = market.curve!;
      const baseDec = tokenInfo(market.base).decimals;
      const quoteDec = tokenInfo(market.quote).decimals;
      const [i, , dx] = args;
      if (Number(i) === leg.baseIndex) {
        const baseAmt = Number(dx) / 10 ** baseDec;
        return BigInt(
          Math.round(baseAmt * SELL_PX[market.base]! * 10 ** quoteDec),
        );
      }
      if (opts?.failBuy) throw new Error("buy probe reverted");
      const quoteAmt = Number(dx) / 10 ** quoteDec;
      return BigInt(
        Math.round((quoteAmt / BUY_PX[market.base]!) * 10 ** baseDec),
      );
    },
  } as unknown as PublicClient;
}

test("getCurveState: two-sided probe reports executable mid + halfSpread", async () => {
  const state = await getCurveState(curveMockClient());
  const weth = state.markets.find((m) => m.market.base === "WETH")!;
  approx(weth.sellPriceUsdcPerWeth!, 2985);
  approx(weth.buyPriceUsdcPerWeth!, 3015);
  approx(weth.priceUsdcPerWeth, Math.sqrt(2985 * 3015));
  approx(
    weth.effectiveHalfSpreadBps!,
    (Math.sqrt(3015 / 2985) - 1) * 10_000,
    // halfSpread is a small difference of large numbers; integer-unit rounding of the mocked
    // amounts shifts it by O(0.01bps), so compare with an absolute-ish tolerance.
    100,
  );
  assert.equal(state.priceUsdcPerWeth, weth.priceUsdcPerWeth);
});

test("getCurveState: buy-probe failure degrades to the legacy one-sided quote", async () => {
  const state = await getCurveState(curveMockClient({ failBuy: true }));
  const weth = state.markets.find((m) => m.market.base === "WETH")!;
  approx(weth.priceUsdcPerWeth, 2985); // legacy sell quote
  assert.equal(weth.sellPriceUsdcPerWeth, undefined);
  assert.equal(weth.buyPriceUsdcPerWeth, undefined);
  assert.equal(weth.effectiveHalfSpreadBps, undefined);
});

// ---- balancer: two-sided querySwap probe --------------------------------------------------------

function balancerMockClient(): PublicClient {
  const byPoolId = new Map(
    marketsFor("balancer").map((m) => [m.balancer!.poolId.toLowerCase(), m]),
  );
  return {
    call: async ({ data }: { data: `0x${string}` }) => {
      const decoded = decodeFunctionData({ abi: balancerQueriesAbi, data });
      const single = decoded.args[0] as {
        poolId: string;
        assetIn: string;
        amount: bigint;
      };
      const market = byPoolId.get(single.poolId.toLowerCase());
      if (!market) throw new Error(`unexpected poolId ${single.poolId}`);
      const baseDec = tokenInfo(market.base).decimals;
      const quoteDec = tokenInfo(market.quote).decimals;
      const isSell =
        single.assetIn.toLowerCase() ===
        tokenInfo(market.base).address.toLowerCase();
      const out = isSell
        ? BigInt(
            Math.round(
              (Number(single.amount) / 10 ** baseDec) *
                SELL_PX[market.base]! *
                10 ** quoteDec,
            ),
          )
        : BigInt(
            Math.round(
              (Number(single.amount) / 10 ** quoteDec / BUY_PX[market.base]!) *
                10 ** baseDec,
            ),
          );
      return {
        data: encodeFunctionResult({
          abi: balancerQueriesAbi,
          functionName: "querySwap",
          result: out,
        }),
      };
    },
  } as unknown as PublicClient;
}

test("getBalancerState: two-sided probe reports executable mid + halfSpread", async () => {
  const state = await getBalancerState(balancerMockClient());
  const weth = state.markets.find((m) => m.market.base === "WETH")!;
  approx(weth.sellPriceUsdcPerWeth!, 2985);
  approx(weth.buyPriceUsdcPerWeth!, 3015);
  approx(weth.priceUsdcPerWeth, Math.sqrt(2985 * 3015));
  assert.equal(state.priceUsdcPerWeth, weth.priceUsdcPerWeth);
});
