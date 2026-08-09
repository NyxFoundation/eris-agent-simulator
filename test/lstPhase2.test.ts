// Issue #38 phase 2: what makes the LST choice non-trivial.
//
// Phase 1 shipped a venue whose optimum was "stake everything at block 0" and stay there. These
// cover the three things that break that: a yield that moves, a queue that congests, and a slash
// that repricess the vault mid-run.
import test from "node:test";
import assert from "node:assert/strict";
import { ApySchedule } from "../core/src/realtime/lst.js";
import { EventSchedule, parseStressEvents } from "../core/src/realtime/events.js";
import { queueFitsInRun } from "../example/agents/lst-carry/agent.js";

// ---------------------------------------------------------------------------
// Seed-driven APY variation
// ---------------------------------------------------------------------------

function sample(schedule: ApySchedule, blocks: number): Array<number | null> {
  return Array.from({ length: blocks }, (_, i) => schedule.nextAt(i));
}

test("the APY only moves on its own cadence", () => {
  const s = new ApySchedule(1, [100, 900], 10, 300);
  const path = sample(s, 30);
  // Blocks 0, 10, 20 may change it; nothing in between does.
  for (let i = 0; i < 30; i++) {
    if (i % 10 !== 0) assert.equal(path[i], null, `block ${i} changed the APY`);
  }
  assert.ok(path.filter((v) => v !== null).length > 0, "the APY never moved");
});

test("the APY stays inside the configured range", () => {
  const s = new ApySchedule(7, [100, 900], 1, 300);
  for (const v of sample(s, 200)) {
    if (v === null) continue;
    assert.ok(v >= 100 && v <= 900, `sampled ${v} outside [100,900]`);
  }
});

test("the same seed gives the same yield path, a different seed does not", () => {
  const a = sample(new ApySchedule(1, [100, 900], 5, 300), 50);
  const b = sample(new ApySchedule(1, [100, 900], 5, 300), 50);
  const c = sample(new ApySchedule(2, [100, 900], 5, 300), 50);
  assert.deepEqual(a, b, "the same seed must reproduce the path");
  assert.notDeepEqual(a, c, "a different seed should change it (anti-overfitting)");
});

test("a degenerate range pins the yield and stops writing", () => {
  // min == max: the first step sets it, and nothing after that is a change worth a transaction.
  const s = new ApySchedule(1, [500, 500], 1, 300);
  const path = sample(s, 10);
  assert.equal(path[0], 500);
  assert.ok(path.slice(1).every((v) => v === null));
});

// ---------------------------------------------------------------------------
// The slash event in the stress overlay
// ---------------------------------------------------------------------------

const slashCfg = JSON.stringify([
  { type: "lstSlash", magnitudeRange: [0.01, 0.03], windowFrac: [0.3, 0.5] },
]);

test("a slash parses without the trapezoid fields spike/crash require", () => {
  const [cfg] = parseStressEvents(slashCfg);
  assert.equal(cfg.type, "lstSlash");
  assert.equal(cfg.rampBlocks, 0);
  assert.equal(cfg.holdBlocks, 0);
  assert.equal(cfg.decayBlocks, 0);
});

test("a slash magnitude at or above the whole pool is rejected", () => {
  assert.throws(
    () =>
      parseStressEvents(
        JSON.stringify([
          { type: "lstSlash", magnitudeRange: [0.5, 1.5], windowFrac: [0, 1] },
        ]),
      ),
    /magnitudeRange max must be <= 1/,
  );
});

test("a slash lands on exactly one block and never touches the price overlay", () => {
  const schedule = new EventSchedule(parseStressEvents(slashCfg), 1, 100);
  const [ev] = schedule.events;
  assert.equal(ev.endBlock, ev.startBlock + 1);
  const fired: number[] = [];
  for (let i = 0; i < 100; i++) {
    if (schedule.pointEventsAt(i).length > 0) fired.push(i);
    // A slash is not a price distortion: the overlay stays neutral throughout.
    assert.equal(schedule.at(i).wethMult, 1);
  }
  assert.deepEqual(fired, [ev.startBlock]);
  assert.ok(ev.magnitude >= 0.01 && ev.magnitude <= 0.03);
});

test("a slash coexists with a crash without disturbing it", () => {
  const configs = parseStressEvents(
    JSON.stringify([
      {
        type: "crash",
        magnitudeRange: [0.1, 0.1],
        windowFrac: [0.2, 0.2],
        rampBlocks: 2,
        holdBlocks: 2,
        decayBlocks: 2,
      },
      { type: "lstSlash", magnitudeRange: [0.02, 0.02], windowFrac: [0.6, 0.6] },
    ]),
  );
  const schedule = new EventSchedule(configs, 1, 100);
  const crash = schedule.events[0];
  const slash = schedule.events[1];
  // The crash still moves the price at its peak, and the slash's block does not.
  assert.ok(schedule.at(crash.startBlock + 2).wethMult < 1);
  assert.equal(schedule.at(slash.startBlock).wethMult, 1);
  assert.deepEqual(
    schedule.pointEventsAt(slash.startBlock).map((e) => e.type),
    ["lstSlash"],
  );
});

// ---------------------------------------------------------------------------
// Congestion, from the agent's side
// ---------------------------------------------------------------------------

test("congestion can close the queue that the floor says is open", () => {
  // 40 blocks left against a 20-block floor: judged on the floor the queue is comfortably open.
  // Judged on what a congested queue actually quotes for this size (36 blocks, plus the agent's
  // 4-block margin), it is not.
  assert.ok(queueFitsInRun(40, 20));
  assert.ok(!queueFitsInRun(40, 36));
});
