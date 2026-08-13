import test from "node:test";
import assert from "node:assert/strict";
import {
  EventSchedule,
  parseStressEvents,
  withOuOverride,
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

// ---- eusdDepeg (issue #39) ----

const FIXED_DEPEG: StressEventConfig = {
  type: "eusdDepeg",
  magnitudeRange: [0.4, 0.4],
  windowFrac: [0.5, 0.5],
  rampBlocks: 2,
  holdBlocks: 2,
  decayBlocks: 2,
};

test("eusdDepeg drives how much eUSD has been sold, and leaves the price overlay alone", () => {
  const s = new EventSchedule([FIXED_DEPEG], 1, 20);
  assert.equal(s.hasEusdDepeg(), true);

  // Outside the window nothing is sold, which the coordinator reads as "buy it all back".
  assert.equal(s.eusdDepegFractionAt(9), 0);
  assert.equal(s.eusdDepegFractionAt(16), 0);
  // ramp (t=0 -> e=0.5), hold (e=1), decay (t=4 -> e=0.5)
  assert.ok(Math.abs(s.eusdDepegFractionAt(10) - 0.2) < 1e-9);
  assert.ok(Math.abs(s.eusdDepegFractionAt(12) - 0.4) < 1e-9);
  assert.ok(Math.abs(s.eusdDepegFractionAt(14) - 0.2) < 1e-9);

  // The collateral price is untouched: this event moves a stablecoin's market, not ETH.
  assert.equal(s.at(12).wethMult, 1);
});

test("a run with no eusdDepeg never asks for one", () => {
  const s = new EventSchedule([FIXED_CRASH], 1, 20);
  assert.equal(s.hasEusdDepeg(), false);
  assert.equal(s.eusdDepegFractionAt(12), 0);
});

test("overlapping depegs add up rather than compounding", () => {
  // Two actors each selling 40% of the pool have sold 80% of it, not 64%.
  const s = new EventSchedule([FIXED_DEPEG, FIXED_DEPEG], 1, 20);
  assert.ok(Math.abs(s.eusdDepegFractionAt(12) - 0.8) < 1e-9);
});

test("a depeg can be aligned with a crash, which is a different regime from either alone", () => {
  const s = new EventSchedule(
    [FIXED_CRASH, { ...FIXED_DEPEG, alignWith: "crash" }],
    7,
    40,
  );
  const crash = s.events[0];
  assert.equal(s.events[1].startBlock, crash.startBlock);
});

test("selling the pool's entire eUSD side is refused: it is an outage, not a discount", () => {
  assert.throws(
    () =>
      parseStressEvents(
        '[{"type":"eusdDepeg","magnitudeRange":[0.5,1.0],"windowFrac":[0.3,0.7],"rampBlocks":1,"holdBlocks":1,"decayBlocks":1}]',
      ),
    /magnitudeRange max must be < 1/,
  );
  // And it needs a window like every other state event.
  assert.throws(
    () =>
      parseStressEvents(
        '[{"type":"eusdDepeg","magnitudeRange":[0.3,0.5],"windowFrac":[0.3,0.7],"rampBlocks":0,"holdBlocks":0,"decayBlocks":0}]',
      ),
    /positive total window/,
  );
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
});

test("liquidityPull thins every enabled venue unless narrowed", () => {
  const all = new EventSchedule([FIXED_PULL], 1, 20);
  assert.deepEqual(all.liquidityPullVenues(["uniswap", "balancer", "curve"]), [
    "uniswap",
    "balancer",
    "curve",
  ]);
  // Thinning one book while the others keep block-0 depth only moves execution elsewhere, so the
  // default is everything and narrowing is explicit.
  const narrowed = new EventSchedule(
    [{ ...FIXED_PULL, venue: "curve" }],
    1,
    20,
  );
  assert.deepEqual(
    narrowed.liquidityPullVenues(["uniswap", "balancer", "curve"]),
    ["curve"],
  );
  // A venue the run did not enable is not invented.
  assert.deepEqual(narrowed.liquidityPullVenues(["uniswap", "balancer"]), []);
  assert.deepEqual(all.liquidityPullVenues(["uniswap"]), ["uniswap"]);
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

// ---------------------------------------------------------------------------
// Process events (issue #56): the two regimes that used to be run-wide settings, as windows.
//
// `cex-drift` and `informed-flow` could not be injected into a continuous economy at all -- a week
// cannot "be" a drifting week the way a 360-block scenario could. As events they compose with the
// rest, and a week can hold a drift episode, a flow episode and a depeg at once.
// ---------------------------------------------------------------------------

test("a cexDrift episode changes the walk, and leaves it alone outside its window", () => {
  const schedule = new EventSchedule(
    [
      {
        type: "cexDrift",
        magnitudeRange: [0.0015, 0.0015],
        kappaMultRange: [0.2, 0.2],
        side: "buy",
        windowFrac: [0.25, 0.25],
        rampBlocks: 4,
        holdBlocks: 10,
        decayBlocks: 6,
      },
    ],
    1,
    100,
  );
  const ev = schedule.events[0];
  // Identity before and after: a run with an episode still has an untouched price process outside
  // it, which is what keeps beta near zero away from the window (ADR 0007).
  assert.deepEqual(schedule.ouOverrideAt(ev.startBlock - 1), {
    driftAdd: 0,
    kappaMult: 1,
  });
  assert.deepEqual(schedule.ouOverrideAt(ev.endBlock), {
    driftAdd: 0,
    kappaMult: 1,
  });
  // At full strength the drift is the drawn magnitude and mean reversion is weakened to the drawn
  // multiplier -- both together, because a drift the OU pulls straight back out is not a drift.
  const peak = schedule.ouOverrideAt(ev.startBlock + ev.rampBlocks);
  assert.ok(Math.abs(peak.driftAdd - 0.0015) < 1e-12);
  assert.ok(Math.abs(peak.kappaMult - 0.2) < 1e-12);
  // Half way up the ramp both are partly applied, so the market's character does not switch on one
  // block.
  const ramping = schedule.ouOverrideAt(ev.startBlock + 1);
  assert.ok(ramping.driftAdd > 0 && ramping.driftAdd < 0.0015);
  assert.ok(ramping.kappaMult > 0.2 && ramping.kappaMult < 1);
});

test("a downward cexDrift is the same episode with the sign flipped", () => {
  const down = new EventSchedule(
    [
      {
        type: "cexDrift",
        magnitudeRange: [0.001, 0.001],
        side: "sell",
        windowFrac: [0.2, 0.2],
        rampBlocks: 0,
        holdBlocks: 10,
        decayBlocks: 0,
      },
    ],
    7,
    100,
  );
  const ev = down.events[0];
  assert.equal(ev.side, "sell");
  assert.ok(down.ouOverrideAt(ev.startBlock).driftAdd < 0);
});

test("withOuOverride leaves untouched parameters byte-identical", () => {
  const params = { volatility: 0.004, kappa: 0.02, drift: 0 };
  assert.equal(
    withOuOverride(params, { driftAdd: 0, kappaMult: 1 }),
    params,
    "no episode open must return the same object, not a copy",
  );
  const shifted = withOuOverride(params, { driftAdd: 0.001, kappaMult: 0.2 });
  assert.equal(shifted.volatility, 0.004, "volatility is not an episode's business");
  assert.ok(Math.abs(shifted.kappa - 0.004) < 1e-12);
  assert.ok(Math.abs(shifted.drift - 0.001) < 1e-12);
});

test("a flowTrend episode leans the uninformed flow while its window is open", () => {
  const schedule = new EventSchedule(
    [
      {
        type: "flowTrend",
        magnitudeRange: [3, 3],
        trendCorrelation: 1,
        persistBlocks: 12,
        windowFrac: [0.3, 0.3],
        rampBlocks: 5,
        holdBlocks: 20,
        decayBlocks: 5,
      },
    ],
    3,
    200,
  );
  const ev = schedule.events[0];
  assert.deepEqual(schedule.flowTrendAt(ev.startBlock - 1), { sizeMult: 1 });
  const peak = schedule.flowTrendAt(ev.startBlock + ev.rampBlocks);
  assert.ok(Math.abs(peak.sizeMult - 3) < 1e-12);
  // The shape knobs are not faded by the envelope: half a correlation during the ramp is a
  // different regime, not a weaker one.
  assert.equal(peak.trendCorrelation, 1);
  assert.equal(peak.persistBlocks, 12);
  const ramping = schedule.flowTrendAt(ev.startBlock);
  assert.ok(ramping.sizeMult > 1 && ramping.sizeMult < 3);
  assert.equal(ramping.trendCorrelation, 1);
});

test("process events do not disturb the price overlay or the point events", () => {
  // The kinds are consumed by different callers, and a type that lands in the wrong bucket silently
  // does nothing (the failure `pointEventsAt` shipped once).
  const schedule = new EventSchedule(
    [
      {
        type: "cexDrift",
        magnitudeRange: [0.001, 0.001],
        windowFrac: [0.2, 0.2],
        rampBlocks: 0,
        holdBlocks: 20,
        decayBlocks: 0,
      },
      {
        type: "flowTrend",
        magnitudeRange: [2, 2],
        windowFrac: [0.2, 0.2],
        rampBlocks: 0,
        holdBlocks: 20,
        decayBlocks: 0,
      },
    ],
    11,
    100,
  );
  const at = schedule.at(schedule.events[0].startBlock);
  assert.equal(at.wethMult, 1, "a process event is not a price multiplier");
  assert.equal(
    schedule.pointEventsAt(0, 99).length,
    0,
    "a process event is not executed once",
  );
});
