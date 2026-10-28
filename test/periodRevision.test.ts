// Revising a running practice period (core/src/realtime/periodResume.ts "revising a period";
// ADR 0029 Amendment 3): the walk's parameters and the episodes not yet played may change across a
// restart, every window the period has played or is about to play may not, and the generator
// rewrites only the days asked for.
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import {
  checkPeriodExtension,
  revisedScheduleProblems,
} from "../core/src/realtime/periodResume.js";
import { EventSchedule, parseStressEvents } from "../core/src/realtime/events.js";
import {
  dailyEpisodePlan,
  renderEventLines,
  reviseEpisode,
  reviseStressEvents,
} from "../core/src/practiceEpisodes.js";

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const DAY = 43_200;
const RUN_BLOCKS = 4 * DAY;
const SEED_ONLY = { saltWithEventList: false };

// Four days in the shapes the period had before the revision: gaps that heal, a drift reshaping a
// reversion. reviseEpisode is what turns them into today's (the drift into a volatility burst).
type Episode = Record<string, unknown> & { type: string };
const OLD_SHAPES = (e: Episode): Episode =>
  e.type === "crash" || e.type === "spike"
    ? { type: e.type, magnitudeRange: [0.15, 0.22], windowFrac: e.windowFrac, rampBlocks: 3, holdBlocks: 6, decayBlocks: 8 }
    : e.type === "volBurst"
      ? { type: "cexDrift", magnitudeRange: [0.001, 0.002], windowFrac: e.windowFrac, kappaMultRange: [0.15, 0.3], rampBlocks: 6, holdBlocks: 24, decayBlocks: 12 }
      : e;
const oldPlan = dailyEpisodePlan(96).map((d) => ({ ...d, events: d.events.map(OLD_SHAPES) }));
const oldEvents = oldPlan.flatMap((d) => d.events);

const OU_BEFORE = { global: { volatility: 0.004, kappa: 0.02, drift: 0 } };
const OU_AFTER = { global: { volatility: 0.00037, kappa: 0, drift: 0 } };
function world(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seed: 7,
    runEndsAt: "2026-11-30T14:59:59.000Z",
    ou: OU_BEFORE,
    stressEvents: plain(oldEvents),
    ...over,
  };
}

test("the walk's parameters and the episodes may change with the end held: a revision", () => {
  const revised = plain(oldEvents.map((e, i) => (i >= 20 ? reviseEpisode(e as never) : e)));
  const check = checkPeriodExtension(
    world(),
    world({ ou: OU_AFTER, stressEvents: revised, stressSaltWithEventList: false }),
    RUN_BLOCKS,
  );
  assert.equal(check.kind, "revise");
  if (check.kind !== "revise") return;
  assert.equal(check.windowBase, RUN_BLOCKS);
  assert.deepEqual(
    check.changed.map((c) => c.split(":")[0]),
    ["ou", "stressEvents", "stressSaltWithEventList"],
  );
  assert.match(check.changed[1], /the first 20 unchanged/);
});

test("what a revision refuses: another key, a moved base, and a revision with an extension", () => {
  const refused = (now: Record<string, unknown>) => {
    const check = checkPeriodExtension(world(), now, RUN_BLOCKS);
    assert.equal(check.kind, "refused", JSON.stringify(check));
    return check.kind === "refused" ? check.diff.join("\n") : "";
  };
  assert.match(refused(world({ ou: OU_AFTER, seed: 8 })), /seed: 7 -> 8/);
  assert.match(refused(world({ ou: OU_AFTER, stressWindowBaseBlocks: RUN_BLOCKS * 2 })), /keeps the base/);
  assert.match(
    refused(world({ ou: OU_AFTER, runEndsAt: "2026-12-15T14:59:59.000Z", stressWindowBaseBlocks: RUN_BLOCKS })),
    /separate restarts/,
  );
});

test("on the seed-only stream, revising days 3-4 leaves every window of days 1-2 as it was", () => {
  const revised = oldPlan.flatMap((d) => (d.day >= 2 ? d.events.map((e) => reviseEpisode(e as never)) : d.events));
  const day3 = 2 * DAY;
  for (const seed of [1, 7, 99, 123456789]) {
    const before = new EventSchedule(parseStressEvents(JSON.stringify(oldEvents)), seed, RUN_BLOCKS);
    const after = new EventSchedule(parseStressEvents(JSON.stringify(revised)), seed, RUN_BLOCKS, RUN_BLOCKS, SEED_ONLY);
    // The head two hours into day 3: everything before it was played, everything from it is new.
    assert.deepEqual(revisedScheduleProblems(before.events, after.events, day3), [], `seed ${seed}`);
    const kept = before.events.filter((w) => w.startBlock < day3);
    assert.equal(kept.length, 20);
    assert.deepEqual(after.events.slice(0, 20), kept);
    // Revised days carry today's shapes: the gaps stay where they land.
    for (const w of after.events.slice(20))
      if (w.type === "crash" || w.type === "spike") assert.equal(w.recoverFrac, 0);
    // A head already inside the revised days is refused: a window it has played would change.
    assert.ok(revisedScheduleProblems(before.events, after.events, day3 + DAY).length > 0);
  }
});

test("a salted stream redraws the played windows, and the check says so", () => {
  const revised = oldPlan.flatMap((d) => (d.day >= 2 ? d.events.map((e) => reviseEpisode(e as never)) : d.events));
  const before = new EventSchedule(parseStressEvents(JSON.stringify(oldEvents)), 7, RUN_BLOCKS);
  const after = new EventSchedule(parseStressEvents(JSON.stringify(revised)), 7, RUN_BLOCKS);
  assert.match(revisedScheduleProblems(before.events, after.events, 2 * DAY).join(), /saltWithEventList: false/);
});

test("revisedScheduleProblems: an added played window, and played windows out of order", () => {
  const w = (type: string, startBlock: number) => ({ type, startBlock });
  assert.match(
    revisedScheduleProblems([w("crash", 10)], [w("crash", 10), w("spike", 20)], 50).join(),
    /1 windows start before run block 50 in the period, 2 once revised/,
  );
  assert.match(
    revisedScheduleProblems([w("crash", 10), w("spike", 80), w("whale", 20)], [w("crash", 10)], 50).join(),
    /prefix/,
  );
  assert.deepEqual(revisedScheduleProblems([w("crash", 10), w("spike", 80)], [w("crash", 10), w("whale", 60)], 50), []);
});

test("the generator rewrites day N onward and leaves every earlier line byte for byte", () => {
  const text = ["stress:", "  events:", ...renderEventLines(oldPlan, ["test"]), "agents: []"].join("\n");
  const parseLine = (m: string) => parse(m) as Record<string, unknown> & { type: string };
  const { text: out, revised, days } = reviseStressEvents(text, 3, parseLine);
  assert.equal(days, 2);
  assert.equal(revised, 2 * 3); // crash, spike and the drift (now a volBurst) on each of days 3 and 4
  const a = text.split("\n");
  const b = out.split("\n");
  const day3 = a.findIndex((l) => l.startsWith("    # day 3 "));
  assert.deepEqual(b.slice(0, day3), a.slice(0, day3));
  const events = (parse(out) as { stress: { events: Record<string, unknown>[] } }).stress.events;
  assert.deepEqual(events.filter((e) => e.type === "volBurst").length, 2);
  assert.deepEqual(events.filter((e) => e.type === "cexDrift").length, 2);
  const crash = events.filter((e) => e.type === "crash");
  assert.deepEqual(crash.map((e) => e.recoverFrac ?? null), [null, null, [0, 0], [0, 0]]);
  assert.deepEqual(crash[2].windowFrac, oldEvents.filter((e) => e.type === "crash")[2].windowFrac);
  // Again: nothing left to change.
  assert.equal(reviseStressEvents(out, 3, parseLine).revised, 0);
});
