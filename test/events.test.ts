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

// ---- liquidityPull (issue #52) ----

const FIXED_PULL: StressEventConfig = {
  type: "liquidityPull",
  magnitudeRange: [0.5, 0.5],
  windowFrac: [0.5, 0.5],
  rampBlocks: 2,
  holdBlocks: 2,
  decayBlocks: 2,
};

test("liquidityPull drives depth on the same trapezoid, and leaves the price alone", () => {
  const s = new EventSchedule([FIXED_PULL], 1, 20);
  assert.equal(s.hasLiquidityPull(), true);
  assert.deepEqual(s.liquidityPullBases(), ["WETH"]);

  // Outside the window there is no entry at all, which the coordinator reads as "restore to seeded".
  assert.deepEqual(s.depthMultiplierAt(9), {});
  assert.deepEqual(s.depthMultiplierAt(16), {});
  // ramp (t=0 -> e=0.5), hold (e=1), decay (t=4 -> e=0.5)
  assert.ok(Math.abs(s.depthMultiplierAt(10).WETH - 0.75) < 1e-9);
  assert.ok(Math.abs(s.depthMultiplierAt(12).WETH - 0.5) < 1e-9);
  assert.ok(Math.abs(s.depthMultiplierAt(14).WETH - 0.75) < 1e-9);

  // A depth event must not move the fair price: it changes the cost of size, not what anything is
  // worth. If it leaked into the overlay it would be a crash nobody configured.
  assert.equal(s.at(12).wethMult, 1);
  assert.equal(s.at(12).usdcPx, 1);
});

test("a run with no liquidityPull never asks for depth changes", () => {
  const s = new EventSchedule([FIXED_CRASH], 1, 20);
  assert.equal(s.hasLiquidityPull(), false);
  assert.deepEqual(s.liquidityPullBases(), []);
  assert.deepEqual(s.depthMultiplierAt(12), {});
});

test("crash and liquidityPull on one window are independent axes", () => {
  const s = new EventSchedule([FIXED_CRASH, FIXED_PULL], 1, 20);
  // The gap is the crash's alone...
  assert.ok(Math.abs(s.at(12).wethMult - 0.9) < 1e-9, `${s.at(12).wethMult}`);
  // ...and the depth is the pull's alone. Composing them is what makes regime 6 a crash rather than
  // a larger opportunity (issue #52).
  assert.ok(Math.abs(s.depthMultiplierAt(12).WETH - 0.5) < 1e-9);
});

test("overlapping liquidityPulls compose multiplicatively", () => {
  const s = new EventSchedule([FIXED_PULL, FIXED_PULL], 1, 20);
  // 0.5 * 0.5: two LPs pulling half each leaves a quarter, not zero.
  assert.ok(Math.abs(s.depthMultiplierAt(12).WETH - 0.25) < 1e-9);
});

test("liquidityPull targets its own base", () => {
  const s = new EventSchedule([{ ...FIXED_PULL, base: "WBTC" }], 1, 20);
  assert.deepEqual(s.liquidityPullBases(), ["WBTC"]);
  assert.equal(s.depthMultiplierAt(12).WETH, undefined);
  assert.ok(Math.abs(s.depthMultiplierAt(12).WBTC - 0.5) < 1e-9);
});

test("alignWith puts the pull on the crash's window rather than its own draw", () => {
  // Same range, independent draws: in a 360-block run the two windows are nowhere near each other.
  const wide: [number, number] = [0.25, 0.7];
  const apart = new EventSchedule(
    [
      { ...FIXED_CRASH, windowFrac: wide },
      { ...FIXED_PULL, windowFrac: wide },
    ],
    606,
    360,
  );
  assert.notEqual(apart.events[0].startBlock, apart.events[1].startBlock);

  const aligned = new EventSchedule(
    [
      { ...FIXED_CRASH, windowFrac: wide },
      { ...FIXED_PULL, windowFrac: wide, alignWith: "crash" },
    ],
    606,
    360,
  );
  assert.equal(aligned.events[1].startBlock, aligned.events[0].startBlock);
  // The crash keeps the position it drew: aligning must not move the event being followed.
  assert.equal(aligned.events[0].startBlock, apart.events[0].startBlock);
  // Its own trapezoid length is unchanged -- only the start is shared.
  assert.equal(
    aligned.events[1].endBlock - aligned.events[1].startBlock,
    apart.events[1].endBlock - apart.events[1].startBlock,
  );

  // ...and now the book is thin exactly while the price is gapping.
  const hold = aligned.events[0].startBlock + 2;
  assert.ok(aligned.at(hold).wethMult < 1);
  assert.ok(aligned.depthMultiplierAt(hold).WETH < 1);
});

test("alignWith refuses what it cannot align", () => {
  // Sliding the follower earlier to make it fit would un-align the pair, which is the one thing
  // alignWith exists to guarantee -- so it is a config error, not a silent adjustment.
  const late: [number, number] = [0.99, 0.99];
  assert.throws(
    () =>
      new EventSchedule(
        [
          { ...FIXED_CRASH, windowFrac: late }, // span 6, clamped to start 14 of 20
          {
            ...FIXED_PULL,
            windowFrac: late,
            alignWith: "crash",
            decayBlocks: 8,
          }, // span 12
        ],
        1,
        20,
      ),
    /its own window is 12 blocks and the run is 20/,
  );
  // Chained alignment would resolve differently depending on the order this pass visits the events.
  assert.throws(
    () =>
      new EventSchedule(
        [
          { ...FIXED_PULL, alignWith: "crash" },
          { ...FIXED_CRASH, alignWith: "spike" },
          { ...FIXED_CRASH, type: "spike" },
        ],
        1,
        60,
      ),
    /chained alignWith is not supported/,
  );
});

test("alignWith is checked against the events that exist", () => {
  assert.throws(
    () => new EventSchedule([{ ...FIXED_PULL, alignWith: "crash" }], 1, 20),
    /no event of that type is configured/,
  );
  assert.throws(
    () =>
      parseStressEvents(
        '[{"type":"liquidityPull","magnitudeRange":[0.4,0.6],"windowFrac":[0.3,0.7],"rampBlocks":1,"holdBlocks":1,"decayBlocks":1,"alignWith":"liquidityPull"}]',
      ),
    /must name a different event type/,
  );
  assert.throws(
    () =>
      parseStressEvents(
        '[{"type":"liquidityPull","magnitudeRange":[0.4,0.6],"windowFrac":[0.3,0.7],"rampBlocks":1,"holdBlocks":1,"decayBlocks":1,"alignWith":"boom"}]',
      ),
    /alignWith must be a stress event type/,
  );
});

test("liquidityPull of the whole book is rejected", () => {
  // At 100% every swap reverts and the venue stops existing for the window -- an outage, not a thin
  // book to size against.
  assert.throws(
    () =>
      parseStressEvents(
        '[{"type":"liquidityPull","magnitudeRange":[0.5,1.0],"windowFrac":[0.3,0.7],"rampBlocks":1,"holdBlocks":1,"decayBlocks":1}]',
      ),
    /magnitudeRange max must be < 1/,
  );
  // ...and it needs a window, like the other trapezoid events.
  assert.throws(
    () =>
      parseStressEvents(
        '[{"type":"liquidityPull","magnitudeRange":[0.4,0.6],"windowFrac":[0.3,0.7],"rampBlocks":0,"holdBlocks":0,"decayBlocks":0}]',
      ),
    /positive total window/,
  );
  // Phase 1 is uniswap-only, so a venue override is refused rather than silently ignored.
  assert.throws(
    () =>
      parseStressEvents(
        '[{"type":"liquidityPull","magnitudeRange":[0.4,0.6],"windowFrac":[0.3,0.7],"rampBlocks":1,"holdBlocks":1,"decayBlocks":1,"venue":"curve"}]',
      ),
    /venue only applies/,
  );
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
