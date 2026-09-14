// Issue #99 (#92 F-B): the flow's sell-side guard has to read the balance of the base it is about
// to sell. It used to read `wethWei` for every base, so a wallet holding WETH and no WBTC sent WBTC
// sells against a zero balance -- ~90 % of the WBTC informed rows reverted in every official epoch.
//
// Runs under the local-deploy overlay because the fork registry is WETH/USDC only and has no second
// base to be wrong about. No chain is needed; the env is set before the dynamic imports, and node's
// test runner gives each file its own process.
process.env.ERIS_LOCAL_DEPLOY = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

const { Rng } = await import("@eris/sdk/rng.js");
const { buildFlowOrders } = await import("../core/src/flow/logic.js");
type FlowContextWire = import("../core/src/flow/logic.js").FlowContextWire;

function ctx(round: number): FlowContextWire {
  return {
    round,
    fairPriceUsdcPerWeth: 2000,
    protocols: ["uniswap", "balancer", "curve", "gmx", "aave"],
    poolPrices: { uniswap: 1990, balancer: 2010, curve: 2000 },
    aaveReserves: { wethSupplied: "0", usdcBorrowed: "0" },
    limits: {
      uninformedFlowMaxWethWei: "1000000000000000000",
      informedFlowMaxWethWei: "2000000000000000000",
      balancerFlowMaxWethWei: "1000000000000000000",
      curveFlowMaxWethWei: "1000000000000000000",
      gmxFlowMaxSizeUsd: (20_000n * 10n ** 30n).toString(),
      gmxFlowActivityProb: "1",
      aaveFlowMaxWethWei: "2000000000000000000",
      aaveFlowBorrowUsdcUnits: "5000000000",
      aaveFlowActivityProb: "1",
      defaultPriorityFeeWei: "100000000",
    },
  };
}
function wbtcCtx(
  round: number,
  bases: Record<string, string> | undefined,
): FlowContextWire {
  const base = ctx(round);
  const flowBalances: FlowContextWire["flowBalances"] = {};
  for (const protocol of base.protocols) {
    for (const kind of ["informed", "uninformed"] as const) {
      flowBalances[`${protocol}:${kind}`] = {
        wethWei: "5000000000000000000", // 5 WETH: the old guard passed on this alone
        usdcUnits: "25000000000",
        ...(bases ? { bases } : {}),
      };
    }
  }
  return {
    ...base,
    flowBalances,
    extraBases: [
      {
        base: "WBTC",
        // Every venue above fair, so the informed side wants to *sell* WBTC on all three.
        poolPrices: { uniswap: 61_000, balancer: 61_000, curve: 61_000 },
        fairPriceUsd: 60_000,
        uninformedFlowMaxBaseWei: "5000000",
        informedFlowMaxBaseWei: "5000000",
        balancerFlowMaxBaseWei: "5000000",
        curveFlowMaxBaseWei: "5000000",
      },
    ],
  };
}

const wbtcOrders = (orders: ReturnType<typeof buildFlowOrders>) =>
  orders.filter((o) => (o.action as { base?: string }).base === "WBTC");

test("a flow wallet with WETH but no WBTC never sells WBTC (the guard reads the base it sells)", () => {
  for (const round of [1, 2, 3, 4, 5]) {
    const orders = wbtcOrders(buildFlowOrders(new Rng(round), wbtcCtx(round, undefined)));
    assert.ok(orders.length > 0, "the WBTC leg is on");
    assert.equal(orders.filter(o => o.kind === "informed").length, 0, "an empty informed wallet waits rather than buying above fair");
    for (const o of orders)
      assert.equal((o.action as { tokenIn: string }).tokenIn, "USDC");
    // Same with the base listed and empty.
    const explicit = wbtcOrders(
      buildFlowOrders(new Rng(round), wbtcCtx(round, { WETH: "5000000000000000000", WBTC: "0" })),
    );
    for (const o of explicit)
      assert.equal((o.action as { tokenIn: string }).tokenIn, "USDC");
  }
});

test("a flow wallet holding WBTC sells it when the pool is above fair", () => {
  const orders = wbtcOrders(
    buildFlowOrders(
      new Rng(1),
      wbtcCtx(1, { WETH: "5000000000000000000", WBTC: "50000000" }),
    ),
  );
  const informed = orders.filter((o) => o.kind === "informed");
  assert.ok(informed.length > 0);
  for (const o of informed)
    assert.equal((o.action as { tokenIn: string }).tokenIn, "WBTC");
});

test("the WETH path still reads wethWei, with or without a bases map", () => {
  const withBases = buildFlowOrders(
    new Rng(11),
    wbtcCtx(1, { WETH: "5000000000000000000", WBTC: "50000000" }),
  ).filter((o) => (o.action as { base?: string }).base === undefined);
  const without = buildFlowOrders(new Rng(11), wbtcCtx(1, undefined)).filter(
    (o) => (o.action as { base?: string }).base === undefined,
  );
  assert.deepEqual(withBases, without);
});

test("an inventory-limited informed sell is capped, never reversed into a buy above fair", () => {
  for (const held of ["0", "1", "10000", "100000", "50000000"]) {
    const context = wbtcCtx(1, { WBTC: held });
    const informed = wbtcOrders(buildFlowOrders(new Rng(1), context)).filter(o => o.kind === "informed");
    if (held === "0") assert.equal(informed.length, 0);
    else {
      assert.equal(informed.length, 3);
      for (const order of informed) {
        const action = order.action as { tokenIn: string; amountIn: string };
        assert.equal(action.tokenIn, "WBTC");
        assert.ok(BigInt(action.amountIn) <= BigInt(held));
      }
    }
  }
});

test("an empty informed wallet can buy below fair, and a depleted quote balance cannot fund a buy", () => {
  const context = wbtcCtx(1, { WBTC: "0" });
  context.extraBases![0].poolPrices = { uniswap: 59000, balancer: 59000, curve: 59000 };
  const buys = wbtcOrders(buildFlowOrders(new Rng(1), context)).filter(o => o.kind === "informed");
  assert.equal(buys.length, 3);
  for (const order of buys) assert.equal((order.action as { tokenIn: string }).tokenIn, "USDC");
  for (const balance of Object.values(context.flowBalances!)) balance.usdcUnits = "0";
  assert.equal(wbtcOrders(buildFlowOrders(new Rng(1), context)).filter(o => o.kind === "informed").length, 0);
});

test("capping a sell preserves the random stream used by subsequent flow", () => {
  const empty = new Rng(123);
  const funded = new Rng(123);
  buildFlowOrders(empty, wbtcCtx(1, { WBTC: "0" }));
  buildFlowOrders(funded, wbtcCtx(1, { WBTC: "50000000" }));
  assert.equal(empty.next(), funded.next());
});

test("an initially USDC-only wallet can sell acquired base inventory toward fair", () => {
  const context = wbtcCtx(1, { WBTC: "100000" });
  context.usdcOnlyFlow = true;
  const informed = wbtcOrders(buildFlowOrders(new Rng(1), context)).filter(o => o.kind === "informed");
  assert.equal(informed.length, 3);
  for (const order of informed) {
    const action = order.action as { tokenIn: string; amountIn: string };
    assert.equal(action.tokenIn, "WBTC");
    assert.equal(action.amountIn, "100000");
  }
});
