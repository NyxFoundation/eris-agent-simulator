import test from "node:test";
import assert from "node:assert/strict";
import { marketViews } from "../example/agents/lib/markets.js";
import type { AgentObservation } from "@eris/sdk/types.js";

// marketViews is a pure function independent of the registry, so we can hand-build an observation to exercise every base path.
function baseObs(): AgentObservation {
  return {
    kind: "observation",
    runId: "t",
    round: 1,
    blockNumber: "1",
    agentAddress: "0x0000000000000000000000000000000000000001",
    fairPriceUsdcPerWeth: 3000,
    oraclePrices: { wethUsd: 3000, usdcUsd: 1 },
    enabledProtocols: ["uniswap", "balancer", "curve"],
    balances: { ethWei: "1", wethWei: "5", usdcUnits: "100" },
    inventory: { valueUsdc: 0, weth: 0, usdc: 0, eth: 0 },
    history: [],
    limits: {
      maxWethInWei: "100",
      maxUsdcInUnits: "100",
      defaultPriorityFeePerGasWei: "10",
      maxPriorityFeePerGasWei: "20",
      defaultSlippageBps: 50,
      maxBundleActions: 5,
      maxLpWethWei: "100",
      maxLpUsdcUnits: "100",
      maxOpenPositions: 5,
      maxGmxSizeUsd: "0",
      maxAaveSupplyWethWei: "0",
      maxAaveBorrowUsdcUnits: "0",
    },
    protocols: {
      uniswap: {
        pool: {
          pair: "WETH/USDC",
          fee: 500,
          priceUsdcPerWeth: 2990,
          tick: 0,
          tickSpacing: 10,
        },
        positions: [],
      },
      balancer: { priceUsdcPerWeth: 3010 },
      curve: { priceUsdcPerWeth: 3000 },
    },
  };
}

test("marketViews: a WETH-only observation returns 1 view, no base, and all venue prices", () => {
  const views = marketViews(baseObs());
  assert.equal(views.length, 1);
  const w = views[0];
  assert.equal(w.base, "WETH");
  assert.equal(w.fair, 3000);
  assert.equal(w.baseBalanceWei, "5"); // balances.wethWei
  assert.deepEqual(
    w.venues.map((v) => [v.protocol, v.swapType, v.price]),
    [
      // uniswap uses the slot0 mid as-is. balancer/curve observed prices are fee-inclusive
      // sell quotes, so they are normalized back to a mid equivalent by removing the fee (default 30bps).
      ["uniswap", "swap", 2990],
      ["balancer", "balancerSwap", 3010 / (1 - 30 / 10000)],
      ["curve", "curveSwap", 3000 / (1 - 30 / 10000)],
    ],
  );
});

test("marketViews: an observation with WBTC returns 2 views, WETH first (base-agnostic extraction)", () => {
  const obs = baseObs();
  obs.fairPricesUsd = { WBTC: 60000, WETH: 3000 }; // WETH normalized to first even when order is reversed
  obs.baseBalances = { WETH: "5", WBTC: "100000000" }; // 1 WBTC (8 decimals)
  obs.protocols.uniswap!.markets = {
    "WBTC/USDC": {
      pair: "WBTC/USDC",
      fee: 500,
      priceUsdcPerWeth: 59500,
      tick: 0,
      tickSpacing: 10,
    },
  };
  obs.protocols.balancer!.markets = {
    "WBTC/USDC": { priceUsdcPerWeth: 60500 },
  };
  // no WBTC market on curve -> WBTC has 2 venues: uniswap/balancer.

  const views = marketViews(obs);
  assert.equal(views.length, 2);
  assert.equal(views[0].base, "WETH"); // pinned first
  const wbtc = views[1];
  assert.equal(wbtc.base, "WBTC");
  assert.equal(wbtc.fair, 60000);
  assert.equal(wbtc.baseBalanceWei, "100000000");
  assert.deepEqual(
    wbtc.venues.map((v) => [v.protocol, v.price]),
    [
      ["uniswap", 59500],
      // balancer is a fee-inclusive quote -> mid-normalized (removing 30bps)
      ["balancer", 60500 / (1 - 30 / 10000)],
    ],
  );
});

test("marketViews: excludes a base with no venue price", () => {
  const obs = baseObs();
  obs.fairPricesUsd = { WETH: 3000, WBTC: 60000 }; // WBTC has no venue price in protocols
  const views = marketViews(obs);
  assert.deepEqual(
    views.map((v) => v.base),
    ["WETH"],
  );
});
