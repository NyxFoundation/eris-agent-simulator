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

test("gmx/aave activity prob=1・maxBurst 既定(1) は毎ブロック 1 件", () => {
  // probCtx は maxBurst を渡さない → decode 既定 1 → 状態機械は 1 ステップ＝1 件。
  for (let round = 1; round <= 20; round++) {
    const orders = buildFlowOrders(
      new Rng(round * 13),
      probCtx(round, "1", "1"),
    );
    assert.equal(
      orders.filter((o) => o.protocol === "aave").length,
      1,
      "aave prob=1・burst=1 では毎ブロック 1 件",
    );
  }
});

// gmx の maxBurst を上書きした ctx（prob=1 で必ず発火させてバーストを観測）。
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

test("gmx maxBurst>1 は 1 ブロックに複数の建玉を出しうる（1〜N でばらつく）", () => {
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
  assert.ok(gmxMultiBlocks > 0, "gmx は複数件のブロックが存在する");
  assert.ok(gmxMax > 1 && gmxMax <= 4, `gmx burst は 1〜4: max=${gmxMax}`);
});

// aave 借り手プール: N アクターを与えた ctx。各アクターは別アドレス・持続ポジション。
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

test("aave 借り手プール: 担保済みアクターが複数いると 1 ブロックに複数 borrow が出る", () => {
  // 4 アクター全員 担保あり・無借金。HF 余力ありなので borrow を選びうる。
  const actors = [0, 1, 2, 3].map((i) => ({
    key: `aave:actor${i}`,
    wethSupplied: "2000000000000000000", // 2 WETH 担保 → 借入余力あり
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
    // borrow は別アクター（別ウォレット鍵）から出る。
    const keys = new Set(borrows.map((o) => o.walletKey));
    maxBorrowsInBlock = Math.max(maxBorrowsInBlock, borrows.length);
    if (borrows.length > 1) {
      multiBorrowBlocks++;
      assert.equal(
        keys.size,
        borrows.length,
        "各 borrow は別アクター（別アドレス）から",
      );
    }
  }
  assert.ok(multiBorrowBlocks > 0, "1 ブロックに複数 borrow が実在する");
  assert.ok(
    maxBorrowsInBlock >= 3,
    `3 件以上同時 borrow が起きる: max=${maxBorrowsInBlock}`,
  );
});

test("aave 借り手プール: borrow 後に強制 repay されず債務は持続する（actor 状態を引き継ぐ）", () => {
  // 借金ありアクターを 1 体与え、多ブロック回しても全ブロックが repay にはならない
  // （borrow/supply など債務を残す行動も選ばれる）＝強制 repay 往復ではない。
  // 担保確立済・少額債務（目標 30% LTV=1200 USDC を十分下回る）→ borrow が選ばれうる状態。
  const actor = {
    key: "aave:actor0",
    wethSupplied: "2000000000000000000", // 2 WETH 担保（目標到達済→ supply しない）
    usdcBorrowed: "200000000", // 200 USDC の既存債務（目標まで余裕＝借り増し可）
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
  // borrow が観測される（債務を積み増す＝「borrow→強制 repay」往復ではない）。
  assert.ok(
    actionTypes.has("aaveBorrow"),
    `借り増しが起きる: ${[...actionTypes].join(",")}`,
  );
});

test("Rng.poisson/lognormal are deterministic and in-range", () => {
  const a = new Rng(5);
  const b = new Rng(5);
  for (let i = 0; i < 10; i++) {
    assert.equal(a.poisson(0.8), b.poisson(0.8));
    assert.equal(a.lognormal(0.5, 1), b.lognormal(0.5, 1));
  }
  // poisson(0) は常に 0、lognormal(mean>0) は正
  assert.equal(new Rng(1).poisson(0), 0);
  const s = new Rng(2).lognormal(0.5, 1);
  assert.ok(s > 0 && Number.isFinite(s));
});

test("informedArbFeeBps: gap が fee バンド以下の AMM venue は informed flow を出さない", () => {
  const AMM = new Set(["uniswap", "balancer", "curve"]);
  const ammInformed = (o: { kind: string; protocol: string }): boolean =>
    o.kind === "informed" && AMM.has(o.protocol);
  // 全 AMM venue の pool=fair=2000 → gap=0。fee バンド 30bps 内なので AMM informed は出ない。
  const c = ctx(1);
  c.poolPrices = { uniswap: 2000, balancer: 2000, curve: 2000 };
  c.limits.informedArbFeeBps = "30";
  const gated = buildFlowOrders(new Rng(9), c).filter(ammInformed);
  assert.equal(gated.length, 0, "gap 0 の AMM venue は informed 0 本");
  // off（0）なら従来どおり gap 0 でも AMM informed が出る（byte 互換）。
  c.limits.informedArbFeeBps = "0";
  const off = buildFlowOrders(new Rng(9), c).filter(ammInformed);
  assert.ok(off.length >= 1, "off なら gap 0 でも AMM informed が出る");
});

test("uninformedArrivalRate: Poisson モードは 0 件ブロックも生む（本数が変動）", () => {
  const c = ctx(1);
  c.limits.uninformedArrivalRate = "0.6";
  c.limits.uninformedSizeSigma = "1";
  // λ=0.6 なら本数が round ごとに変わる（0 件も出る）。固定本数でないことを確認。
  const counts = new Set<number>();
  const rng = new Rng(3);
  for (let round = 1; round <= 40; round++) {
    const c2 = { ...c, round };
    const uni = buildFlowOrders(rng, c2).filter(
      (o) => o.kind === "uninformed" && o.protocol === "uniswap",
    ).length;
    counts.add(uni);
  }
  assert.ok(counts.size > 1, "Poisson なら本数が変動する（固定でない）");
});

test("gmxArrivalRate: Poisson モードで GMX 建玉本数が変動する", () => {
  const c = ctx(1);
  c.protocols = ["gmx"]; // gmx だけに絞る
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
  assert.ok(counts.size > 1, "Poisson なら建玉本数が変動する");
  assert.ok(counts.has(0), "0 件ブロックも自然に出る");
});

test("aaveActorSizeSigma: アクターの目標担保が key で不均質・ブロック間で安定", () => {
  const AAVE = { actors: 4 };
  const mkCtx = (round: number): FlowContextWire => {
    const base = ctx(round);
    base.protocols = ["aave"];
    base.aaveActors = Array.from({ length: AAVE.actors }, (_, i) => ({
      key: `aave:actor${i}`,
      wethSupplied: "0",
      usdcBorrowed: "0",
      wethWei: "100000000000000000000", // 潤沢な担保原資
      usdcUnits: "0",
    }));
    base.limits.aaveActorSizeSigma = "1.2";
    base.limits.aaveFlowActivityProb = "1"; // 全アクター毎ブロック行動
    return base;
  };
  // 同一 round・同一 seed なら supply 額（= 目標担保由来）が決定論。
  const a = buildFlowOrders(new Rng(1), mkCtx(1));
  const b = buildFlowOrders(new Rng(1), mkCtx(1));
  assert.deepEqual(a, b, "決定論");
  // アクターごとに supply 額が異なる（不均質）。全 supply が同額でないことを確認。
  const supplies = a
    .filter(
      (o) =>
        (o.action as { type?: string }).type === "aaveSupply",
    )
    .map((o) => (o.action as { amount: string }).amount);
  assert.ok(supplies.length >= 2, "複数アクターが supply する");
  assert.ok(new Set(supplies).size > 1, "目標担保がアクターごとに異なる");
});
