// The practice period's daily episodes (core/src/practiceEpisodes.ts). The property that matters is
// checked through the code that places the windows, not through the generator's own arithmetic:
// every 24-hour segment of the run holds exactly one of each kind, none crosses a segment boundary,
// and that survives the coordinator starting a little off the planned time.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  dailyEpisodePlan,
  EDGE_MARGIN_HOURS,
  KINDS_PER_DAY,
  MIN_SLICE_HOURS,
  renderEventLines,
  replaceStressEvents,
} from "../core/src/practiceEpisodes.js";
import {
  EventSchedule,
  parseStressEvents,
} from "../core/src/realtime/events.js";

const BLOCKS_PER_HOUR = 1800; // blockTimeSec 2
const PER_DAY = {
  crash: 1,
  liquidityPull: 2,
  spike: 1,
  cexDrift: 1,
  flowTrend: 1,
  whale: 2,
  depeg: 1,
  eusdDepeg: 1,
};

function configsFor(hours: number) {
  const text = replaceStressEvents(
    readFileSync("config/practice.yaml", "utf8"),
    renderEventLines(dailyEpisodePlan(hours), ["test"]),
  );
  const events = (parse(text) as { stress: { events: unknown[] } }).stress
    .events;
  return parseStressEvents(JSON.stringify(events));
}

function perDay(
  configs: ReturnType<typeof configsFor>,
  seed: number,
  runHours: number,
  days: number,
) {
  const schedule = new EventSchedule(
    configs,
    seed,
    Math.round(runHours * BLOCKS_PER_HOUR),
  );
  const seg = 24 * BLOCKS_PER_HOUR;
  const out: Array<Record<string, number>> = Array.from(
    { length: days },
    () => ({}),
  );
  for (const ev of schedule.events) {
    const day = Math.floor(ev.startBlock / seg);
    assert.ok(
      ev.endBlock <= (day + 1) * seg,
      `${ev.type} at ${ev.startBlock} runs past the end of day ${day + 1}`,
    );
    if (day < days) out[day][ev.type] = (out[day][ev.type] ?? 0) + 1;
  }
  return out;
}

test("a 34-day period: every day holds exactly one of each kind, for any seed", () => {
  const hours = 34 * 24 + 8.4; // 9/27 15:36 JST to 10/31 23:59 JST
  const configs = configsFor(hours);
  assert.equal(configs.length, 35 * KINDS_PER_DAY); // the 8.4 h tail is a day of its own
  for (const seed of [1, 7, 642947455, 1616789485]) {
    for (const [d, counts] of perDay(configs, seed, hours, 35).entries())
      assert.deepEqual(counts, PER_DAY, `seed ${seed}, day ${d + 1}`);
  }
});

test("a start up to the margin early or late still leaves every day with one of each kind", () => {
  const planned = 30 * 24;
  const configs = configsFor(planned);
  // A late start makes the run that much shorter (run.endsAt is fixed), an early one that much longer.
  for (const offset of [EDGE_MARGIN_HOURS - 0.1, -(EDGE_MARGIN_HOURS - 0.1)])
    for (const seed of [3, 99, 123456789])
      for (const [d, counts] of perDay(
        configs,
        seed,
        planned - offset,
        30,
      ).entries())
        assert.deepEqual(
          counts,
          PER_DAY,
          `seed ${seed}, day ${d + 1}, started ${offset} h off`,
        );
});

test("a final slice too short for its margins gets no episodes", () => {
  const plan = dailyEpisodePlan(2 * 24 + MIN_SLICE_HOURS - 0.5);
  assert.equal(plan.length, 2);
  assert.equal(dailyEpisodePlan(2 * 24 + MIN_SLICE_HOURS).length, 3);
});

test("windows stay inside their day, clear of both edges, and the second whale alternates venue", () => {
  const hours = 10 * 24;
  for (const d of dailyEpisodePlan(hours)) {
    assert.equal(d.events.length, KINDS_PER_DAY);
    for (const e of d.events) {
      const [lo, hi] = e.windowFrac as [number, number];
      assert.ok(
        lo * hours >= d.fromHours + EDGE_MARGIN_HOURS - 1e-3 &&
          hi * hours <= d.toHours - EDGE_MARGIN_HOURS + 1e-3,
      );
    }
    const venue = d.events.filter((e) => e.type === "whale")[1].venue;
    assert.equal(venue, d.day % 2 === 0 ? "balancer" : "curve");
  }
});

test("rewriting the events list keeps every other line of the config", () => {
  const original = readFileSync("config/practice.yaml", "utf8");
  const lines = renderEventLines(dailyEpisodePlan(48), ["x"]);
  const once = replaceStressEvents(original, lines);
  assert.equal(replaceStressEvents(once, lines), once);
  const outside = (t: string) => {
    const l = t.split("\n");
    const i = l.indexOf("  events:");
    let j = i + 1;
    while (j < l.length && l[j].startsWith("    ")) j++;
    return [...l.slice(0, i + 1), ...l.slice(j)].join("\n");
  };
  assert.equal(outside(once), outside(original));
});
