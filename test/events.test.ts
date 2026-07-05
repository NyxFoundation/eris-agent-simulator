import test from "node:test";
import assert from "node:assert/strict";
import {
  EventSchedule,
  parseStressEvents,
  type StressEventConfig,
} from "../core/src/realtime/events.js";

// A single crash whose trapezoid is fixed regardless of seed via fixed magnitude/window (min==max).
const FIXED_CRASH: StressEventConfig = {
  type: "crash",
  magnitudeRange: [0.1, 0.1],
  windowFrac: [0.5, 0.5],
  rampBlocks: 2,
  holdBlocks: 2,
  decayBlocks: 2,
};

test("crash overlay is a trapezoid (1 outside the window, max deviation 1-m during hold)", () => {
  const s = new EventSchedule([FIXED_CRASH], 1, 20);
  assert.equal(s.events.length, 1);
  const ev = s.events[0];
  assert.equal(ev.startBlock, 10); // round(0.5*20)
  assert.equal(ev.endBlock, 16); // start + ramp+hold+decay(6)

  // outside the window (β-neutral, does not break ADR 0007): effective === base
  assert.equal(s.at(9).wethMult, 1);
  assert.equal(s.at(16).wethMult, 1);
  assert.equal(s.at(100).wethMult, 1);

  // the hold interval has max deviation 1-m=0.9
  assert.ok(Math.abs(s.at(11).wethMult - 0.9) < 1e-9, `${s.at(11).wethMult}`);
  assert.ok(Math.abs(s.at(12).wethMult - 0.9) < 1e-9, `${s.at(12).wethMult}`);
  // ramp rise (t=0 -> e=0.5 -> 0.95)
  assert.ok(Math.abs(s.at(10).wethMult - 0.95) < 1e-9, `${s.at(10).wethMult}`);
  // usdcPx is always 1 in v1
  assert.equal(s.at(12).usdcPx, 1);
});

test("spike overlay is upward (1+m during hold)", () => {
  const s = new EventSchedule([{ ...FIXED_CRASH, type: "spike" }], 1, 20);
  assert.ok(Math.abs(s.at(12).wethMult - 1.1) < 1e-9, `${s.at(12).wethMult}`);
  assert.ok(s.at(12).wethMult > 1);
});

test("activeEventAt is true only within the window (endBlock is exclusive)", () => {
  const s = new EventSchedule([FIXED_CRASH], 1, 20);
  assert.equal(s.activeEventAt(9), null);
  assert.ok(s.activeEventAt(10));
  assert.ok(s.activeEventAt(15));
  assert.equal(s.activeEventAt(16), null);
});

test("the same SEED yields the same schedule (reproducibility)", () => {
  const cfg: StressEventConfig = {
    type: "crash",
    magnitudeRange: [0.05, 0.15],
    windowFrac: [0.2, 0.8],
    rampBlocks: 3,
    holdBlocks: 4,
    decayBlocks: 5,
  };
  const a = new EventSchedule([cfg], 42, 60);
  const b = new EventSchedule([cfg], 42, 60);
  assert.deepEqual(a.events, b.events);
  // magnitude/start are within range
  const ev = a.events[0];
  assert.ok(ev.magnitude >= 0.05 && ev.magnitude <= 0.15);
  assert.ok(ev.startBlock >= 0 && ev.endBlock <= 60);
});

test("startBlock is clamped so the window fits inside the run window", () => {
  // endBlock <= runBlocks even with windowFrac near the end
  const cfg: StressEventConfig = {
    type: "crash",
    magnitudeRange: [0.1, 0.1],
    windowFrac: [0.99, 0.99],
    rampBlocks: 3,
    holdBlocks: 4,
    decayBlocks: 5, // span 12
  };
  const s = new EventSchedule([cfg], 7, 20);
  assert.ok(s.events[0].endBlock <= 20, `${s.events[0].endBlock}`);
  assert.equal(s.events[0].startBlock, 8); // maxStart = 20-12
});

test("no events always yields wethMult=1 (matches a legacy run)", () => {
  const s = new EventSchedule([], 1, 20);
  assert.equal(s.hasEvents(), false);
  assert.equal(s.at(0).wethMult, 1);
  assert.equal(s.at(10).wethMult, 1);
});

test("events with runBlocks<=0 fail-fast", () => {
  assert.throws(
    () => new EventSchedule([FIXED_CRASH], 1, 0),
    /ERIS_RUN_BLOCKS/,
  );
});

test("overlapping events compose multiplicatively", () => {
  // overlap a crash and a spike in the same window -> (1-0.1)*(1+0.1)=0.99 during hold
  const s = new EventSchedule(
    [FIXED_CRASH, { ...FIXED_CRASH, type: "spike" }],
    1,
    20,
  );
  assert.ok(Math.abs(s.at(12).wethMult - 0.99) < 1e-9, `${s.at(12).wethMult}`);
});

// ---- parseStressEvents ----

test("parseStressEvents: unset/empty is []", () => {
  assert.deepEqual(parseStressEvents(undefined), []);
  assert.deepEqual(parseStressEvents(""), []);
  assert.deepEqual(parseStressEvents("   "), []);
});

test("parseStressEvents: parses valid JSON", () => {
  const json =
    '[{"type":"crash","magnitudeRange":[0.06,0.10],"windowFrac":[0.3,0.7],"rampBlocks":3,"holdBlocks":6,"decayBlocks":8}]';
  const parsed = parseStressEvents(json);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, "crash");
  assert.deepEqual(parsed[0].magnitudeRange, [0.06, 0.1]);
});

test("parseStressEvents: invalid input throws", () => {
  assert.throws(() => parseStressEvents("not json"), /valid JSON/);
  assert.throws(() => parseStressEvents("{}"), /must be a JSON array/);
  assert.throws(
    () =>
      parseStressEvents(
        '[{"type":"boom","magnitudeRange":[0.1,0.1],"windowFrac":[0.3,0.7],"rampBlocks":1,"holdBlocks":1,"decayBlocks":1}]',
      ),
    /type must be/,
  );
  assert.throws(
    () =>
      parseStressEvents(
        '[{"type":"crash","magnitudeRange":[0.1],"windowFrac":[0.3,0.7],"rampBlocks":1,"holdBlocks":1,"decayBlocks":1}]',
      ),
    /magnitudeRange/,
  );
  assert.throws(
    () =>
      parseStressEvents(
        '[{"type":"crash","magnitudeRange":[0.1,0.1],"windowFrac":[0.3,1.7],"rampBlocks":1,"holdBlocks":1,"decayBlocks":1}]',
      ),
    /windowFrac/,
  );
  assert.throws(
    () =>
      parseStressEvents(
        '[{"type":"crash","magnitudeRange":[0.1,0.1],"windowFrac":[0.3,0.7],"rampBlocks":0,"holdBlocks":0,"decayBlocks":0}]',
      ),
    /positive total window/,
  );
});
