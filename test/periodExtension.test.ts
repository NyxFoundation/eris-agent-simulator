// Extending a running practice period (core/src/realtime/periodResume.ts "extending a period"):
// what a resume accepts, that the windows already placed do not move, and the episodes the
// generator appends for the added days.
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkPeriodExtension,
  extendedScheduleProblems,
} from "../core/src/realtime/periodResume.js";
import { EventSchedule, parseStressEvents } from "../core/src/realtime/events.js";
import {
  appendStressEvents,
  dailyEpisodePlan,
  EDGE_MARGIN_HOURS,
  extensionEpisodePlan,
  KINDS_PER_DAY,
  MIN_SLICE_HOURS,
  renderEventLines,
} from "../core/src/practiceEpisodes.js";

const HOUR = 3_600_000;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

// A two-day period at 2 s blocks: 86,400 blocks, its episodes generated the way the period's were.
const RUN_BLOCKS = 86_400;
const savedEvents = dailyEpisodePlan(48).flatMap((d) => d.events);

function world(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seed: 7,
    runEndsAt: "2026-10-31T14:59:59.000Z",
    stressEvents: plain(savedEvents),
    ...over,
  };
}

test("an unchanged world is the same period, not an extension", () => {
  assert.deepEqual(checkPeriodExtension(world(), world(), RUN_BLOCKS), {
    kind: "same",
  });
});

test("a later end with episodes appended and the base held is an extension", () => {
  const appended = [...plain(savedEvents), { type: "crash", windowFrac: [1.1, 1.2] }];
  const check = checkPeriodExtension(
    world(),
    world({
      runEndsAt: "2026-11-30T14:59:59.000Z",
      stressEvents: appended,
      stressWindowBaseBlocks: RUN_BLOCKS,
    }),
    RUN_BLOCKS,
  );
  assert.equal(check.kind, "extend");
  if (check.kind !== "extend") return;
  assert.equal(check.savedEvents, savedEvents.length);
  assert.equal(check.appendedEvents, 1);
  assert.equal(check.windowBase, RUN_BLOCKS);
});

test("a second extension keeps the base the first one set", () => {
  const first = world({
    runEndsAt: "2026-11-30T14:59:59.000Z",
    stressWindowBaseBlocks: RUN_BLOCKS,
  });
  // The checkpoint's run is longer by now; the base is still the original length.
  const check = checkPeriodExtension(
    first,
    { ...first, runEndsAt: "2026-12-15T14:59:59.000Z" },
    RUN_BLOCKS * 3,
  );
  assert.equal(check.kind, "extend");
});

test("what an extension refuses: an earlier end, an edited episode, a moved base, anything else", () => {
  const later = "2026-11-30T14:59:59.000Z";
  const refused = (now: Record<string, unknown>) => {
    const check = checkPeriodExtension(world(), now, RUN_BLOCKS);
    assert.equal(check.kind, "refused", JSON.stringify(check));
    return check.kind === "refused" ? check.diff.join("\n") : "";
  };
  assert.match(
    refused(world({ runEndsAt: "2026-10-30T14:59:59.000Z", stressWindowBaseBlocks: RUN_BLOCKS })),
    /extended, not shortened/,
  );
  const edited = plain(savedEvents);
  edited[3].magnitudeRange = [0.5, 0.6];
  assert.match(
    refused(world({ runEndsAt: later, stressEvents: edited, stressWindowBaseBlocks: RUN_BLOCKS })),
    /stress\.events\[3\] was changed/,
  );
  assert.match(
    refused(world({ runEndsAt: later, stressEvents: plain(savedEvents).slice(1), stressWindowBaseBlocks: RUN_BLOCKS })),
    /stress\.events\[0\]/,
  );
  // No base: the run grows, so every fraction would land on a later block.
  assert.match(refused(world({ runEndsAt: later })), /has to be 86400/);
  // Another key changes alongside: still the ordinary refusal, naming it.
  assert.match(
    refused(world({ runEndsAt: later, stressWindowBaseBlocks: RUN_BLOCKS, seed: 8 })),
    /seed: 7 -> 8/,
  );
});

test("with the base held, the saved windows resolve to the same blocks in the extended run", () => {
  // The templates use variation keys (flipProb, recoverFrac), so the period runs on the seed-only
  // stream (stress.saltWithEventList: false); with the list in the salt, appending would redraw it all.
  const SEED_ONLY = { saltWithEventList: false };
  const configs = parseStressEvents(JSON.stringify(savedEvents));
  const before = new EventSchedule(configs, 7, RUN_BLOCKS, RUN_BLOCKS, SEED_ONLY);
  // Thirty more days, their episodes placed past the old end.
  const extendedBlocks = RUN_BLOCKS + 30 * 43_200;
  const appended = extensionEpisodePlan(
    {
      runStartBlock: 0,
      windowBaseBlocks: RUN_BLOCKS,
      endBlock: RUN_BLOCKS,
      atBlock: RUN_BLOCKS - 10_000,
      atMs: 0,
      startedAtMs: -(RUN_BLOCKS - 10_000) * 2000,
      blockTimeSec: 2,
    },
    30 * 24 * HOUR + 10_000 * 2000,
  ).flatMap((d) => d.events);
  const all = parseStressEvents(JSON.stringify([...savedEvents, ...appended]), {
    windowFracBeyondRun: true,
  });
  const after = new EventSchedule(all, 7, extendedBlocks, RUN_BLOCKS, SEED_ONLY);
  assert.deepEqual(
    plain(after.events.slice(0, before.events.length)),
    plain(before.events),
  );
  assert.deepEqual(extendedScheduleProblems(before.events, after.events, RUN_BLOCKS), []);
  // Placed against the old base, the extended run's windows would all have moved.
  const moved = new EventSchedule(configs, 7, extendedBlocks);
  assert.notDeepEqual(plain(moved.events), plain(before.events));
});

test("extendedScheduleProblems: a moved saved window, and an appended one in the past", () => {
  const w = (type: string, startBlock: number) => ({ type, startBlock });
  assert.match(
    extendedScheduleProblems([w("crash", 100)], [w("crash", 101)], 0).join(),
    /window 0 \(crash at run block 100\) resolves differently/,
  );
  assert.match(
    extendedScheduleProblems([w("crash", 100)], [w("crash", 100), w("spike", 150)], 200).join(),
    /appended window 1 \(spike\) starts at run block 150/,
  );
  assert.deepEqual(
    extendedScheduleProblems([w("crash", 100)], [w("crash", 100), w("spike", 250)], 200),
    [],
  );
});

test("a windowFrac above 1 is refused unless the config names a base, and then the schedule bounds it", () => {
  const above = JSON.stringify([
    { type: "crash", magnitudeRange: [0.1, 0.1], windowFrac: [1.2, 1.3], rampBlocks: 1, holdBlocks: 1, decayBlocks: 1 },
  ]);
  assert.throws(() => parseStressEvents(above), /windowFrac/);
  const configs = parseStressEvents(above, { windowFracBeyondRun: true });
  assert.doesNotThrow(() => new EventSchedule(configs, 1, 2_000, 1_000));
  assert.throws(() => new EventSchedule(configs, 1, 1_200, 1_000), /starts past the run/);
  assert.throws(() => new EventSchedule(configs, 1, 1_000, 2_000), /no longer than the run/);
});

test("the appended days follow the day grid from where the saved episodes end, placed from the anchor", () => {
  // The chain is 3 days behind the wall clock: the saved episodes end at a block the clock
  // reaches 3 days after the date they were written for.
  const startedAtMs = Date.parse("2026-10-08T12:41:21.980Z");
  const pos = {
    runStartBlock: 1_413,
    windowBaseBlocks: 997_770,
    endBlock: 1_413 + 997_770,
    atBlock: 716_418,
    atMs: Date.parse("2026-10-27T17:00:00Z"),
    startedAtMs,
    blockTimeSec: 2,
  };
  const endsAtMs = Date.parse("2026-11-30T14:59:59Z");
  const plan = extensionEpisodePlan(pos, endsAtMs);
  const oldEndMs = pos.atMs + (pos.endBlock - pos.atBlock) * 2000;
  assert.ok(plan.length >= 26 && plan.length <= 28, `${plan.length} days`);
  for (const d of plan) {
    assert.equal(d.events.length, KINDS_PER_DAY);
    const sliceStart = startedAtMs + d.day * 24 * HOUR;
    for (const e of d.events) {
      const [lo, hi] = e.windowFrac as [number, number];
      assert.ok(lo > 1 && hi > lo, `day ${d.day}: ${lo}-${hi}`);
      // Back to wall-clock time: inside the slice, clear of its edges, after the old end.
      const toMs = (f: number) => pos.atMs + (pos.runStartBlock + f * pos.windowBaseBlocks - pos.atBlock) * 2000;
      assert.ok(toMs(lo) >= Math.max(sliceStart, oldEndMs) + EDGE_MARGIN_HOURS * HOUR - 2000);
      assert.ok(toMs(hi) <= Math.min(sliceStart + 24 * HOUR, endsAtMs) - EDGE_MARGIN_HOURS * HOUR + 2000);
    }
  }
  // Consecutive grid days; the first starts where the saved episodes end, and only a tail shorter
  // than MIN_SLICE_HOURS (here 12:41Z to 14:59Z on 11/30) is left without episodes.
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i].day, plan[i - 1].day + 1);
  assert.ok(Math.abs(startedAtMs + plan[0].fromHours * HOUR - oldEndMs) < 1000);
  assert.ok(endsAtMs - (startedAtMs + plan.at(-1)!.toHours * HOUR) < MIN_SLICE_HOURS * HOUR);
});

test("appendStressEvents keeps every line and sets the base once", () => {
  const text = [
    "run:",
    "  endsAt: x",
    "stress:",
    "  events:",
    "    # day 1",
    "    - { type: crash }",
    "agents:",
    "  - id: noop",
  ].join("\n");
  const once = appendStressEvents(text, ["    # appended", "    - { type: spike }"], 42);
  assert.equal(
    once,
    [
      "run:",
      "  endsAt: x",
      "stress:",
      "  windowBaseBlocks: 42",
      "  events:",
      "    # day 1",
      "    - { type: crash }",
      "    # appended",
      "    - { type: spike }",
      "agents:",
      "  - id: noop",
    ].join("\n"),
  );
  const twice = appendStressEvents(once, renderEventLines([], ["more"]), 42);
  assert.equal(twice.match(/windowBaseBlocks/g)?.length, 1);
});
