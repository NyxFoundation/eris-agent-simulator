// `backtest --follow-schedule` (ADR 0026): the runner waits for each epoch's planned start, so one
// unattended process runs the live week instead of all k epochs back to back at its start. What is
// pinned: which plans it refuses before anvil starts, what it waits for, what it does with a start
// that has already passed, and that a --resume only ever waits for the epochs it will run.
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertFollowable,
  describeStart,
  formatDuration,
  ON_TIME_MS,
  sleep,
  startDelay,
} from "../core/src/backtest/timetable.js";
import { mergeStoredResults } from "../core/src/backtest/resume.js";
import { buildPlan, spreadOver } from "../core/src/competition/schedule.js";

const at = (iso: string): number => Date.parse(iso);

test("a start ahead of the clock is waited for, to the millisecond", () => {
  assert.deepEqual(
    startDelay("2026-11-01T02:48:00.000Z", at("2026-11-01T00:00:00.000Z")),
    { waitMs: 168 * 60_000, lateMs: 0 },
  );
});

test("a start that has passed is not waited for: the epoch starts at once and the delay is reported", () => {
  assert.deepEqual(
    startDelay("2026-11-01T00:00:00.000Z", at("2026-11-01T00:12:05.000Z")),
    { waitMs: 0, lateMs: 12 * 60_000 + 5_000 },
  );
  // On the planned millisecond both are zero.
  assert.deepEqual(
    startDelay("2026-11-01T00:00:00.000Z", at("2026-11-01T00:00:00.000Z")),
    { waitMs: 0, lateMs: 0 },
  );
});

test("offsets in the plan are honoured (the live week is written in JST)", () => {
  assert.equal(
    startDelay("2026-11-01T00:00:00+09:00", at("2026-10-31T14:00:00Z")).waitMs,
    60 * 60_000,
  );
});

test("the line before an epoch says what it waits for, or how late it is, or nothing when on time", () => {
  const epoch = { s: 5, label: "crash#707", startsAt: "2026-11-01T11:12:00.000Z" };
  assert.equal(
    describeStart(epoch, at("2026-11-01T08:40:56.000Z")),
    "s=5 crash#707: waiting 2h 31m for its planned start 2026-11-01T11:12:00.000Z (--follow-schedule)",
  );
  assert.equal(
    describeStart(epoch, at("2026-11-01T11:25:30.000Z")),
    "s=5 crash#707: planned for 2026-11-01T11:12:00.000Z, starting now, 13m 30s late",
  );
  // Waking from the wait lands a few ms past the mark: that is on time, not late.
  assert.equal(
    describeStart(epoch, at("2026-11-01T11:12:00.000Z") + ON_TIME_MS - 1),
    undefined,
  );
});

test("durations read in the two largest units", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(7_900), "7s");
  assert.equal(formatDuration(12 * 60_000 + 5_000), "12m 05s");
  assert.equal(formatDuration(168 * 60_000), "2h 48m");
  assert.equal(formatDuration((2 * 24 + 3) * 3_600_000 + 4 * 60_000), "2d 3h 04m");
  assert.equal(formatDuration(-5), "0s");
});

test("a plan without a timetable, with a gap in it, or out of order is refused", () => {
  assert.throws(
    () =>
      assertFollowable([
        { s: 1 },
        { s: 2 },
      ]),
    /has no timetable/,
  );
  assert.throws(
    () =>
      assertFollowable([
        { s: 1, startsAt: "2026-11-01T00:00:00Z" },
        { s: 2 },
        { s: 3 },
      ]),
    /s=2,3 have none/,
  );
  assert.throws(
    () =>
      assertFollowable([
        { s: 1, startsAt: "2026-11-01T03:00:00Z" },
        { s: 2, startsAt: "2026-11-01T00:00:00Z" },
      ]),
    /s=2 starts at .* before s=1/,
  );
  assert.throws(
    () => assertFollowable([{ s: 1, startsAt: "soon" }]),
    /not a date/,
  );
  // Two epochs on the same start are followable: the second starts as soon as the first ends.
  assert.doesNotThrow(() =>
    assertFollowable([
      { s: 1, startsAt: "2026-11-01T00:00:00Z" },
      { s: 2, startsAt: "2026-11-01T00:00:00Z" },
    ]),
  );
});

test("the live week's plan is followable end to end, and every wait lands on its slot", () => {
  const regimes = Object.fromEntries(
    [...Array(12).keys()].map((r) => [`r${r}`, [...Array(60).keys()].map((i) => i + 1)]),
  );
  const plan = buildPlan(
    { regimes },
    { lotterySeed: "follow" },
    60,
    spreadOver(
      { startsAt: "2026-11-01T00:00:00+09:00", endsAt: "2026-11-08T00:00:00+09:00" },
      60,
    ),
  );
  assert.doesNotThrow(() => assertFollowable(plan.epochs));
  // A runner that finishes each epoch 17 minutes after its start (the slowest measured wall time)
  // waits the rest of the slot before the next one, every time.
  for (let i = 1; i < plan.epochs.length; i++) {
    const finished = at(plan.epochs[i - 1].startsAt as string) + 17 * 60_000;
    assert.equal(
      startDelay(plan.epochs[i].startsAt as string, finished).waitMs,
      (168 - 17) * 60_000,
    );
  }
});

test("with --resume the runner waits only for the epochs it will run", () => {
  // The runner skips a complete epoch before it looks at the clock (backtest.ts), so what it waits
  // for is decided by the resume plan: here s=1 and s=3 are complete, s=2 failed and s=4 is ahead.
  const epochs = [
    { s: 1, regime: "calm", seed: 1, startsAt: "2026-11-01T00:00:00Z" },
    { s: 2, regime: "crash", seed: 2, startsAt: "2026-11-01T02:48:00Z" },
    { s: 3, regime: "whale", seed: 3, startsAt: "2026-11-01T05:36:00Z" },
    { s: 4, regime: "depeg", seed: 4, startsAt: "2026-11-01T08:24:00Z" },
  ];
  const agents = [{ id: "a", pnlUsdc: 1 }];
  const { complete, rerun } = mergeStoredResults(epochs, [
    { s: 1, regime: "calm", seed: 1, agents },
    { s: 2, regime: "crash", seed: 2, error: "anvil died" },
    { s: 3, regime: "whale", seed: 3, agents },
  ]);
  assert.deepEqual(rerun, [2, 4]);
  const now = at("2026-11-01T07:00:00Z");
  const waits = epochs
    .filter((e) => !complete.has(e.s))
    .map((e) => [e.s, startDelay(e.startsAt, now)]);
  assert.deepEqual(waits, [
    [2, { waitMs: 0, lateMs: (7 * 60 - 168) * 60_000 }],
    [4, { waitMs: 84 * 60_000, lateMs: 0 }],
  ]);
});

test("sleep resolves after the delay, and at once for nothing to wait", async () => {
  const t0 = Date.now();
  await sleep(20);
  assert.ok(Date.now() - t0 >= 15);
  await sleep(0);
  await sleep(-1);
});
