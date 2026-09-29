// The plan's timetable is logistics, not part of the commitment: the lottery fixes which scenario
// each epoch replays and in what order (rules §3.3), the operator decides when each one starts
// (§4.7.1 lets the week run as several sessions). The dashboard shows the next start from it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlan,
  commitmentOf,
  spreadOver,
  withTimetable,
} from "../core/src/competition/schedule.js";

const hidden = { regimes: { calm: [1, 2, 3, 4], whale: [5, 6, 7, 8] } };
const lottery = { lotterySeed: "test-seed" };

test("withTimetable stamps each epoch with start + (s − 1) × spacing", () => {
  const epochs = withTimetable(
    [
      { s: 1, regime: "calm", seed: 1 },
      { s: 3, regime: "whale", seed: 3 },
    ],
    { startsAt: "2026-11-01T09:00:00Z", everyMinutes: 20 },
  );
  assert.equal(epochs[0].startsAt, "2026-11-01T09:00:00.000Z");
  assert.equal(epochs[1].startsAt, "2026-11-01T09:40:00.000Z");
});

test("the timetable does not change the commitments or the order", () => {
  const bare = buildPlan(hidden, lottery, 4);
  const timed = buildPlan(hidden, lottery, 4, {
    startsAt: "2026-11-01T09:00:00Z",
    everyMinutes: 15,
  });
  assert.equal(timed.hiddenSetCommitment, bare.hiddenSetCommitment);
  assert.equal(timed.lotterySeedCommitment, bare.lotterySeedCommitment);
  assert.deepEqual(
    timed.epochs.map((e) => [e.s, e.regime, e.seed]),
    bare.epochs.map((e) => [e.s, e.regime, e.seed]),
  );
  assert.ok(timed.epochs.every((e) => typeof e.startsAt === "string"));
  // The hidden set's commitment is over the hidden set, so a timetable cannot touch it either way.
  assert.equal(commitmentOf(hidden), bare.hiddenSetCommitment);
});

test("a bad timetable is refused", () => {
  assert.throws(() =>
    withTimetable([{ s: 1, regime: "calm", seed: 1 }], {
      startsAt: "not a date",
      everyMinutes: 10,
    }),
  );
  assert.throws(() =>
    withTimetable([{ s: 1, regime: "calm", seed: 1 }], {
      startsAt: "2026-11-01T09:00:00Z",
      everyMinutes: 0,
    }),
  );
});

test("--ends-at spreads k epochs evenly: the live week at k = 60 is one every 168 minutes", () => {
  const timetable = spreadOver(
    { startsAt: "2026-11-01T00:00:00+09:00", endsAt: "2026-11-08T00:00:00+09:00" },
    60,
  );
  assert.equal(timetable.everyMinutes, 168);
  const epochs = withTimetable(
    [...Array(60).keys()].map((i) => ({ s: i + 1, regime: "calm", seed: i })),
    timetable,
  );
  // 00:00 JST on 11/1 is 15:00Z the day before; the last epoch starts one slot before the end, so
  // it has the same 168 minutes as every other to finish in.
  assert.equal(epochs[0].startsAt, "2026-10-31T15:00:00.000Z");
  assert.equal(epochs[1].startsAt, "2026-10-31T17:48:00.000Z");
  assert.equal(epochs[59].startsAt, "2026-11-07T12:12:00.000Z"); // 21:12 JST on 11/7
});

test("a spacing that is not a whole minute is rounded to the millisecond, not drifted", () => {
  // 7 epochs over one hour: 8.571… minutes each.
  const epochs = withTimetable(
    [...Array(7).keys()].map((i) => ({ s: i + 1, regime: "calm", seed: i })),
    spreadOver({ startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-01T01:00:00Z" }, 7),
  );
  assert.equal(epochs[6].startsAt, "2026-11-01T00:51:25.714Z");
  const gaps = epochs.slice(1).map((e, i) => Date.parse(e.startsAt!) - Date.parse(epochs[i].startsAt!));
  assert.ok(gaps.every((g) => Math.abs(g - 3_600_000 / 7) <= 1));
});

test("a window that ends before it starts, or a bad k, is refused", () => {
  assert.throws(() =>
    spreadOver({ startsAt: "2026-11-08T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" }, 60),
  );
  assert.throws(() =>
    spreadOver({ startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" }, 60),
  );
  assert.throws(() =>
    spreadOver({ startsAt: "2026-11-01T00:00:00Z", endsAt: "not a date" }, 60),
  );
  assert.throws(() =>
    spreadOver({ startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-08T00:00:00Z" }, 0),
  );
});
