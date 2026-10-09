import { test } from "node:test";
import assert from "node:assert/strict";
import { Rng } from "@eris/sdk/rng.js";
import { gmxSideCapUsd } from "@eris/sdk/protocols/gmxKeys.js";
import {
  buildFlowOrders,
  buildGmxFlow,
  type FlowContextWire,
  type GmxFlowExposure,
} from "../core/src/flow/logic.js";
import {
  configDiff,
  configWorld,
  MUTABLE_CONFIG_KEYS,
} from "../core/src/realtime/periodResume.js";

const USD = 10n ** 30n;
const WETH = 10n ** 18n;
const MAX_SIZE = 100_000n * USD;

// The practice calibration: Poisson arrivals, lognormal sizes, every protocol's flow wallet funded.
function ctx(round: number): FlowContextWire {
  return {
    round,
    fairPriceUsdcPerWeth: 3000,
    protocols: ["gmx"],
    poolPrices: {},
    flowBalances: {
      "gmx:uninformed": { wethWei: (100n * WETH).toString(), usdcUnits: "0" },
    },
    limits: {
      uninformedFlowMaxWethWei: WETH.toString(),
      informedFlowMaxWethWei: WETH.toString(),
      balancerFlowMaxWethWei: WETH.toString(),
      curveFlowMaxWethWei: WETH.toString(),
      gmxFlowMaxSizeUsd: MAX_SIZE.toString(),
      gmxArrivalRate: "3",
      gmxSizeSigma: "1",
      gmxOiTargetFrac: "0.4",
      aaveFlowMaxWethWei: WETH.toString(),
      aaveFlowBorrowUsdcUnits: "0",
      defaultPriorityFeeWei: "100000000",
    },
  };
}

// Each side's cap $2.25M (the deployed pool: 1,500 WETH at $3,000 and 4.5M USDC, reserve factor 0.5).
function exposureWire(
  longUsd: bigint,
  shortUsd: bigint,
): NonNullable<FlowContextWire["gmxFlowExposure"]> {
  return {
    longSizeUsd: longUsd.toString(),
    longCollateralWei: ((longUsd / USD / 3000n / 2n) * WETH).toString(),
    shortSizeUsd: shortUsd.toString(),
    shortCollateralWei: ((shortUsd / USD / 3000n / 2n) * WETH).toString(),
    longCapUsd: (2_250_000n * USD).toString(),
    shortCapUsd: (2_250_000n * USD).toString(),
  };
}

function run(c: (round: number) => FlowContextWire, seed: number, blocks = 60) {
  const rng = new Rng(seed);
  const out = [];
  for (let round = 1; round <= blocks; round++)
    out.push(buildFlowOrders(rng, c(round)));
  return out;
}

test("below the target the flow is order-for-order what it was without one", () => {
  const without = run(ctx, 5);
  const below = run(
    (r) => ({ ...ctx(r), gmxFlowExposure: exposureWire(800_000n * USD, 0n) }),
    5,
  );
  const off = run(
    (r) => ({
      ...ctx(r),
      gmxFlowExposure: exposureWire(9_000_000n * USD, 9_000_000n * USD),
      limits: { ...ctx(r).limits, gmxOiTargetFrac: "0" },
    }),
    5,
  );
  assert.ok(without.flat().length > 50, "the calibration emits orders");
  assert.deepEqual(below, without, "under the target nothing changes");
  assert.deepEqual(off, without, "target 0 never closes, however full the book");
  assert.ok(
    without.flat().every((o) => (o.action as { type: string }).type !== "gmxDecrease"),
  );
});

test("past the target every order on that side closes, with its share of collateral", () => {
  const exposure = exposureWire(2_000_000n * USD, 100_000n * USD);
  const blocks = run((r) => ({ ...ctx(r), gmxFlowExposure: exposure }), 7, 40);
  const without = run(ctx, 7, 40);
  let longs = 0;
  let shorts = 0;
  blocks.forEach((orders, b) => {
    // The same draws: the same count, sides, sizes and fees as the flow without a target.
    assert.equal(orders.length, without[b].length);
    orders.forEach((o, i) => {
      const a = o.action as unknown as Record<string, string | boolean>;
      const was = without[b][i].action as unknown as Record<string, string | boolean>;
      assert.equal(a.isLong, was.isLong);
      assert.equal(o.priorityFeeWei, without[b][i].priorityFeeWei);
      if (a.isLong) {
        longs++;
        assert.equal(a.type, "gmxDecrease", "long side is past 0.4 x cap");
        assert.equal(a.sizeDeltaUsd, was.sizeDeltaUsd, "the drawn size closes");
        assert.equal(a.collateral, "WETH");
        // collateral / size held = (2,000,000 / 3000 / 2) WETH per $2,000,000.
        const expected =
          (BigInt(exposure.longCollateralWei) * BigInt(a.sizeDeltaUsd as string)) /
          BigInt(exposure.longSizeUsd);
        assert.ok(
          BigInt(a.collateralDeltaAmount as string) <= expected,
          "never more than the drawn size's share",
        );
      } else {
        shorts++;
        assert.equal(a.type, "gmxIncrease", "short side is below its target");
      }
    });
  });
  assert.ok(longs > 10 && shorts > 10, `both sides drawn (${longs}/${shorts})`);
});

test("orders in one block see each other: a close that crosses the target lets the next one open", () => {
  // Just over the target on both sides, a burst of 12.
  const target = (2_250_000n * USD * 4n) / 10n;
  const exposure: GmxFlowExposure = {
    long: { sizeUsd: target + 1n, collateralWei: 150n * WETH },
    short: { sizeUsd: target + 1n, collateralWei: 150n * WETH },
    longCapUsd: 2_250_000n * USD,
    shortCapUsd: 2_250_000n * USD,
  };
  const orders = buildGmxFlow(
    new Rng(3),
    MAX_SIZE,
    100_000_000n,
    3000,
    null,
    false,
    0.5,
    1,
    12,
    1,
    exposure,
    0.4,
  );
  let checked = 0;
  for (const isLong of [true, false]) {
    const types = orders
      .map((o) => o.action as unknown as { type: string; isLong: boolean })
      .filter((a) => a.isLong === isLong)
      .map((a) => a.type);
    if (types.length < 2) continue;
    checked++;
    assert.equal(types[0], "gmxDecrease");
    assert.equal(types[1], "gmxIncrease", "the first close took the side under");
  }
  assert.ok(checked > 0, "the burst drew one side at least twice");
});

test("a close never exceeds what the flow holds", () => {
  const exposure: GmxFlowExposure = {
    long: { sizeUsd: 10n * USD, collateralWei: WETH / 1000n },
    short: { sizeUsd: 10n * USD, collateralWei: WETH / 1000n },
    // A cap of 0: the market can carry nothing, so whatever the flow holds is over target.
    longCapUsd: 0n,
    shortCapUsd: 0n,
  };
  const orders = buildGmxFlow(
    new Rng(9),
    MAX_SIZE,
    100_000_000n,
    3000,
    null,
    false,
    0.5,
    1,
    6,
    1,
    exposure,
    0.4,
  );
  const actions = orders.map(
    (o) => o.action as unknown as Record<string, string | boolean>,
  );
  assert.ok(actions.some((a) => a.type === "gmxDecrease"));
  for (const isLong of [true, false]) {
    let held = 10n * USD;
    let first = true;
    for (const a of actions.filter((x) => x.isLong === isLong)) {
      const size = BigInt(a.sizeDeltaUsd as string);
      if (a.type === "gmxIncrease") {
        held += size;
        continue;
      }
      assert.ok(size <= held, "a close is at most the side's book");
      if (first) {
        assert.equal(size, 10n * USD, "the first close empties the side");
        assert.equal(a.collateralDeltaAmount, (WETH / 1000n).toString());
        first = false;
      }
      held -= size;
    }
  }
});

test("gmxSideCapUsd: pool value x the tighter reserve factor, or the absolute ceiling", () => {
  const half = 5n * 10n ** 29n;
  const long = gmxSideCapUsd({
    poolAmount: 1_500n * WETH,
    tokenPriceUsd: 3000,
    tokenDecimals: 18,
    reserveFactor: half,
    openInterestReserveFactor: 6n * 10n ** 29n,
    maxOpenInterest: 10n ** 9n * USD,
  });
  assert.equal(long, 2_250_000n * USD);
  const short = gmxSideCapUsd({
    poolAmount: 4_500_000n * 10n ** 6n,
    tokenPriceUsd: 1,
    tokenDecimals: 6,
    reserveFactor: half,
    openInterestReserveFactor: half,
    maxOpenInterest: 1_000_000n * USD,
  });
  assert.equal(short, 1_000_000n * USD, "MAX_OPEN_INTEREST binds");
  assert.equal(
    gmxSideCapUsd({
      poolAmount: 1n,
      tokenPriceUsd: 3000,
      tokenDecimals: 18,
      reserveFactor: undefined,
      openInterestReserveFactor: half,
      maxOpenInterest: USD,
    }),
    undefined,
    "a failed read is not a cap of 0",
  );
});

test("the OI target may change across a restart, and a period saved before it existed resumes", () => {
  assert.ok(
    (MUTABLE_CONFIG_KEYS as readonly string[]).includes("gmxFlowOiTargetFrac"),
  );
  const before = { seed: 1, gmxFlowSizeSigma: 1 };
  const after = { ...before, gmxFlowOiTargetFrac: 0.4 };
  assert.deepEqual(
    configDiff(configWorld(before, {}), configWorld(after, {})),
    [],
  );
});
