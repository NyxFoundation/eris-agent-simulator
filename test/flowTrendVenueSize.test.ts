// Issue #112: a flowTrend window scales the uninformed order size on every AMM venue, not only on
// uniswap. Balancer and curve configure one cap for both legs, and the coordinator used to send
// that cap unscaled, so the uninformed leg on two of the three venues sat at x1.0 through every
// window (measured on informed-flow#101: uniswap x2.98, balancer x1.05, curve x1.00 -- x1.3 overall
// against a declared x2-3). The wire now carries the uninformed leg's own copy of the venue cap,
// which the coordinator scales the way it scales uninformedFlowMaxWethWei.
process.env.ERIS_LOCAL_DEPLOY = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

const { Rng } = await import("@eris/sdk/rng.js");
const { buildFlowOrders } = await import("../core/src/flow/logic.js");
type FlowContextWire = import("../core/src/flow/logic.js").FlowContextWire;

const ONE = 1_000_000_000_000_000_000n;
const MULT = 3n;

function wire(scaled: boolean, round = 4): FlowContextWire {
  return {
    round,
    fairPriceUsdcPerWeth: 3000,
    protocols: ["uniswap", "balancer", "curve"],
    poolPrices: { uniswap: 3000, balancer: 3000, curve: 3000 },
    flowSeed: 101,
    limits: {
      uninformedFlowMaxWethWei: (scaled ? ONE * MULT : ONE).toString(),
      informedFlowMaxWethWei: (ONE * 2n).toString(),
      balancerFlowMaxWethWei: ONE.toString(),
      curveFlowMaxWethWei: ONE.toString(),
      ...(scaled
        ? {
            balancerUninformedFlowMaxWethWei: (ONE * MULT).toString(),
            curveUninformedFlowMaxWethWei: (ONE * MULT).toString(),
          }
        : {}),
      gmxFlowMaxSizeUsd: "0",
      aaveFlowMaxWethWei: "0",
      aaveFlowBorrowUsdcUnits: "0",
      defaultPriorityFeeWei: "100000000",
      uninformedArrivalRate: "2",
      uninformedSizeSigma: "1.0",
      uninformedFlowPersistBlocks: "12",
      uninformedFlowTrendCorrelation: "1",
    },
  };
}

function ammOrders(scaled: boolean) {
  // The same Rng position on both sides: the size is a fraction of the cap, drawn from a stream that
  // does not depend on the cap, so order i on both sides is the same draw against a different cap.
  // Several rounds, because arrivals are Poisson and one round can leave a venue with none.
  const rng = new Rng(2024);
  return [1, 2, 3, 4, 5, 6, 7, 8].flatMap((round) =>
    buildFlowOrders(rng, wire(scaled, round)).filter((o) =>
      ["uniswap", "balancer", "curve"].includes(o.protocol),
    ),
  );
}

test("a scaled window multiplies the uninformed size on all three AMM venues by the same factor", () => {
  const base = ammOrders(false);
  const lean = ammOrders(true);
  assert.equal(base.length, lean.length, "the window changes sizes, not the number of orders");
  const seen = new Set<string>();
  for (let i = 0; i < base.length; i++) {
    const a = base[i];
    const b = lean[i];
    assert.equal(a.protocol, b.protocol);
    assert.equal(a.kind, b.kind);
    const amtA = BigInt((a.action as { amountIn: string }).amountIn);
    const amtB = BigInt((b.action as { amountIn: string }).amountIn);
    if (a.kind !== "uninformed") {
      assert.equal(amtB, amtA, `${a.protocol} informed leg is not scaled by the window`);
      continue;
    }
    seen.add(a.protocol);
    // USDC-side amounts go through an integer conversion, so allow its rounding.
    const ratio = Number(amtB) / Number(amtA);
    assert.ok(
      Math.abs(ratio - Number(MULT)) < 1e-6,
      `${a.protocol} uninformed order ${i}: x${ratio.toFixed(6)} (expected x${MULT})`,
    );
  }
  assert.deepEqual([...seen].sort(), ["balancer", "curve", "uniswap"], "every venue emitted an uninformed order");
});

test("a wire without the per-venue uninformed caps reads the venue cap (the pre-#112 wire)", () => {
  const w = wire(false);
  const withExplicit = {
    ...w,
    limits: {
      ...w.limits,
      balancerUninformedFlowMaxWethWei: w.limits.balancerFlowMaxWethWei,
      curveUninformedFlowMaxWethWei: w.limits.curveFlowMaxWethWei,
    },
  };
  assert.deepEqual(
    buildFlowOrders(new Rng(2024), w),
    buildFlowOrders(new Rng(2024), withExplicit),
  );
});
