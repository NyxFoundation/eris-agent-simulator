// The period's clock (sdk/src/periodClock.ts): where a practice period's scored day ends, and the
// manifest section that carries it to an agent nobody spawned (ADR 0021 §2 / §6).
//
// The property worth pinning is that the coordinator and a self-hosted runtime compute the same
// instant from the same two published numbers. The coordinator used to start each day `hours` after
// the previous roll, and a roll lands at the first block processed after its due time -- so the
// days drifted by the sum of those lags, and a runtime computing from the origin would have been
// off by all of them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dayBlocksRemaining,
  type ManifestPeriod,
  nextDayBoundaryMs,
  parseManifestPeriod,
  scoredDayHours,
} from "@eris/sdk/periodClock.js";
import { loadConfig } from "@eris/sdk/config.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import {
  RUN_START_FILE,
  readRunStart,
  writeRunStart,
} from "@eris/sdk/runStart.js";
import type { AgentObservation } from "@eris/sdk/types.js";
import { Reader } from "../example/agents/runtime/read.js";
import { buildManifest } from "../core/src/manifest.js";
import { SegmentedRun } from "../core/src/segments.js";

const T0 = Date.parse("2026-09-28T01:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test("the day grid runs from the period's origin, a fixed length per day", () => {
  assert.equal(nextDayBoundaryMs(T0, 24, T0), T0 + DAY, "day 0 ends a day in");
  assert.equal(nextDayBoundaryMs(T0, 24, T0 + 5 * HOUR), T0 + DAY);
  assert.equal(
    nextDayBoundaryMs(T0, 24, T0 + DAY),
    T0 + 2 * DAY,
    "on the boundary, the next day has begun",
  );
  assert.equal(nextDayBoundaryMs(T0, 24, T0 + 9 * DAY + 1), T0 + 10 * DAY);
  assert.equal(
    nextDayBoundaryMs(T0, 24, T0 - 10_000),
    T0 + DAY,
    "a clock behind the operator's still sees the first day",
  );
  assert.equal(nextDayBoundaryMs(T0, 0.5, T0 + 45 * 60_000), T0 + HOUR);
});

test("dayBlocksRemaining counts whole blocks to the boundary and stops at 0", () => {
  const at = (nowMs: number) =>
    dayBlocksRemaining({
      startedAtMs: T0,
      dayHours: 24,
      nowMs,
      blockTimeSec: 2,
    });
  assert.equal(at(T0), 43_200, "a whole day at 2 s a block");
  assert.equal(at(T0 + DAY - 100_000), 50);
  assert.equal(at(T0 + DAY - 1_900), 0, "under a block to go reads 0");
  assert.equal(at(T0 + DAY), 43_200, "and the next day starts full");
});

test("only a continuous period cut into days has a scored day", () => {
  assert.equal(
    scoredDayHours({ resetUnit: "continuous", segmentHours: 24 }),
    24,
  );
  // A scenario epoch or a single run is one epoch: blocksRemaining is already its end.
  assert.equal(scoredDayHours({ resetUnit: "scenario", segmentHours: 24 }), 0);
  assert.equal(scoredDayHours({ resetUnit: "continuous", segmentHours: 0 }), 0);
});

test("the coordinator rolls on the grid, not `hours` after its own late roll", () => {
  const run = new SegmentedRun({
    root: mkdtempSync(join(tmpdir(), "eris-grid-")),
    competitionId: "period",
    hours: 24,
    scenarioSet: "practice",
  });
  assert.equal(
    run.dueToRoll(T0 + 2 * DAY),
    false,
    "never before the first block",
  );
  run.noteFirstBlock(100, T0);
  assert.equal(run.periodStartedAt, T0);
  assert.equal(run.dueToRoll(T0 + DAY - 1), false);
  assert.equal(run.dueToRoll(T0 + DAY), true);
  // The roll lands 7 s late (the first block processed after the due time, plus the flush).
  run.roll(43_300, [], T0 + DAY + 7_000);
  assert.equal(
    run.dueToRoll(T0 + 2 * DAY + 6_999),
    true,
    "day 1 still ends at T0 + 2 days: the 7 s is not carried into it",
  );
  assert.equal(run.dueToRoll(T0 + 2 * DAY - 1), false);
});

test("a loop that stalled past several boundaries rolls once, onto the next one", () => {
  const run = new SegmentedRun({
    root: mkdtempSync(join(tmpdir(), "eris-grid-")),
    competitionId: "period",
    hours: 24,
    scenarioSet: "practice",
  });
  run.noteFirstBlock(100, T0);
  run.roll(200, [], T0 + 3.5 * DAY);
  assert.equal(
    run.dueToRoll(T0 + 3.5 * DAY + 1),
    false,
    "no run of one-block days",
  );
  assert.equal(run.dueToRoll(T0 + 4 * DAY), true);
});

function practiceConfig(env: Record<string, string>) {
  return {
    ...loadConfig({
      ENABLED_PROTOCOLS: "uniswap",
      ERIS_BLOCK_TIME_SEC: "2",
      ERIS_RUN_SECONDS: "3628800",
      ERIS_SEGMENT_HOURS: "24",
      ERIS_RESET_UNIT: "continuous",
      ...env,
    }),
    stressEvents: [],
    vulnEvents: [],
  };
}

test("a manifest built before the period starts states the date, not a block count it cannot know", () => {
  const m = buildManifest({
    config: practiceConfig({ ERIS_RUN_ENDS_AT: "2099-10-31T23:59:59+09:00" }),
    participants: [],
  });
  assert.equal(m.period.endsAt, "2099-10-31T14:59:59.000Z");
  // config.runBlocks here is the date converted at *this* moment, not what the environment stops on.
  assert.equal("blocks" in m.period, false);
  assert.equal(m.period.startBlock, undefined);
  assert.equal(m.period.startedAt, undefined);
  assert.equal(m.period.seconds, 3_628_800);
  assert.equal(m.period.dayHours, 24);
  // The participant-facing document does not use the operator's word for a day.
  assert.doesNotMatch(JSON.stringify(m.period), /segment/i);
});

test("the coordinator's manifest, once the run has started, carries where the count and the days begin", () => {
  const config = practiceConfig({
    ERIS_RUN_ENDS_AT: "2099-10-31T23:59:59+09:00",
  });
  const m = buildManifest({
    config,
    participants: [],
    periodStart: { block: 1_234, startedAtMs: T0 },
  });
  assert.equal(m.period.blocks, config.runBlocks);
  assert.equal(m.period.startBlock, 1_234);
  assert.equal(m.period.startedAt, "2026-09-28T01:00:00.000Z");
  // And it survives the runtime's reading of it unchanged.
  assert.deepEqual(
    parseManifestPeriod(JSON.parse(JSON.stringify(m.period))),
    m.period,
  );
});

test("a run stated in blocks publishes its blocks, and a single run has no day", () => {
  const m = buildManifest({
    config: practiceConfig({
      ERIS_RUN_BLOCKS: "360",
      ERIS_RUN_SECONDS: "300",
      ERIS_SEGMENT_HOURS: "0",
    }),
    participants: [],
  });
  assert.equal(m.period.endsAt, null);
  assert.equal(m.period.blocks, 360);
  assert.equal(m.period.dayHours, 0);
});

test("the runtime refuses a malformed period rather than falling back to its config", () => {
  assert.equal(
    parseManifestPeriod(undefined),
    null,
    "a manifest from before the section",
  );
  assert.throws(() => parseManifestPeriod("tomorrow"), /must be an object/);
  assert.throws(
    () => parseManifestPeriod({ endsAt: "soon", seconds: 1, dayHours: 24 }),
    /endsAt must be an ISO 8601 date/,
  );
  assert.throws(
    () =>
      parseManifestPeriod({
        endsAt: null,
        blocks: -1,
        seconds: 0,
        dayHours: 0,
      }),
    /blocks must be a non-negative number/,
  );
});

test("run-start.json carries the period's origin to a coordinator-spawned agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-run-start-"));
  writeRunStart(dir, { runStartBlock: 230, runBlocks: 360, startedAtMs: T0 });
  assert.equal(readRunStart(dir)?.startedAt, "2026-09-28T01:00:00.000Z");
  // Optional for a reader, since a file from before the field has none; malformed reads as absent.
  writeFileSync(
    join(dir, RUN_START_FILE),
    JSON.stringify({ schema: 1, runStartBlock: 1, runBlocks: 2, writtenAt: "x" }),
  );
  assert.equal(readRunStart(dir)?.startedAt, undefined);
  writeFileSync(
    join(dir, RUN_START_FILE),
    JSON.stringify({ schema: 1, runStartBlock: 1, runBlocks: 2, startedAt: "later" }),
  );
  assert.equal(readRunStart(dir), null);
});

// The Reader's two clocks, driven directly: a snapshot needs a chain, the clock does not.
type Clocked = {
  observeSelfHostedClock(o: AgentObservation, bn: number): void;
  observeCoordinatorClock(o: AgentObservation, bn: number): void;
};
function reader(
  config: Record<string, string>,
  opts: { period?: ManifestPeriod; runDir?: string } = {},
): Clocked {
  return new Reader({
    ctx: { config: loadConfig(config) } as unknown as SimContext,
    adapters: [],
    priceFeed: "0x2222222222222222222222222222222222222222",
    address: "0x1111111111111111111111111111111111111111",
    runId: "test",
    extraBaseSymbols: [],
    ...opts,
  }) as unknown as Clocked;
}

test("a self-hosted agent's day ends on the published grid, and never after the run does", () => {
  const nowMs = Date.now();
  const period: ManifestPeriod = {
    endsAt: null,
    blocks: 50_000,
    startBlock: 100,
    seconds: 0,
    startedAt: new Date(nowMs - 6 * HOUR).toISOString(),
    dayHours: 24,
    note: "",
  };
  const obs = {} as AgentObservation;
  reader({ ERIS_BLOCK_TIME_SEC: "2" }, { period }).observeSelfHostedClock(obs, 1_100);
  assert.equal(obs.blocksRemaining, 49_000);
  // 18 hours left in the day at 2 s a block, give or take the milliseconds this test took.
  assert.ok(Math.abs((obs.dayBlocksRemaining ?? 0) - 32_400) <= 1);

  const lastDay = {} as AgentObservation;
  reader({ ERIS_BLOCK_TIME_SEC: "2" }, { period }).observeSelfHostedClock(lastDay, 50_000);
  assert.equal(lastDay.blocksRemaining, 100);
  assert.equal(lastDay.dayBlocksRemaining, 100, "the last day ends with the run");
});

test("a manifest from before the period started has no day to count", () => {
  const obs = {} as AgentObservation;
  reader({}, { period: { endsAt: null, blocks: 0, seconds: 0, dayHours: 24, note: "" } })
    .observeSelfHostedClock(obs, 10);
  assert.equal("dayBlocksRemaining" in obs, false);
});

test("a coordinator-spawned agent reads the day's origin from run-start.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-run-start-"));
  writeRunStart(dir, {
    runStartBlock: 100,
    runBlocks: 360,
    startedAtMs: Date.now() - 23 * HOUR,
  });
  const practice = {
    ERIS_BLOCK_TIME_SEC: "2",
    ERIS_RUN_BLOCKS: "100000",
    ERIS_RUN_SECONDS: "0",
    ERIS_SEGMENT_HOURS: "24",
    ERIS_RESET_UNIT: "continuous",
  };
  const obs = {} as AgentObservation;
  reader(practice, { runDir: dir }).observeCoordinatorClock(obs, 200);
  assert.ok(Math.abs((obs.dayBlocksRemaining ?? 0) - 1_800) <= 1, "an hour left");

  // The official competition is one epoch per run: no day, and blocksRemaining as before.
  const official = {} as AgentObservation;
  reader(
    { ...practice, ERIS_SEGMENT_HOURS: "0", ERIS_RESET_UNIT: "scenario" },
    { runDir: dir },
  ).observeCoordinatorClock(official, 200);
  assert.equal("dayBlocksRemaining" in official, false);
  assert.equal(official.blocksRemaining, 100_000 - 100);
});
