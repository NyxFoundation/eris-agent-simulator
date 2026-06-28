import { test } from "node:test";
import assert from "node:assert/strict";
import { Rng } from "../src/rng.js";
import { buildFlowOrders, type FlowContextWire } from "../src/flow/logic.js";

function ctx(round: number): FlowContextWire {
  return {
    round,
    fairPriceUsdcPerWeth: 2000,
    // 本番の順序: config.ALL_PROTOCOLS = [uniswap, balancer, curve, gmx, aave]
    // （gmx が aave より前）。coordinator は enabledIds をこの順で渡すため、テストも揃える。
    protocols: ["uniswap", "balancer", "curve", "gmx", "aave"],
    poolPrices: { uniswap: 1990, balancer: 2010, curve: 2000 },
    aaveReserves: { wethSupplied: "0", usdcBorrowed: "0" },
    limits: {
      uninformedFlowMaxWethWei: "1000000000000000000",
      informedFlowMaxWethWei: "2000000000000000000",
      balancerFlowMaxWethWei: "1000000000000000000",
      curveFlowMaxWethWei: "1000000000000000000",
      gmxFlowMaxSizeUsd: (20_000n * 10n ** 30n).toString(),
      // 既存の構造アサーションを決定論に保つため毎ブロック発火（prob=1）。gate 自体は別テスト。
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

test("buildFlowOrders is reproducible for a fixed seed (固定市場の根拠)", () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let round = 1; round <= 5; round++) {
    assert.deepEqual(
      buildFlowOrders(a, ctx(round)),
      buildFlowOrders(b, ctx(round)),
    );
  }
});

test("buildFlowOrders は protocols を渡された順(本番=enabledAdapters順)でタグ付けする", () => {
  const orders = buildFlowOrders(new Rng(7), ctx(1));
  const idx = (p: string) => orders.findIndex((o) => o.protocol === p);
  // AMM と aave は常に出力される。本番順 uniswap<balancer<curve<(gmx)<aave。
  assert.ok(idx("uniswap") >= 0 && idx("aave") >= 0);
  assert.ok(idx("uniswap") < idx("balancer"));
  assert.ok(idx("balancer") < idx("curve"));
  assert.ok(idx("curve") < idx("aave"));
  // gmx は出力されたラウンドのみ存在し、curve と aave の間に入る。
  if (idx("gmx") >= 0) {
    assert.ok(idx("curve") < idx("gmx"));
    assert.ok(idx("gmx") < idx("aave"));
  }
  // AMM は uninformed+informed の 2 本ずつ
  assert.equal(orders.filter((o) => o.protocol === "uniswap").length, 2);
});

test("informed AMM flow は pool を fair に寄せる (pool<fair → USDC で WETH 買い)", () => {
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

test("aave flow は supplied===0 のとき aaveSupply を出す", () => {
  const orders = buildFlowOrders(new Rng(3), ctx(1));
  const aave = orders.find((o) => o.protocol === "aave");
  assert.ok(aave);
  assert.equal((aave!.action as { type: string }).type, "aaveSupply");
});

test("USDC-only flow: aave は WETH supply 前に同じ wallet で USDC→WETH swap を出す", () => {
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

test("USDC-only flow: WETH-in AMM flow は USDC-in に倒して残高不足 revert を避ける", () => {
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

test("異なる seed は異なる flow を生む", () => {
  const o1 = buildFlowOrders(new Rng(1), ctx(1));
  const o2 = buildFlowOrders(new Rng(999), ctx(1));
  assert.notDeepEqual(
    o1.map((o) => o.priorityFeeWei.toString()),
    o2.map((o) => o.priorityFeeWei.toString()),
  );
});

// gmx/aave の送信頻度を prob で上書きした ctx。
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

test("gmx/aave activity prob=0 は当該 flow を一切出さない", () => {
  for (let round = 1; round <= 20; round++) {
    const orders = buildFlowOrders(
      new Rng(round * 7),
      probCtx(round, "0", "0"),
    );
    assert.equal(
      orders.filter((o) => o.protocol === "gmx").length,
      0,
      "gmx prob=0 では gmx flow なし",
    );
    assert.equal(
      orders.filter((o) => o.protocol === "aave").length,
      0,
      "aave prob=0 では aave flow なし",
    );
  }
});

test("gmx/aave activity prob はブロックごとにランダムに発火する（毎回ではない）", () => {
  // prob=0.5 で多数ブロックを回すと、出るブロックと出ないブロックが混在する（規則的でない）。
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
  // 毎ブロックでも 0 でもなく、おおむね半分前後（規則的な毎ブロック churn ではない）。
  assert.ok(gmxBlocks > 0 && gmxBlocks < N, `gmx は間欠的: ${gmxBlocks}/${N}`);
  assert.ok(
    aaveBlocks > 0 && aaveBlocks < N,
    `aave は間欠的: ${aaveBlocks}/${N}`,
  );
});

test("gmx/aave activity prob=1 は毎ブロック発火する（gmx は約定可能なラウンド全て）", () => {
  // aave は状態機械が必ず 1 ステップ進むため prob=1 で毎ブロック 1 件出る。
  for (let round = 1; round <= 20; round++) {
    const orders = buildFlowOrders(
      new Rng(round * 13),
      probCtx(round, "1", "1"),
    );
    assert.equal(
      orders.filter((o) => o.protocol === "aave").length,
      1,
      "aave prob=1 では毎ブロック 1 件",
    );
  }
});
