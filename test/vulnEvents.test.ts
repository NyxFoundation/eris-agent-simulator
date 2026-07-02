import test from "node:test";
import assert from "node:assert/strict";
import {
  VulnSchedule,
  parseVulnEvents,
  type VulnEventConfig,
} from "../src/realtime/vulnEvents.js";

// 固定レンジ（min==max）で seed に依らずプール数/rigged 数/窓が確定する 1 event。
const FIXED: VulnEventConfig = {
  type: "rigged-pool",
  windowFrac: [0.5, 0.5],
  poolCount: [4, 4],
  riggedFrac: [0.5, 0.5],
  baitBps: [300, 300],
  rugBps: [4000, 4000],
  rugThresholdFrac: [0.3, 0.3],
};

test("固定レンジで poolCount / riggedCount / startBlock が確定", () => {
  const s = new VulnSchedule([FIXED], 1, 20, ["WETH"]);
  assert.equal(s.events.length, 1);
  const ev = s.events[0];
  assert.equal(ev.poolCount, 4);
  assert.equal(ev.riggedCount, 2); // round(4 * 0.5)
  assert.equal(ev.startBlock, 10); // round(0.5 * 20)
  assert.equal(ev.pools.length, 4);
  // rigged は正確に riggedCount 個（位置はシャッフルで位置依存の side-channel を潰す）
  assert.equal(ev.pools.filter((p) => p.rigged).length, 2);
  // 固定レンジなのでパラメータは全プール一致
  for (const p of ev.pools) {
    assert.equal(p.baitBps, 300);
    assert.equal(p.rugBps, 4000);
    assert.ok(Math.abs(p.rugThresholdFrac - 0.3) < 1e-9);
    assert.equal(p.startBlock, 10);
    assert.equal(p.base, "WETH");
  }
});

test("poolsStartingAt は startBlock のプールだけ返す", () => {
  const s = new VulnSchedule([FIXED], 1, 20, ["WETH"]);
  assert.equal(s.poolsStartingAt(9).length, 0);
  assert.equal(s.poolsStartingAt(10).length, 4);
  assert.equal(s.poolsStartingAt(11).length, 0);
});

test("pools() は deploy 順（poolIndex 昇順）でフラット", () => {
  const s = new VulnSchedule([FIXED, FIXED], 3, 30, ["WETH"]);
  const pools = s.pools();
  assert.equal(pools.length, 8);
  assert.deepEqual(
    pools.map((p) => p.poolIndex),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
});

test("同一 SEED は同一スケジュール（再現性）", () => {
  const cfg: VulnEventConfig = {
    type: "rigged-pool",
    windowFrac: [0.3, 0.7],
    poolCount: [4, 8],
    riggedFrac: [0.5, 0.8],
    baitBps: [200, 600],
    rugBps: [3000, 6000],
    rugThresholdFrac: [0.2, 0.6],
  };
  const a = new VulnSchedule([cfg], 42, 60, ["WETH", "WBTC"]);
  const b = new VulnSchedule([cfg], 42, 60, ["WETH", "WBTC"]);
  assert.deepEqual(a.events, b.events);
  // レンジ内に収まる
  for (const p of a.pools()) {
    assert.ok(p.baitBps >= 200 && p.baitBps <= 600);
    assert.ok(p.rugBps >= 3000 && p.rugBps <= 6000);
    assert.ok(p.rugThresholdFrac >= 0.2 && p.rugThresholdFrac <= 0.6);
    assert.ok(p.startBlock >= 0 && p.startBlock < 60);
    assert.ok(["WETH", "WBTC"].includes(p.base));
  }
});

test("異なる SEED はスケジュールが変わりうる（過学習抑制）", () => {
  const cfg: VulnEventConfig = {
    type: "rigged-pool",
    windowFrac: [0.2, 0.8],
    poolCount: [4, 8],
    riggedFrac: [0.4, 0.8],
    baitBps: [200, 600],
    rugBps: [3000, 6000],
    rugThresholdFrac: [0.2, 0.6],
  };
  const a = new VulnSchedule([cfg], 1, 60, ["WETH"]);
  const b = new VulnSchedule([cfg], 999, 60, ["WETH"]);
  // 少なくとも 1 つのパラメータは異なる（決定論だが seed 依存）
  assert.notDeepEqual(a.events, b.events);
});

test("rigged はシャッフルされ位置に依存しない（side-channel 抑止）", () => {
  // poolCount 大・riggedFrac 0.5 で、rigged が先頭に固まっていない seed が存在することを確認。
  let foundNonLeading = false;
  for (let seed = 1; seed <= 20 && !foundNonLeading; seed++) {
    const s = new VulnSchedule([{ ...FIXED, poolCount: [8, 8] }], seed, 40, [
      "WETH",
    ]);
    const flags = s.events[0].pools.map((p) => p.rigged);
    const riggedCount = flags.filter(Boolean).length;
    assert.equal(riggedCount, 4); // round(8*0.5)
    // 先頭 riggedCount 個が全て rigged という「並び」でない seed を探す
    const leading = flags.slice(0, riggedCount).every(Boolean);
    if (!leading) foundNonLeading = true;
  }
  assert.ok(
    foundNonLeading,
    "rigged はいずれかの seed で非先頭に配置されるはず",
  );
});

test("baseSymbols が複数のとき base が割り当てられる", () => {
  const s = new VulnSchedule([{ ...FIXED, poolCount: [8, 8] }], 7, 40, [
    "WETH",
    "WBTC",
  ]);
  const bases = new Set(s.pools().map((p) => p.base));
  for (const b of bases) assert.ok(["WETH", "WBTC"].includes(b));
});

test("イベント無しは hasEvents=false / pools 空", () => {
  const s = new VulnSchedule([], 1, 20);
  assert.equal(s.hasEvents(), false);
  assert.equal(s.pools().length, 0);
  assert.equal(s.poolsStartingAt(0).length, 0);
});

test("イベントありで runBlocks<=0 は fail-fast", () => {
  assert.throws(() => new VulnSchedule([FIXED], 1, 0), /run\.blocks/);
});

test("startBlock は run 窓内にクランプ（末尾でも < runBlocks）", () => {
  const s = new VulnSchedule([{ ...FIXED, windowFrac: [0.99, 0.99] }], 5, 20, [
    "WETH",
  ]);
  assert.ok(s.events[0].startBlock < 20);
  assert.equal(s.events[0].startBlock, 19); // maxStart = runBlocks-1
});

// ---- parseVulnEvents ----

test("parseVulnEvents: 未設定/空は []", () => {
  assert.deepEqual(parseVulnEvents(undefined), []);
  assert.deepEqual(parseVulnEvents(""), []);
  assert.deepEqual(parseVulnEvents("   "), []);
});

test("parseVulnEvents: 正常 JSON をパース", () => {
  const json =
    '[{"type":"rigged-pool","windowFrac":[0.3,0.7],"poolCount":[4,8],"riggedFrac":[0.5,0.8],"baitBps":[200,600],"rugBps":[3000,6000],"rugThresholdFrac":[0.2,0.6]}]';
  const parsed = parseVulnEvents(json);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, "rigged-pool");
  assert.deepEqual(parsed[0].poolCount, [4, 8]);
  assert.deepEqual(parsed[0].rugBps, [3000, 6000]);
});

test("parseVulnEvents: 不正入力は throw", () => {
  assert.throws(() => parseVulnEvents("not json"), /valid JSON/);
  assert.throws(() => parseVulnEvents("{}"), /must be a JSON array/);
  // 不正な type
  assert.throws(
    () =>
      parseVulnEvents(
        '[{"type":"boom","windowFrac":[0.3,0.7],"poolCount":[4,8],"riggedFrac":[0.5,0.8],"baitBps":[200,600],"rugBps":[3000,6000],"rugThresholdFrac":[0.2,0.6]}]',
      ),
    /type must be/,
  );
  // poolCount 非整数
  assert.throws(
    () =>
      parseVulnEvents(
        '[{"type":"rigged-pool","windowFrac":[0.3,0.7],"poolCount":[4.5,8],"riggedFrac":[0.5,0.8],"baitBps":[200,600],"rugBps":[3000,6000],"rugThresholdFrac":[0.2,0.6]}]',
      ),
    /poolCount must be a pair of integers/,
  );
  // windowFrac 範囲外
  assert.throws(
    () =>
      parseVulnEvents(
        '[{"type":"rigged-pool","windowFrac":[0.3,1.7],"poolCount":[4,8],"riggedFrac":[0.5,0.8],"baitBps":[200,600],"rugBps":[3000,6000],"rugThresholdFrac":[0.2,0.6]}]',
      ),
    /windowFrac/,
  );
  // rugBps は 0 超・10000 以下
  assert.throws(
    () =>
      parseVulnEvents(
        '[{"type":"rigged-pool","windowFrac":[0.3,0.7],"poolCount":[4,8],"riggedFrac":[0.5,0.8],"baitBps":[200,600],"rugBps":[0,6000],"rugThresholdFrac":[0.2,0.6]}]',
      ),
    /rugBps/,
  );
  // baitBps は 9000 以下（>=10000 は負の reserve を生む）
  assert.throws(
    () =>
      parseVulnEvents(
        '[{"type":"rigged-pool","windowFrac":[0.3,0.7],"poolCount":[4,8],"riggedFrac":[0.5,0.8],"baitBps":[200,10000],"rugBps":[3000,6000],"rugThresholdFrac":[0.2,0.6]}]',
      ),
    /baitBps/,
  );
  // rugThresholdFrac は 0 超（0 だと無条件 rig）
  assert.throws(
    () =>
      parseVulnEvents(
        '[{"type":"rigged-pool","windowFrac":[0.3,0.7],"poolCount":[4,8],"riggedFrac":[0.5,0.8],"baitBps":[200,600],"rugBps":[3000,6000],"rugThresholdFrac":[0,0.6]}]',
      ),
    /rugThresholdFrac/,
  );
  // poolCount は 64 以下（過大は setup を無音でハング）
  assert.throws(
    () =>
      parseVulnEvents(
        '[{"type":"rigged-pool","windowFrac":[0.3,0.7],"poolCount":[4,999],"riggedFrac":[0.5,0.8],"baitBps":[200,600],"rugBps":[3000,6000],"rugThresholdFrac":[0.2,0.6]}]',
      ),
    /poolCount/,
  );
});
