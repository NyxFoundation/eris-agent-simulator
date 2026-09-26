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

// Enough seeds that every outcome a small range allows shows up.
const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

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

test("with several anchors, each follower pairs with the one written just before it", () => {
  // A practice period schedules a crash + pull every week. Pairing every pull with the first crash
  // would stack all of them on week one and leave every later crash with a full book.
  const week1: [number, number] = [0.1, 0.4];
  const week2: [number, number] = [0.6, 0.9];
  const s = new EventSchedule(
    [
      { ...FIXED_CRASH, windowFrac: week1 },
      { ...FIXED_PULL, windowFrac: week1, alignWith: "crash" },
      { ...FIXED_CRASH, windowFrac: week2 },
      { ...FIXED_PULL, windowFrac: week2, alignWith: "crash" },
    ],
    11,
    1000,
  );
  assert.notEqual(s.events[0].startBlock, s.events[2].startBlock);
  assert.equal(s.events[1].startBlock, s.events[0].startBlock);
  assert.equal(s.events[3].startBlock, s.events[2].startBlock);
});

test("a follower written before its anchor still finds it", () => {
  // The single-anchor configs never depended on list order; that stays true.
  const s = new EventSchedule(
    [{ ...FIXED_PULL, alignWith: "crash" }, FIXED_CRASH],
    3,
    40,
  );
  assert.equal(s.events[0].startBlock, s.events[1].startBlock);
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

// ---------------------------------------------------------------------------
// Dislocations that do not close (issue #56)
//
// The competition's regime table calls the stablecoin regime a *non-mean-reverting* deviation, and
// the price regime a repricing. Neither was expressible: every window ended with the environment
// putting things back, so "will it come back?" always had the answer yes, and betting on it was a
// free option rather than a judgement.
// ---------------------------------------------------------------------------

test("a persistent depeg holds its level instead of decaying", () => {
  const schedule = new EventSchedule(
    [
      {
        type: "depeg",
        stable: "DAI",
        magnitudeRange: [0.5, 0.5],
        persist: true,
        windowFrac: [0.2, 0.2],
        rampBlocks: 5,
        holdBlocks: 10,
        decayBlocks: 0,
      },
    ],
    1,
    100,
  );
  const ev = schedule.events[0];
  assert.equal(ev.persist, true);
  assert.equal(schedule.depegFractionAt("DAI", ev.startBlock - 1), 0);
  // Full strength at the top of the ramp, and still there long after the trapezoid would have
  // finished -- the run ends with the peg broken.
  assert.ok(
    Math.abs(schedule.depegFractionAt("DAI", ev.startBlock + 5) - 0.5) < 1e-12,
  );
  assert.ok(Math.abs(schedule.depegFractionAt("DAI", 99) - 0.5) < 1e-12);
});

test("an ordinary depeg still closes, so the two are distinguishable", () => {
  const schedule = new EventSchedule(
    [
      {
        type: "depeg",
        stable: "DAI",
        magnitudeRange: [0.5, 0.5],
        windowFrac: [0.2, 0.2],
        rampBlocks: 5,
        holdBlocks: 10,
        decayBlocks: 5,
      },
    ],
    1,
    100,
  );
  assert.equal(schedule.depegFractionAt("DAI", 99), 0);
});

test("persist without decayBlocks: 0 is refused rather than ignored", () => {
  assert.throws(
    () =>
      parseStressEvents(
        JSON.stringify([
          {
            type: "depeg",
            stable: "DAI",
            magnitudeRange: [0.4, 0.4],
            persist: true,
            windowFrac: [0.2, 0.2],
            rampBlocks: 4,
            holdBlocks: 10,
            decayBlocks: 6,
          },
        ]),
      ),
    /persist requires decayBlocks: 0/,
  );
  assert.throws(
    () =>
      parseStressEvents(
        JSON.stringify([
          {
            type: "crash",
            magnitudeRange: [0.1, 0.1],
            persist: true,
            windowFrac: [0.2, 0.2],
            rampBlocks: 0,
            holdBlocks: 10,
            decayBlocks: 0,
          },
        ]),
      ),
    /persist only applies to types "depeg" and "eusdDepeg"/,
  );
});

test("a repricing cexDrift moves the anchor by exactly the drift it applied", () => {
  const schedule = new EventSchedule(
    [
      {
        type: "cexDrift",
        magnitudeRange: [0.002, 0.002],
        side: "buy",
        repriceAnchor: true,
        windowFrac: [0.2, 0.2],
        rampBlocks: 0,
        holdBlocks: 10,
        decayBlocks: 0,
      },
    ],
    5,
    100,
  );
  const ev = schedule.events[0];
  assert.equal(schedule.anchorMultiplierAt(ev.startBlock - 1), 1);
  // Ten blocks of hold at 0.2% each, compounded the same way the OU compounds its own step.
  const expected = 1.002 ** 10;
  assert.ok(Math.abs(schedule.anchorMultiplierAt(ev.endBlock - 1) - expected) < 1e-12);
  // And it stays there: the new level is what the walk now reverts to.
  assert.ok(Math.abs(schedule.anchorMultiplierAt(99) - expected) < 1e-12);
});

test("a cexDrift without repriceAnchor leaves the anchor alone", () => {
  const schedule = new EventSchedule(
    [
      {
        type: "cexDrift",
        magnitudeRange: [0.002, 0.002],
        windowFrac: [0.2, 0.2],
        rampBlocks: 0,
        holdBlocks: 10,
        decayBlocks: 0,
      },
    ],
    5,
    100,
  );
  assert.equal(schedule.anchorMultiplierAt(50), 1);
  assert.equal(schedule.anchorMultiplierAt(99), 1);
});

// Issue #105: the spike regime is crash's mirror -- the same trapezoid with the sign flipped and the
// liquidity pull aligned to it. Read off the committed YAML so a drift in the file is a failing test.
// Since the variation keys, "the same" is a distribution: 1-2 gaps, drawn trapezoids, a quarter of
// them going down, and 40-100% of each one recovering.
test("config/regimes/spike.yaml: upward gaps with the pull on the same windows", async () => {
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("yaml");
  const doc = parse(readFileSync("config/regimes/spike.yaml", "utf8")) as {
    run: { blocks: number };
    stress: { events: unknown[] };
  };
  const configs = parseStressEvents(JSON.stringify(doc.stress.events));
  assert.deepEqual(
    configs.map((c) => c.type),
    ["spike", "liquidityPull"],
  );
  assert.equal(configs[1].alignWith, "spike");
  // The crash regime is the same file with the sign flipped.
  const crash = parseStressEvents(
    JSON.stringify((parse(readFileSync("config/regimes/crash.yaml", "utf8")) as { stress: { events: unknown[] } }).stress.events),
  );
  assert.deepEqual(crash.map((c) => ({ ...c, type: "x", alignWith: undefined })), configs.map((c) => ({ ...c, type: "x", alignWith: undefined })));
  let up = 0;
  let gaps = 0;
  const counts = new Set<number>();
  for (const seed of SEEDS) {
    const s = new EventSchedule(configs, seed, doc.run.blocks);
    const shocks = s.events.filter((e) => e.type === "spike" || e.type === "crash");
    const pulls = s.events.filter((e) => e.type === "liquidityPull");
    counts.add(shocks.length);
    assert.equal(pulls.length, shocks.length);
    let residual = 1;
    for (const [k, g] of shocks.entries()) {
      gaps++;
      if (g.type === "spike") up++;
      else assert.equal(g.flippedFrom, "spike");
      assert.equal(pulls[k].startBlock, g.startBlock, "the pull opens on the gap's block");
      const frac = g.startBlock / doc.run.blocks;
      assert.ok(frac >= 0.25 && frac <= 0.7, `window frac ${frac} inside [0.25, 0.7]`);
      assert.ok(g.magnitude >= 0.15 && g.magnitude <= 0.22);
      assert.ok(g.recoverFrac! >= 0.4 && g.recoverFrac! <= 1);
      if (k > 0) assert.ok(g.startBlock >= pulls[k - 1].endBlock + 20, "the next gap waits out the last pull");
      residual *= 1 + (g.type === "spike" ? 1 : -1) * g.magnitude * (1 - g.recoverFrac!);
    }
    // What did not recover is still there on the last block.
    assert.ok(Math.abs(s.at(doc.run.blocks - 1).wethMult - residual) < 1e-9, `seed ${seed}`);
  }
  assert.deepEqual([...counts].sort(), [1, 2]);
  assert.ok(up / gaps > 0.65 && up / gaps < 0.85, `${up}/${gaps} went up`);
});

// Issue #106: depeg-persist is depeg.yaml with `persist: true` -- the dislocation ramps, holds, and
// then never closes: the state target stays at full magnitude from the end of the hold to the last
// block, and the file has to say decayBlocks: 0 or the parser refuses it.
test("config/regimes/depeg-persist.yaml: the DAI discount holds to the end of the run", async () => {
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("yaml");
  const doc = parse(readFileSync("config/regimes/depeg-persist.yaml", "utf8")) as {
    run: { blocks: number };
    stress: { events: unknown[] };
  };
  const configs = parseStressEvents(JSON.stringify(doc.stress.events));
  assert.equal(configs.length, 1);
  assert.equal(configs[0].type, "depeg");
  assert.equal(configs[0].stable, "DAI");
  assert.equal(configs[0].persist, true);
  assert.equal(configs[0].decayBlocks, 0);
  const s = new EventSchedule(configs, 101, doc.run.blocks);
  const ev = s.events[0];
  const frac = ev.startBlock / doc.run.blocks;
  assert.ok(frac >= 0.25 && frac <= 0.6, `window frac ${frac} inside [0.25, 0.6]`);
  assert.equal(ev.endBlock, ev.startBlock + ev.rampBlocks + ev.holdBlocks);
  // The sold fraction: 0 before, ramping, the full magnitude through the hold, and -- the point --
  // still the full magnitude at endBlock and on the run's last block.
  const m = ev.magnitude;
  assert.equal(s.depegFractionAt("DAI", ev.startBlock - 1), 0);
  assert.ok(Math.abs(s.depegFractionAt("DAI", ev.startBlock + ev.rampBlocks) - m) < 1e-12);
  assert.ok(Math.abs(s.depegFractionAt("DAI", ev.endBlock) - m) < 1e-12);
  assert.ok(Math.abs(s.depegFractionAt("DAI", doc.run.blocks - 1) - m) < 1e-12);
  // depeg.yaml's own shape, for contrast: its fraction is back to 0 once the window has closed.
  const closing = new EventSchedule(
    parseStressEvents(JSON.stringify((parse(readFileSync("config/regimes/depeg.yaml", "utf8")) as { stress: { events: unknown[] } }).stress.events)),
    101,
    doc.run.blocks,
  );
  assert.equal(closing.depegFractionAt("DAI", closing.events[0].endBlock), 0);
  // And the same ranges with a decay are what depeg.yaml declares: only the closing differs.
  const base = parse(readFileSync("config/regimes/depeg.yaml", "utf8")) as { stress: { events: Array<Record<string, unknown>> } };
  const b = base.stress.events[0];
  for (const k of ["magnitudeRange", "windowFrac", "rampBlocks", "holdBlocks"] as const)
    assert.deepEqual((doc.stress.events[0] as Record<string, unknown>)[k], b[k], k);
});

// Issue #107: cdp-incident puts the crash, the pull and the eUSD depeg on one window, over Liquity
// victims opened at ICR 1.20. Read off the committed YAML.
test("config/regimes/cdp-incident.yaml: crash, pull and eUSD depeg on one window over Liquity victims", async () => {
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("yaml");
  const doc = parse(readFileSync("config/regimes/cdp-incident.yaml", "utf8")) as {
    run: { blocks: number; protocols: string[] };
    stress: { events: unknown[]; liquityVictimCount: number; liquityVictimIcr: number; victimCount?: number };
  };
  assert.ok(doc.run.protocols.includes("liquity"));
  assert.equal(doc.stress.liquityVictimCount, 2);
  assert.equal(doc.stress.liquityVictimIcr, 1.2);
  assert.equal(doc.stress.victimCount, undefined, "no Aave cohort: that is lending-incident's axis");
  const configs = parseStressEvents(JSON.stringify(doc.stress.events));
  assert.deepEqual(configs.map((c) => c.type), ["crash", "liquidityPull", "eusdDepeg"]);
  assert.equal(configs[1].alignWith, "crash");
  assert.equal(configs[2].alignWith, "crash");
  // Every drawn crash breaches a 1.20 Trove: the magnitude floor is above 1 − 1.10/1.20.
  assert.ok(configs[0].magnitudeRange[0] > 1 - 1.1 / 1.2);
  const s = new EventSchedule(configs, 101, doc.run.blocks);
  const [crash, pull, depeg] = s.events;
  assert.equal(pull.startBlock, crash.startBlock);
  assert.equal(depeg.startBlock, crash.startBlock);
  const frac = crash.startBlock / doc.run.blocks;
  assert.ok(frac >= 0.3 && frac <= 0.7, `window frac ${frac}`);
  assert.ok(s.hasEusdDepeg());
  assert.ok(s.eusdDepegFractionAt(depeg.startBlock + depeg.rampBlocks) > 0);
});

// ---- variation: count / drawn trapezoids / flipProb / recoverFrac / random venue ----
// The regime YAMLs used to fix everything but magnitude and start: how many windows, which band
// each one sat in, how long its ramp/hold/decay ran, which way a crash went and that it always
// healed. These pin the knobs that let the seed decide those as well.

test("count opens a drawn number of windows that never overlap and all start inside windowFrac", () => {
  const cfg: StressEventConfig = {
    type: "crash",
    count: [2, 4],
    minGapBlocks: 5,
    magnitudeRange: [0.1, 0.2],
    windowFrac: [0.1, 0.8],
    rampBlocks: [2, 4],
    holdBlocks: [3, 6],
    decayBlocks: [4, 8],
  };
  const seen = new Set<number>();
  for (const seed of SEEDS) {
    const s = new EventSchedule([cfg], seed, 360);
    const evs = s.events;
    seen.add(evs.length);
    assert.ok(evs.length >= 2 && evs.length <= 4, `count ${evs.length}`);
    for (const [k, ev] of evs.entries()) {
      assert.ok(ev.startBlock >= Math.round(0.1 * 360) && ev.startBlock <= Math.round(0.8 * 360), `start ${ev.startBlock}`);
      assert.ok(ev.rampBlocks >= 2 && ev.rampBlocks <= 4);
      assert.ok(ev.holdBlocks >= 3 && ev.holdBlocks <= 6);
      assert.ok(ev.decayBlocks >= 4 && ev.decayBlocks <= 8);
      assert.equal(ev.endBlock, ev.startBlock + ev.rampBlocks + ev.holdBlocks + ev.decayBlocks);
      if (k > 0) assert.ok(ev.startBlock >= evs[k - 1].endBlock + 5, `seed ${seed}: window ${k} overlaps`);
    }
    assert.deepEqual(new EventSchedule([cfg], seed, 360).events, evs, "same seed, same schedule");
  }
  assert.deepEqual([...seen].sort(), [2, 3, 4], "every count in the range occurs");
});

test("count: [0, 1] is an entry that may not happen at all", () => {
  const cfg: StressEventConfig = { ...FIXED_CRASH, count: [0, 1], windowFrac: [0.2, 0.6] };
  const lengths = new Set(SEEDS.map((seed) => new EventSchedule([cfg], seed, 60).events.length));
  assert.deepEqual([...lengths].sort(), [0, 1]);
});

test("a follower pairs with its anchor window by window, and the pair's longer member sets the spacing", () => {
  const configs: StressEventConfig[] = [
    { ...FIXED_CRASH, count: [1, 3], windowFrac: [0.1, 0.8] },
    // The pull outlasts the crash (span 14 against 6): the next crash must not open inside it.
    { ...FIXED_PULL, alignWith: "crash", decayBlocks: [8, 10] },
  ];
  for (const seed of SEEDS) {
    const s = new EventSchedule(configs, seed, 200);
    const crashes = s.events.filter((e) => e.type === "crash");
    const pulls = s.events.filter((e) => e.type === "liquidityPull");
    assert.equal(pulls.length, crashes.length);
    for (const [k, c] of crashes.entries()) {
      assert.equal(pulls[k].startBlock, c.startBlock);
      if (k > 0) assert.ok(c.startBlock >= pulls[k - 1].endBlock, `seed ${seed}: crash ${k} opens inside pull ${k - 1}`);
    }
  }
  assert.throws(
    () => new EventSchedule([FIXED_CRASH, { ...FIXED_PULL, alignWith: "crash", count: [1, 2] }], 1, 60),
    /a follower takes its anchor's count/,
  );
});

test("a count that cannot fit is refused for every seed, not only the unlucky ones", () => {
  // Four 6-block windows need 18 blocks of start range between the first start and the last.
  assert.throws(
    () => new EventSchedule([{ ...FIXED_CRASH, count: [1, 4], windowFrac: [0.4, 0.5] }], 1, 100),
    /4 windows of up to 6 blocks \(\+0 gap\) do not fit between the starts windowFrac allows/,
  );
  // Fits the start range, not the run: the last window has nowhere to end.
  assert.throws(
    () => new EventSchedule([{ ...FIXED_CRASH, count: [3, 3], windowFrac: [0, 1] }], 1, 16),
    /do not fit in a 16-block run/,
  );
});

test("flipProb turns a shock the other way and records what it was", () => {
  const never = new EventSchedule([{ ...FIXED_CRASH, flipProb: 0 }], 1, 20).events[0];
  assert.equal(never.type, "crash");
  assert.equal(never.flippedFrom, undefined);
  const always = new EventSchedule([{ ...FIXED_CRASH, flipProb: 1 }], 1, 20);
  assert.equal(always.events[0].type, "spike");
  assert.equal(always.events[0].flippedFrom, "crash");
  assert.ok(Math.abs(always.at(12).wethMult - 1.1) < 1e-9, "a flipped crash moves the price up");
  // A quarter of the draws, give or take.
  const flipped = SEEDS.filter(
    (seed) => new EventSchedule([{ ...FIXED_CRASH, flipProb: 0.25 }], seed, 20).events[0].type === "spike",
  ).length;
  assert.ok(flipped > 25 && flipped < 75, `${flipped}/200 flipped`);
  // The pull still pairs with a crash that went up: alignment reads the configured type.
  const s = new EventSchedule([{ ...FIXED_CRASH, flipProb: 1 }, { ...FIXED_PULL, alignWith: "crash" }], 1, 20);
  assert.equal(s.events[1].startBlock, s.events[0].startBlock);
});

test("recoverFrac closes only part of the gap and leaves the rest to the end of the run", () => {
  const cfg: StressEventConfig = { ...FIXED_CRASH, recoverFrac: [0.6, 0.6] };
  const s = new EventSchedule([cfg], 1, 40);
  const ev = s.events[0];
  assert.equal(ev.recoverFrac, 0.6);
  // Same ramp and hold as ever.
  assert.ok(Math.abs(s.at(ev.startBlock + ev.rampBlocks).wethMult - 0.9) < 1e-9);
  // The decay lands on 1 − m·(1 − r) = 1 − 0.1·0.4 and stays there.
  assert.ok(Math.abs(s.at(ev.endBlock - 1).wethMult - 0.96) < 1e-9, `${s.at(ev.endBlock - 1).wethMult}`);
  assert.ok(Math.abs(s.at(ev.endBlock).wethMult - 0.96) < 1e-9);
  assert.ok(Math.abs(s.at(39).wethMult - 0.96) < 1e-9);
  // The window itself still closes: nothing that means "is a shock happening now" sees a residual.
  assert.equal(s.activeEventAt(ev.endBlock), null);
  assert.equal(s.activePriceEventAt(ev.endBlock), null);
  // A full recovery is the old trapezoid exactly.
  const full = new EventSchedule([{ ...FIXED_CRASH, recoverFrac: [1, 1] }], 1, 40);
  const plain = new EventSchedule([FIXED_CRASH], 1, 40);
  for (let t = 0; t < 40; t++) assert.equal(full.at(t).wethMult, plain.at(t).wethMult, `t=${t}`);
});

test("a residual that stays is not reported as further applications", async () => {
  const { StressAudit } = await import("../core/src/realtime/stressAudit.js");
  const s = new EventSchedule([{ ...FIXED_CRASH, recoverFrac: [0.5, 0.5] }], 1, 40);
  const ev = s.events[0];
  const audit = new StressAudit(s.events, () => {});
  for (let t = 0; t < 40; t++)
    audit.price("WETH", t, 1000 + t, { before: 3000, unoverlaid: 3000, fair: 3000 * s.at(t).wethMult }, { stage: "price_submitted" });
  const [summary] = audit.summaries();
  assert.equal(summary.applications, ev.endBlock - ev.startBlock);
  assert.equal(summary.lastBlock, 1000 + ev.endBlock - 1);
});

test("venue: random spreads a whale over all three books", () => {
  const venues = new Set(
    SEEDS.map(
      (seed) =>
        new EventSchedule([{ type: "whale", venue: "random", magnitudeRange: [30, 30], windowFrac: [0.5, 0.5], rampBlocks: 0, holdBlocks: 0, decayBlocks: 0 }], seed, 100).events[0].venue,
    ),
  );
  assert.deepEqual([...venues].sort(), ["balancer", "curve", "uniswap"]);
});

test("repriceAnchorProb decides per window whether the drift stays", () => {
  const cfg: StressEventConfig = {
    type: "cexDrift",
    count: [3, 3],
    repriceAnchorProb: 0.5,
    magnitudeRange: [0.001, 0.001],
    windowFrac: [0.1, 0.8],
    rampBlocks: 2,
    holdBlocks: 4,
    decayBlocks: 2,
  };
  const perSchedule = SEEDS.map((seed) => new EventSchedule([cfg], seed, 200).events.filter((e) => e.repriceAnchor).length);
  assert.ok(perSchedule.includes(0) && perSchedule.includes(3), "some weeks never reprice, some always");
});

test("the new keys are refused where they do not apply", () => {
  const one = (extra: Record<string, unknown>, type = "crash") =>
    parseStressEvents(JSON.stringify([{ type, magnitudeRange: [0.1, 0.2], windowFrac: [0.3, 0.7], rampBlocks: 1, holdBlocks: 1, decayBlocks: 1, ...extra }]));
  assert.throws(() => one({ flipProb: 0.2 }, "liquidityPull"), /flipProb only applies/);
  assert.throws(() => one({ flipProb: 1.5 }), /probability between 0 and 1/);
  assert.throws(() => one({ recoverFrac: [0.5, 1] }, "depeg"), /stable is required|recoverFrac only applies/);
  assert.throws(() => one({ recoverFrac: [0.5, 1.2] }), /recoverFrac max must be <= 1/);
  assert.throws(() => one({ venue: "random" }, "liquidityPull"), /"random" only applies to type "whale"/);
  assert.throws(() => one({ repriceAnchorProb: 0.3 }), /repriceAnchorProb only applies/);
  assert.throws(() => one({ repriceAnchorProb: 0.3, repriceAnchor: true }, "cexDrift"), /pick one/);
  assert.throws(() => one({ count: [1.5, 2] }), /count must be an integer range/);
  assert.throws(() => one({ count: [1, 2], alignWith: "spike" }), /a follower takes its anchor's count/);
  assert.throws(() => one({ minGapBlocks: 4 }), /minGapBlocks only applies with count/);
  assert.throws(() => one({ rampBlocks: [3, 1] }), /min <= max/);
  assert.throws(() => one({ rampBlocks: [0, 1], holdBlocks: 0, decayBlocks: [0, 2] }), /positive total window/);
  const parsed = one({ count: [1, 3], minGapBlocks: 4, rampBlocks: [1, 3], flipProb: 0.25, recoverFrac: [0.4, 1] })[0];
  assert.deepEqual(parsed.count, [1, 3]);
  assert.deepEqual(parsed.rampBlocks, [1, 3]);
  assert.equal(parsed.flipProb, 0.25);
});

// The LCG's first output moves by a·Δ/2³² between seeds Δ apart. On the published seeds 101-505
// that put the first event's magnitude in the bottom quarter of its range five times out of five.
test("with variation keys, nearby seeds spread the first draw over its whole range", () => {
  const cfg: StressEventConfig = {
    type: "crash",
    magnitudeRange: [0, 1],
    windowFrac: [0.25, 0.7],
    rampBlocks: [2, 4],
    holdBlocks: 6,
    decayBlocks: 8,
  };
  const u = [101, 202, 303, 404, 505, ...SEEDS].map((seed) => new EventSchedule([cfg], seed, 360).events[0].magnitude);
  assert.ok(Math.min(...u) < 0.1 && Math.max(...u) > 0.9, `range ${Math.min(...u)}-${Math.max(...u)}`);
  const pub = u.slice(0, 5);
  assert.ok(Math.max(...pub) - Math.min(...pub) > 0.3, `published seeds ${pub.map((x) => x.toFixed(2)).join(" ")}`);
});

test("a schedule without variation keys is the one it always was", () => {
  // Pinned from the implementation before the keys existed: the practice period's windows are a
  // function of its seed, and must not move on an upgrade.
  const cfg: StressEventConfig = { type: "crash", magnitudeRange: [0.15, 0.22], windowFrac: [0.25, 0.7], rampBlocks: 3, holdBlocks: 6, decayBlocks: 8 };
  const a = new EventSchedule([cfg], 101, 360).events[0];
  assert.equal(a.startBlock, 159);
  assert.equal(a.magnitude, 0.15649268912849948);
  const b = new EventSchedule([cfg], 202, 360).events[0];
  assert.equal(b.startBlock, 156);
  assert.equal(b.magnitude, 0.15917842744849622);
});
