// Whale point stress event (ADR 0017 regime 3).
//
// The schedule half (placement, side resolution, determinism from the seed) and the order half
// (what actually gets submitted) are both pure, so both are pinned here. The thing most worth
// pinning is that a whale is a *point* event: if it were treated as a trapezoid it would silently
// become a multi-block price overlay, which is the crash regime, not this one.
import test from "node:test";
import assert from "node:assert/strict";
import {
  EventSchedule,
  parseStressEvents,
} from "../core/src/realtime/events.js";
import { buildWhaleOrder, whaleFunding } from "../core/src/realtime/whale.js";

const WHALE = {
  type: "whale" as const,
  magnitudeRange: [30, 60] as [number, number],
  windowFrac: [0.3, 0.7] as [number, number],
  rampBlocks: 0,
  holdBlocks: 0,
  decayBlocks: 0,
};

test("a whale occupies a single block and never touches the price overlay", () => {
  const schedule = new EventSchedule([WHALE], 42, 100);
  const [ev] = schedule.events;
  assert.equal(ev.endBlock, ev.startBlock + 1);
  // Unlike crash, fair price is untouched: the dislocation is the pool moving away from an
  // unchanged fair, which is the whole point of the regime.
  for (let i = 0; i < 100; i++) assert.equal(schedule.at(i).wethMult, 1);
  // It is delivered as a point event instead.
  assert.deepEqual(schedule.pointEventsAt(ev.startBlock), [ev]);
  assert.deepEqual(schedule.pointEventsAt(ev.startBlock + 1), []);
});

test("the same seed resolves the same whale, a different seed can move it", () => {
  const a = new EventSchedule([WHALE], 42, 100).events[0];
  const b = new EventSchedule([WHALE], 42, 100).events[0];
  assert.deepEqual(a, b);

  const differs = [1, 2, 3, 4, 5, 6, 7, 8].some((seed) => {
    const e = new EventSchedule([WHALE], seed, 100).events[0];
    return e.startBlock !== a.startBlock || e.magnitude !== a.magnitude;
  });
  assert.ok(
    differs,
    "no seed changed the whale (the range is not being sampled)",
  );
});

test("side defaults to seed-chosen and both sides occur across seeds", () => {
  const sides = new Set(
    Array.from(
      { length: 24 },
      (_, seed) => new EventSchedule([WHALE], seed, 100).events[0].side,
    ),
  );
  assert.deepEqual([...sides].sort(), ["buy", "sell"]);
});

test("an explicit side pins the direction without moving the schedule", () => {
  // The side draw is taken unconditionally so that pinning it cannot shift the placement of this
  // event or of any event after it in the list.
  const free = new EventSchedule([WHALE], 7, 100).events[0];
  const pinned = new EventSchedule([{ ...WHALE, side: "buy" }], 7, 100)
    .events[0];
  assert.equal(pinned.side, "buy");
  assert.equal(pinned.startBlock, free.startBlock);
  assert.equal(pinned.magnitude, free.magnitude);
});

test("a sell spends the base and a buy spends USDC, at the venue asked for", () => {
  const base = {
    ...new EventSchedule([WHALE], 42, 100).events[0],
    magnitude: 40,
  };

  const sell = buildWhaleOrder({ ...base, side: "sell" }, 2000, 1n);
  assert.equal(sell.protocol, "uniswap");
  assert.equal(sell.walletKey, "whale:uninformed");
  const sellAction = sell.action as unknown as Record<string, string>;
  assert.equal(sellAction.type, "swap");
  assert.equal(sellAction.tokenIn, "WETH");
  assert.equal(sellAction.amountIn, (40n * 10n ** 18n).toString());

  const buy = buildWhaleOrder(
    { ...base, side: "buy", venue: "curve" },
    2000,
    1n,
  );
  const buyAction = buy.action as unknown as Record<string, string>;
  assert.equal(buy.protocol, "curve");
  assert.equal(buyAction.type, "curveSwap");
  assert.equal(buyAction.tokenIn, "USDC");
  // 40 WETH at 2000 = 80,000 USDC (6 decimals)
  assert.equal(buyAction.amountIn, (80_000n * 10n ** 6n).toString());
});

test("a whale accepts any fill: capping slippage would cap the event itself", () => {
  const ev = new EventSchedule([WHALE], 42, 100).events[0];
  const action = buildWhaleOrder(ev, 2000, 1n).action as unknown as Record<
    string,
    string
  >;
  assert.equal(action.minAmountOut, "0");
});

test("funding covers the largest scheduled order on both sides with headroom", () => {
  const events = [
    { ...new EventSchedule([WHALE], 42, 100).events[0], magnitude: 10 },
    { ...new EventSchedule([WHALE], 42, 100).events[0], magnitude: 50 },
  ];
  const funding = whaleFunding(events, 2000);
  // Sized on the largest (50), not the first or the sum, and with headroom: a swap quotes at the
  // pool price, not at fair, so funding the exact notional makes the biggest whale of a run fail.
  assert.ok(funding.baseWei > 50n * 10n ** 18n, `baseWei=${funding.baseWei}`);
  assert.ok(
    funding.usdcUnits > 100_000n * 10n ** 6n,
    `usdcUnits=${funding.usdcUnits}`,
  );
});

test("no whale in the schedule means no endowment", () => {
  assert.deepEqual(whaleFunding([], 2000), { baseWei: 0n, usdcUnits: 0n });
});

test("side/venue are rejected on event types they do not apply to", () => {
  const crash = {
    type: "crash",
    magnitudeRange: [0.1, 0.2],
    windowFrac: [0.3, 0.7],
    rampBlocks: 3,
    holdBlocks: 6,
    decayBlocks: 8,
  };
  assert.throws(
    () => parseStressEvents(JSON.stringify([{ ...crash, side: "buy" }])),
    /side only applies to type "whale"/,
  );
  assert.throws(
    () => parseStressEvents(JSON.stringify([{ ...crash, venue: "curve" }])),
    /venue only applies to type "whale"/,
  );
  assert.throws(
    () => parseStressEvents(JSON.stringify([{ ...WHALE, side: "sideways" }])),
    /side must be/,
  );
});

test("a whale needs no trapezoid fields", () => {
  const [parsed] = parseStressEvents(
    JSON.stringify([
      { type: "whale", magnitudeRange: [30, 60], windowFrac: [0.3, 0.7] },
    ]),
  );
  assert.equal(parsed.type, "whale");
  assert.equal(parsed.rampBlocks, 0);
});
