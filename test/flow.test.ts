import { test } from "node:test";
import assert from "node:assert/strict";
import { Rng } from "@eris/sdk/rng.js";
import {
  buildFlowOrders,
  type FlowContextWire,
} from "../core/src/flow/logic.js";

function ctx(round: number): FlowContextWire {
  return {
    round,
    fairPriceUsdcPerWeth: 2000,
    // production order: config.ALL_PROTOCOLS = [uniswap, balancer, curve, gmx, aave]
    // (gmx before aave). The coordinator passes enabledIds in this order, so the test matches it.
    protocols: ["uniswap", "balancer", "curve", "gmx", "aave"],
    poolPrices: { uniswap: 1990, balancer: 2010, curve: 2000 },
    aaveReserves: { wethSupplied: "0", usdcBorrowed: "0" },
    limits: {
      uninformedFlowMaxWethWei: "1000000000000000000",
      informedFlowMaxWethWei: "2000000000000000000",
      balancerFlowMaxWethWei: "1000000000000000000",
      curveFlowMaxWethWei: "1000000000000000000",
      gmxFlowMaxSizeUsd: (20_000n * 10n ** 30n).toString(),
      // fire every block (prob=1) to keep the existing structural assertions deterministic. The gate itself is a separate test.
      gmxFlowActivityProb: "1",
      aaveFlowMaxWethWei: "2000000000000000000",
      maxAaveBorrowUsdcUnits: "5000000000",
      aaveFlowActivityProb: "1",
      defaultPriorityFeeWei: "100000000",
    },
  };
}

function usdcOnlyCtx(round: number): FlowContextWire {
  const base = ctx(round);
  const flowBalances: FlowContextWire["flowBalances"] = {};
  for (const protocol of base.protocols) {
    for (const kind of ["informed", "uninformed"] as const) {
      flowBalances[`${protocol}:${kind}`] = {
        wethWei: "0",
        usdcUnits: "25000000000",
      };
    }
  }
  return { ...base, flowBalances };
}

test("buildFlowOrders is reproducible for a fixed seed (basis of a fixed market)", () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let round = 1; round <= 5; round++) {
    assert.deepEqual(
      buildFlowOrders(a, ctx(round)),
      buildFlowOrders(b, ctx(round)),
    );
  }
});

test("buildFlowOrders tags protocols in the order they are passed (production = enabledAdapters order)", () => {
  const orders = buildFlowOrders(new Rng(7), ctx(1));
  const idx = (p: string) => orders.findIndex((o) => o.protocol === p);
  // AMM and aave are always emitted. Production order: uniswap<balancer<curve<(gmx)<aave.
  assert.ok(idx("uniswap") >= 0 && idx("aave") >= 0);
  assert.ok(idx("uniswap") < idx("balancer"));
  assert.ok(idx("balancer") < idx("curve"));
  assert.ok(idx("curve") < idx("aave"));
  // gmx exists only in rounds where it is emitted, and falls between curve and aave.
  if (idx("gmx") >= 0) {
    assert.ok(idx("curve") < idx("gmx"));
    assert.ok(idx("gmx") < idx("aave"));
  }
  // AMM has 2 orders each: uninformed+informed
  assert.equal(orders.filter((o) => o.protocol === "uniswap").length, 2);
});

test("informed AMM flow pushes the pool toward fair (pool<fair -> buy WETH with USDC)", () => {
  const orders = buildFlowOrders(new Rng(1), ctx(1));
  const uniInformed = orders.find(
    (o) => o.protocol === "uniswap" && o.kind === "informed",
  );
  assert.ok(uniInformed);
  assert.equal(
    (uniInformed!.action as { tokenIn: string }).tokenIn,
    "USDC", // poolPrice 1990 < fair 2000
  );
});

test("aave flow emits aaveSupply when supplied===0", () => {
  const orders = buildFlowOrders(new Rng(3), ctx(1));
  const aave = orders.find((o) => o.protocol === "aave");
  assert.ok(aave);
  assert.equal((aave!.action as { type: string }).type, "aaveSupply");
});

test("USDC-only flow: aave emits a USDC->WETH swap from the same wallet before the WETH supply", () => {
  const orders = buildFlowOrders(new Rng(3), usdcOnlyCtx(1));
  const prep = orders.find(
    (o) => o.walletProtocol === "aave" && o.protocol === "uniswap",
  );
  assert.ok(prep);
  assert.equal(prep!.kind, "informed");
  assert.equal((prep!.action as { type: string }).type, "swap");
  assert.equal((prep!.action as { tokenIn: string }).tokenIn, "USDC");
  assert.equal(
    orders.some((o) => (o.action as { type: string }).type === "aaveSupply"),
    false,
  );
});

test("USDC-only flow: WETH-in AMM flow is flipped to USDC-in to avoid an insufficient-balance revert", () => {
  const orders = buildFlowOrders(new Rng(7), usdcOnlyCtx(1));
  for (const order of orders.filter(
    (o) =>
      o.protocol === "uniswap" ||
      o.protocol === "balancer" ||
      o.protocol === "curve",
  )) {
    assert.equal((order.action as { tokenIn: string }).tokenIn, "USDC");
  }
});

test("different seeds produce different flow", () => {
  const o1 = buildFlowOrders(new Rng(1), ctx(1));
  const o2 = buildFlowOrders(new Rng(999), ctx(1));
  assert.notDeepEqual(
    o1.map((o) => o.priorityFeeWei.toString()),
    o2.map((o) => o.priorityFeeWei.toString()),
  );
});

// ctx with gmx/aave submission frequency overridden via prob.
function probCtx(round: number, gmxProb: string, aaveProb: string) {
  const base = ctx(round);
  return {
    ...base,
    limits: {
      ...base.limits,
      gmxFlowActivityProb: gmxProb,
      aaveFlowActivityProb: aaveProb,
    },
  };
}

test("gmx/aave activity prob=0 emits none of that flow", () => {
  for (let round = 1; round <= 20; round++) {
    const orders = buildFlowOrders(
      new Rng(round * 7),
      probCtx(round, "0", "0"),
    );
    assert.equal(
      orders.filter((o) => o.protocol === "gmx").length,
      0,
      "no gmx flow when gmx prob=0",
    );
    assert.equal(
      orders.filter((o) => o.protocol === "aave").length,
      0,
      "no aave flow when aave prob=0",
    );
  }
});

test("gmx/aave activity prob fires randomly per block (not every time)", () => {
  // running many blocks at prob=0.5 mixes blocks that emit and blocks that do not (not regular).
  let gmxBlocks = 0;
  let aaveBlocks = 0;
  const N = 200;
  for (let round = 1; round <= N; round++) {
    const orders = buildFlowOrders(
      new Rng(round * 31 + 5),
      probCtx(round, "0.5", "0.5"),
    );
    if (orders.some((o) => o.protocol === "gmx")) gmxBlocks++;
    if (orders.some((o) => o.protocol === "aave")) aaveBlocks++;
  }
  // neither every block nor zero, roughly around half (not a regular per-block churn).
  assert.ok(
    gmxBlocks > 0 && gmxBlocks < N,
    `gmx is intermittent: ${gmxBlocks}/${N}`,
  );
  assert.ok(
    aaveBlocks > 0 && aaveBlocks < N,
    `aave is intermittent: ${aaveBlocks}/${N}`,
  );
});

test("gmx/aave activity prob=1 with default maxBurst(1) yields 1 per block", () => {
  // probCtx does not pass maxBurst -> decode default 1 -> the state machine does 1 step = 1 item.
  for (let round = 1; round <= 20; round++) {
    const orders = buildFlowOrders(
      new Rng(round * 13),
      probCtx(round, "1", "1"),
    );
    assert.equal(
      orders.filter((o) => o.protocol === "aave").length,
      1,
      "1 per block when aave prob=1 and burst=1",
    );
  }
});

// ctx with gmx maxBurst overridden (prob=1 to always fire and observe the burst).
function gmxBurstCtx(round: number, gmxBurst: string) {
  const base = ctx(round);
  return {
    ...base,
    limits: {
      ...base.limits,
      gmxFlowActivityProb: "1",
      gmxFlowMaxBurst: gmxBurst,
    },
  };
}

test("gmx maxBurst>1 can emit multiple positions in one block (varies over 1..N)", () => {
  let gmxMax = 0;
  let gmxMultiBlocks = 0;
  const N = 200;
  for (let round = 1; round <= N; round++) {
    const orders = buildFlowOrders(
      new Rng(round * 17 + 3),
      gmxBurstCtx(round, "4"),
    );
    const g = orders.filter((o) => o.protocol === "gmx").length;
    gmxMax = Math.max(gmxMax, g);
    if (g > 1) gmxMultiBlocks++;
  }
  assert.ok(gmxMultiBlocks > 0, "there exist blocks with multiple gmx orders");
  assert.ok(gmxMax > 1 && gmxMax <= 4, `gmx burst is 1..4: max=${gmxMax}`);
});

// aave borrower pool: ctx given N actors. Each actor is a distinct address with a persistent position.
function aaveActorsCtx(
  round: number,
  actors: Array<{
    key: string;
    wethSupplied: string;
    usdcBorrowed: string;
    wethWei: string;
    usdcUnits: string;
  }>,
) {
  const base = ctx(round);
  return {
    ...base,
    aaveActors: actors,
    limits: { ...base.limits, aaveFlowActivityProb: "1" },
  };
}

test("aave borrower pool: with multiple collateralized actors, several borrows appear in one block", () => {
  // all 4 actors are collateralized and debt-free. With HF headroom they may choose to borrow.
  const actors = [0, 1, 2, 3].map((i) => ({
    key: `aave:actor${i}`,
    wethSupplied: "2000000000000000000", // 2 WETH collateral -> borrow headroom
    usdcBorrowed: "0",
    wethWei: "5000000000000000000",
    usdcUnits: "25000000000",
  }));
  let maxBorrowsInBlock = 0;
  let multiBorrowBlocks = 0;
  const N = 200;
  for (let round = 1; round <= N; round++) {
    const orders = buildFlowOrders(
      new Rng(round * 29 + 7),
      aaveActorsCtx(round, actors),
    );
    const borrows = orders.filter(
      (o) => (o.action as { type?: string }).type === "aaveBorrow",
    );
    // borrows come from distinct actors (distinct wallet keys).
    const keys = new Set(borrows.map((o) => o.walletKey));
    maxBorrowsInBlock = Math.max(maxBorrowsInBlock, borrows.length);
    if (borrows.length > 1) {
      multiBorrowBlocks++;
      assert.equal(
        keys.size,
        borrows.length,
        "each borrow comes from a distinct actor (distinct address)",
      );
    }
  }
  assert.ok(
    multiBorrowBlocks > 0,
    "multiple borrows really occur in one block",
  );
  assert.ok(
    maxBorrowsInBlock >= 3,
    `3 or more simultaneous borrows occur: max=${maxBorrowsInBlock}`,
  );
});

test("aave borrower pool: debt persists without a forced repay after borrowing (carries actor state)", () => {
  // Give one actor with debt; running many blocks does not make every block a repay
  // (debt-retaining actions like borrow/supply are also chosen) = not a forced repay round-trip.
  // Collateral established, small debt (well below the target 30% LTV=1200 USDC) -> borrow can be chosen.
  const actor = {
    key: "aave:actor0",
    wethSupplied: "2000000000000000000", // 2 WETH collateral (target reached -> no supply)
    usdcBorrowed: "200000000", // 200 USDC existing debt (headroom to target = can borrow more)
    wethWei: "5000000000000000000",
    usdcUnits: "25000000000",
  };
  const actionTypes = new Set<string>();
  for (let round = 1; round <= 100; round++) {
    const orders = buildFlowOrders(
      new Rng(round * 41 + 11),
      aaveActorsCtx(round, [actor]),
    );
    for (const o of orders.filter((x) => x.protocol === "aave"))
      actionTypes.add((o.action as { type: string }).type);
  }
  // a borrow is observed (accrues debt = not a "borrow->forced repay" round-trip).
  assert.ok(
    actionTypes.has("aaveBorrow"),
    `borrowing more occurs: ${[...actionTypes].join(",")}`,
  );
});

test("Rng.poisson/lognormal are deterministic and in-range", () => {
  const a = new Rng(5);
  const b = new Rng(5);
  for (let i = 0; i < 10; i++) {
    assert.equal(a.poisson(0.8), b.poisson(0.8));
    assert.equal(a.lognormal(0.5, 1), b.lognormal(0.5, 1));
  }
  // poisson(0) is always 0, lognormal(mean>0) is positive
  assert.equal(new Rng(1).poisson(0), 0);
  const s = new Rng(2).lognormal(0.5, 1);
  assert.ok(s > 0 && Number.isFinite(s));
});

test("informedArbFeeBps: AMM venues with gap at or below the fee band emit no informed flow", () => {
  const AMM = new Set(["uniswap", "balancer", "curve"]);
  const ammInformed = (o: { kind: string; protocol: string }): boolean =>
    o.kind === "informed" && AMM.has(o.protocol);
  // all AMM venues have pool=fair=2000 -> gap=0. Within the 30bps fee band, so no AMM informed flow.
  const c = ctx(1);
  c.poolPrices = { uniswap: 2000, balancer: 2000, curve: 2000 };
  c.limits.informedArbFeeBps = "30";
  const gated = buildFlowOrders(new Rng(9), c).filter(ammInformed);
  assert.equal(gated.length, 0, "AMM venues with gap 0 emit 0 informed orders");
  // when off (0), AMM informed is emitted even at gap 0 as before (byte-compatible).
  c.limits.informedArbFeeBps = "0";
  const off = buildFlowOrders(new Rng(9), c).filter(ammInformed);
  assert.ok(off.length >= 1, "when off, AMM informed is emitted even at gap 0");
});

test("uninformedArrivalRate: Poisson mode also produces zero-count blocks (count varies)", () => {
  const c = ctx(1);
  c.limits.uninformedArrivalRate = "0.6";
  c.limits.uninformedSizeSigma = "1";
  // at λ=0.6 the count varies per round (zero also occurs). Confirm the count is not fixed.
  const counts = new Set<number>();
  const rng = new Rng(3);
  for (let round = 1; round <= 40; round++) {
    const c2 = { ...c, round };
    const uni = buildFlowOrders(rng, c2).filter(
      (o) => o.kind === "uninformed" && o.protocol === "uniswap",
    ).length;
    counts.add(uni);
  }
  assert.ok(counts.size > 1, "with Poisson the count varies (not fixed)");
});

test("gmxArrivalRate: the GMX position count varies in Poisson mode", () => {
  const c = ctx(1);
  c.protocols = ["gmx"]; // narrow to gmx only
  c.limits.gmxArrivalRate = "1.2";
  c.limits.gmxSizeSigma = "1";
  const rng = new Rng(11);
  const counts = new Set<number>();
  for (let round = 1; round <= 40; round++) {
    const gmx = buildFlowOrders(rng, { ...c, round }).filter(
      (o) => o.protocol === "gmx",
    ).length;
    counts.add(gmx);
  }
  assert.ok(counts.size > 1, "with Poisson the position count varies");
  assert.ok(counts.has(0), "zero-count blocks also occur naturally");
});

test("aaveActorSizeSigma: per-actor target collateral is heterogeneous by key and stable across blocks", () => {
  const AAVE = { actors: 4 };
  const mkCtx = (round: number): FlowContextWire => {
    const base = ctx(round);
    base.protocols = ["aave"];
    base.aaveActors = Array.from({ length: AAVE.actors }, (_, i) => ({
      key: `aave:actor${i}`,
      wethSupplied: "0",
      usdcBorrowed: "0",
      wethWei: "100000000000000000000", // ample collateral funds
      usdcUnits: "0",
    }));
    base.limits.aaveActorSizeSigma = "1.2";
    base.limits.aaveFlowActivityProb = "1"; // all actors act every block
    return base;
  };
  // for the same round and seed the supply amount (derived from target collateral) is deterministic.
  const a = buildFlowOrders(new Rng(1), mkCtx(1));
  const b = buildFlowOrders(new Rng(1), mkCtx(1));
  assert.deepEqual(a, b, "deterministic");
  // supply amount differs per actor (heterogeneous). Confirm not all supplies are equal.
  const supplies = a
    .filter((o) => (o.action as { type?: string }).type === "aaveSupply")
    .map((o) => (o.action as { amount: string }).amount);
  assert.ok(supplies.length >= 2, "multiple actors supply");
  assert.ok(new Set(supplies).size > 1, "target collateral differs per actor");
});
