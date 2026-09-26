// Issue #130: over a long period the flow wallets drain, and the balance guards turn the flow
// one-directional without anything in the run record saying so. The bot now reports each guard, the
// coordinator logs balances and guard counts, and (opt-in) refills what fell below half.
//
// Local-deploy overlay for the WBTC leg, as in flowBaseGuard.test.ts.
process.env.ERIS_LOCAL_DEPLOY = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

const { Rng } = await import("@eris/sdk/rng.js");
const { buildFlowOrders } = await import("../core/src/flow/logic.js");
const { FlowGuardLog, planFlowTopUp } =
  await import("../core/src/realtime/flowWallets.js");
const { parseFlowLine } = await import("../core/src/flowProcess.js");
type FlowContextWire = import("../core/src/flow/logic.js").FlowContextWire;
type FlowGuardNote = import("../core/src/flow/logic.js").FlowGuardNote;

const WEI = 10n ** 18n;

function ctx(
  round: number,
  balance: { wethWei: string; usdcUnits: string },
): FlowContextWire {
  const protocols = ["uniswap", "balancer", "curve"] as const;
  const flowBalances: FlowContextWire["flowBalances"] = {};
  for (const p of protocols)
    for (const kind of ["informed", "uninformed"] as const)
      flowBalances[`${p}:${kind}`] = {
        ...balance,
        bases: { WETH: balance.wethWei },
      };
  return {
    round,
    fairPriceUsdcPerWeth: 2000,
    protocols: [...protocols],
    // Two venues above fair (informed sells WETH), one below (informed buys).
    poolPrices: { uniswap: 2100, balancer: 2100, curve: 1900 },
    flowBalances,
    limits: {
      uninformedFlowMaxWethWei: "1000000000000000000",
      informedFlowMaxWethWei: "2000000000000000000",
      balancerFlowMaxWethWei: "1000000000000000000",
      curveFlowMaxWethWei: "1000000000000000000",
      gmxFlowMaxSizeUsd: "0",
      aaveFlowMaxWethWei: "0",
      aaveFlowBorrowUsdcUnits: "0",
      defaultPriorityFeeWei: "100000000",
    },
  };
}

const FUNDED = { wethWei: (150n * WEI).toString(), usdcUnits: "450000000000" };
const NO_WETH = { wethWei: "0", usdcUnits: "450000000000" };
const NO_USDC = { wethWei: (150n * WEI).toString(), usdcUnits: "0" };

test("collecting guard notes changes no order and no random draw", () => {
  for (const balance of [FUNDED, NO_WETH, NO_USDC]) {
    for (let round = 1; round <= 20; round++) {
      const a = new Rng(round);
      const b = new Rng(round);
      const plain = buildFlowOrders(a, ctx(round, balance));
      const guards: FlowGuardNote[] = [];
      const noted = buildFlowOrders(b, ctx(round, balance), guards);
      assert.deepEqual(noted, plain);
      assert.equal(a.next(), b.next());
    }
  }
});

test("a funded wallet reports no guard", () => {
  const guards: FlowGuardNote[] = [];
  for (let round = 1; round <= 20; round++)
    buildFlowOrders(new Rng(round), ctx(round, FUNDED), guards);
  assert.deepEqual(guards, []);
});

test("a wallet out of WETH reports its sells suppressed or flipped to buys", () => {
  const guards: FlowGuardNote[] = [];
  for (let round = 1; round <= 20; round++)
    buildFlowOrders(new Rng(round), ctx(round, NO_WETH), guards);
  const kinds = new Set(guards.map((g) => `${g.kind}:${g.guard}`));
  assert.ok(kinds.has("informed:sell_suppressed"), [...kinds].join(","));
  assert.ok(kinds.has("uninformed:sell_flipped_to_buy"), [...kinds].join(","));
  for (const g of guards) assert.equal(g.base, "WETH");
});

test("a wallet out of USDC reports its buys suppressed", () => {
  const guards: FlowGuardNote[] = [];
  for (let round = 1; round <= 20; round++)
    buildFlowOrders(new Rng(round), ctx(round, NO_USDC), guards);
  const kinds = new Set(guards.map((g) => `${g.kind}:${g.guard}`));
  assert.ok(kinds.has("informed:buy_suppressed"), [...kinds].join(","));
});

test("the guard log reports each (wallet, base, guard) once per interval and counts all of them", () => {
  const log = new FlowGuardLog();
  const n = (guard: FlowGuardNote["guard"]): FlowGuardNote => ({
    protocol: "uniswap",
    kind: "informed",
    base: "WETH",
    guard,
  });
  assert.equal(
    log.record([n("sell_suppressed"), n("sell_suppressed")]).length,
    1,
  );
  assert.equal(log.record([n("sell_suppressed"), n("buy_capped")]).length, 1);
  assert.deepEqual(log.drain(), {
    "uniswap:informed:WETH": { sell_suppressed: 3, buy_capped: 1 },
  });
  // A new interval reports it again.
  assert.equal(log.record([n("sell_suppressed")]).length, 1);
});

test("top-up: only what fell below half, back to the funded amount", () => {
  const target = {
    ethWei: 1_005n * WEI,
    wethWei: 150n * WEI,
    usdcUnits: 450_000_000_000n,
    bases: { WBTC: 750_000_000n },
  };
  assert.equal(
    planFlowTopUp(
      {
        ethWei: 1_000n * WEI,
        wethWei: 80n * WEI,
        usdcUnits: 300_000_000_000n,
        bases: { WBTC: 500_000_000n },
      },
      target,
    ),
    null,
  );
  const plan = planFlowTopUp(
    {
      ethWei: 1_000n * WEI,
      wethWei: 10n * WEI,
      usdcUnits: 900_000_000_000n,
      bases: { WBTC: 100_000_000n },
    },
    target,
  )!;
  assert.equal(plan.wethWei, 150n * WEI);
  assert.equal(plan.usdcUnits, 0n, "the side with a surplus is left alone");
  assert.deepEqual(plan.bases, { WBTC: 750_000_000n });
  assert.deepEqual(Object.keys(plan.refilled).sort(), ["WBTC", "WETH"]);
});

test("top-up: a token the run never funded is not invented", () => {
  const plan = planFlowTopUp(
    { ethWei: 1_000n * WEI, wethWei: 0n, usdcUnits: 0n, bases: {} },
    {
      ethWei: 1_005n * WEI,
      wethWei: 0n,
      usdcUnits: 25_000_000_000n,
      bases: {},
    },
  )!;
  assert.equal(plan.wethWei, 0n);
  assert.equal(plan.usdcUnits, 25_000_000_000n);
});

test("the bot's line: a bare array, or orders with the guards and the block", () => {
  assert.deepEqual(parseFlowLine([]), { orders: [], guards: [] });
  const guard = {
    protocol: "curve",
    kind: "informed",
    base: "WETH",
    guard: "sell_capped",
  };
  assert.deepEqual(parseFlowLine({ orders: [], guards: [guard], round: 42 }), {
    orders: [],
    guards: [guard],
    round: 42,
  });
  assert.equal(parseFlowLine({ nope: 1 }), null);
});
