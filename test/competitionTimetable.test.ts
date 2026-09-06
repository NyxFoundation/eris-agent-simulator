// The plan's timetable is logistics, not part of the commitment: the lottery fixes which scenario
// each epoch replays and in what order (rules §3.3), the operator decides when each one starts
// (§4.7.1 lets the week run as several sessions). The dashboard shows the next start from it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlan,
  commitmentOf,
  withTimetable,
} from "../core/src/competition/schedule.js";

const hidden = { regimes: { calm: [1, 2], whale: [3, 4] } };
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
