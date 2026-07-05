import test from "node:test";
import assert from "node:assert/strict";
import {
  VulnSchedule,
  parseVulnEvents,
  type VulnEventConfig,
} from "../core/src/realtime/vulnEvents.js";

// A single event whose pool count / rigged count / window are fixed regardless of seed via a fixed range (min==max).
const FIXED: VulnEventConfig = {
  type: "rigged-pool",
  windowFrac: [0.5, 0.5],
  poolCount: [4, 4],
  riggedFrac: [0.5, 0.5],
  baitBps: [300, 300],
  rugBps: [4000, 4000],
  rugThresholdFrac: [0.3, 0.3],
};

test("with a fixed range, poolCount / riggedCount / startBlock are determined", () => {
  const s = new VulnSchedule([FIXED], 1, 20, ["WETH"]);
  assert.equal(s.events.length, 1);
  const ev = s.events[0];
  assert.equal(ev.poolCount, 4);
  assert.equal(ev.riggedCount, 2); // round(4 * 0.5)
  assert.equal(ev.startBlock, 10); // round(0.5 * 20)
  assert.equal(ev.pools.length, 4);
  // exactly riggedCount rigged pools (positions are shuffled to kill a position-dependent side-channel)
  assert.equal(ev.pools.filter((p) => p.rigged).length, 2);
  // fixed range, so parameters are identical across all pools
  for (const p of ev.pools) {
    assert.equal(p.baitBps, 300);
    assert.equal(p.rugBps, 4000);
    assert.ok(Math.abs(p.rugThresholdFrac - 0.3) < 1e-9);
    assert.equal(p.startBlock, 10);
    assert.equal(p.base, "WETH");
  }
});

test("poolsStartingAt returns only pools at startBlock", () => {
  const s = new VulnSchedule([FIXED], 1, 20, ["WETH"]);
  assert.equal(s.poolsStartingAt(9).length, 0);
  assert.equal(s.poolsStartingAt(10).length, 4);
  assert.equal(s.poolsStartingAt(11).length, 0);
});

test("pools() is flat in deploy order (ascending poolIndex)", () => {
  const s = new VulnSchedule([FIXED, FIXED], 3, 30, ["WETH"]);
  const pools = s.pools();
  assert.equal(pools.length, 8);
  assert.deepEqual(
    pools.map((p) => p.poolIndex),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
});

test("the same SEED yields the same schedule (reproducibility)", () => {
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
  // stays within range
  for (const p of a.pools()) {
    assert.ok(p.baitBps >= 200 && p.baitBps <= 600);
    assert.ok(p.rugBps >= 3000 && p.rugBps <= 6000);
    assert.ok(p.rugThresholdFrac >= 0.2 && p.rugThresholdFrac <= 0.6);
    assert.ok(p.startBlock >= 0 && p.startBlock < 60);
    assert.ok(["WETH", "WBTC"].includes(p.base));
  }
});

test("a different SEED can change the schedule (curbs overfitting)", () => {
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
  // at least one parameter differs (deterministic but seed-dependent)
  assert.notDeepEqual(a.events, b.events);
});

test("rigged pools are shuffled and position-independent (side-channel prevention)", () => {
  // with large poolCount and riggedFrac 0.5, confirm there exists a seed where rigged is not clustered at the front.
  let foundNonLeading = false;
  for (let seed = 1; seed <= 20 && !foundNonLeading; seed++) {
    const s = new VulnSchedule([{ ...FIXED, poolCount: [8, 8] }], seed, 40, [
      "WETH",
    ]);
    const flags = s.events[0].pools.map((p) => p.rigged);
    const riggedCount = flags.filter(Boolean).length;
    assert.equal(riggedCount, 4); // round(8*0.5)
    // look for a seed whose arrangement is not "the first riggedCount are all rigged"
    const leading = flags.slice(0, riggedCount).every(Boolean);
    if (!leading) foundNonLeading = true;
  }
  assert.ok(foundNonLeading, "rigged should be placed off-front for some seed");
});

test("a base is assigned when baseSymbols has multiple entries", () => {
  const s = new VulnSchedule([{ ...FIXED, poolCount: [8, 8] }], 7, 40, [
    "WETH",
    "WBTC",
  ]);
  const bases = new Set(s.pools().map((p) => p.base));
  for (const b of bases) assert.ok(["WETH", "WBTC"].includes(b));
});

test("no events yields hasEvents=false / empty pools", () => {
  const s = new VulnSchedule([], 1, 20);
  assert.equal(s.hasEvents(), false);
  assert.equal(s.pools().length, 0);
  assert.equal(s.poolsStartingAt(0).length, 0);
});

test("events with runBlocks<=0 fail-fast", () => {
  assert.throws(() => new VulnSchedule([FIXED], 1, 0), /run\.blocks/);
});

test("startBlock is clamped inside the run window (< runBlocks even at the end)", () => {
  const s = new VulnSchedule([{ ...FIXED, windowFrac: [0.99, 0.99] }], 5, 20, [
    "WETH",
  ]);
  assert.ok(s.events[0].startBlock < 20);
  assert.equal(s.events[0].startBlock, 19); // maxStart = runBlocks-1
});

// ---- parseVulnEvents ----

test("parseVulnEvents: unset/empty is []", () => {
  assert.deepEqual(parseVulnEvents(undefined), []);
  assert.deepEqual(parseVulnEvents(""), []);
  assert.deepEqual(parseVulnEvents("   "), []);
});

test("parseVulnEvents: parses valid JSON", () => {
  const json =
    '[{"type":"rigged-pool","windowFrac":[0.3,0.7],"poolCount":[4,8],"riggedFrac":[0.5,0.8],"baitBps":[200,600],"rugBps":[3000,6000],"rugThresholdFrac":[0.2,0.6]}]';
  const parsed = parseVulnEvents(json);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, "rigged-pool");
  assert.deepEqual(parsed[0].poolCount, [4, 8]);
  assert.deepEqual(parsed[0].rugBps, [3000, 6000]);
});

test("parseVulnEvents: invalid input throws", () => {
  assert.throws(() => parseVulnEvents("not json"), /valid JSON/);
  assert.throws(() => parseVulnEvents("{}"), /must be a JSON array/);
  // invalid type
  assert.throws(
    () =>
      parseVulnEvents(
        '[{"type":"boom","windowFrac":[0.3,0.7],"poolCount":[4,8],"riggedFrac":[0.5,0.8],"baitBps":[200,600],"rugBps":[3000,6000],"rugThresholdFrac":[0.2,0.6]}]',
      ),
    /type must be/,
  );
  // non-integer poolCount
  assert.throws(
    () =>
      parseVulnEvents(
        '[{"type":"rigged-pool","windowFrac":[0.3,0.7],"poolCount":[4.5,8],"riggedFrac":[0.5,0.8],"baitBps":[200,600],"rugBps":[3000,6000],"rugThresholdFrac":[0.2,0.6]}]',
      ),
    /poolCount must be a pair of integers/,
  );
  // windowFrac out of range
  assert.throws(
    () =>
      parseVulnEvents(
        '[{"type":"rigged-pool","windowFrac":[0.3,1.7],"poolCount":[4,8],"riggedFrac":[0.5,0.8],"baitBps":[200,600],"rugBps":[3000,6000],"rugThresholdFrac":[0.2,0.6]}]',
      ),
    /windowFrac/,
  );
  // rugBps must be > 0 and <= 10000
  assert.throws(
    () =>
      parseVulnEvents(
        '[{"type":"rigged-pool","windowFrac":[0.3,0.7],"poolCount":[4,8],"riggedFrac":[0.5,0.8],"baitBps":[200,600],"rugBps":[0,6000],"rugThresholdFrac":[0.2,0.6]}]',
      ),
    /rugBps/,
  );
  // baitBps must be <= 9000 (>=10000 would produce a negative reserve)
  assert.throws(
    () =>
      parseVulnEvents(
        '[{"type":"rigged-pool","windowFrac":[0.3,0.7],"poolCount":[4,8],"riggedFrac":[0.5,0.8],"baitBps":[200,10000],"rugBps":[3000,6000],"rugThresholdFrac":[0.2,0.6]}]',
      ),
    /baitBps/,
  );
  // rugThresholdFrac must be > 0 (0 means unconditional rig)
  assert.throws(
    () =>
      parseVulnEvents(
        '[{"type":"rigged-pool","windowFrac":[0.3,0.7],"poolCount":[4,8],"riggedFrac":[0.5,0.8],"baitBps":[200,600],"rugBps":[3000,6000],"rugThresholdFrac":[0,0.6]}]',
      ),
    /rugThresholdFrac/,
  );
  // poolCount must be <= 64 (too large silently hangs setup)
  assert.throws(
    () =>
      parseVulnEvents(
        '[{"type":"rigged-pool","windowFrac":[0.3,0.7],"poolCount":[4,999],"riggedFrac":[0.5,0.8],"baitBps":[200,600],"rugBps":[3000,6000],"rugThresholdFrac":[0.2,0.6]}]',
      ),
    /poolCount/,
  );
});
