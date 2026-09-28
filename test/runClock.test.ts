// A self-hosted agent's run length comes from the manifest (example/agents/runtime/runClock.ts).
//
// What was broken: the guide's command sets no ERIS_CONFIG, so the runtime took its run length from
// the env defaults -- no block limit and 20 seconds -- and `blocksRemaining` read 0 twenty seconds
// after start, for the five weeks of the practice period. A participant's own YAML was no better:
// the template says 100 blocks. The manifest's `period` has to win over both, and a YAML that states
// either `run.blocks` or `run.endsAt` must not collide with it (the loader refuses both at once).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@eris/sdk/config.js";
import { loadYamlConfig } from "@eris/sdk/runConfig.js";
import type { ManifestPeriod } from "@eris/sdk/periodClock.js";
import {
  describeSelfHostedBudget,
  manifestRunOverrides,
  selfHostedBlocksRemaining,
} from "../example/agents/runtime/runClock.js";

const HOUR = 3_600_000;
const ENDS_AT = "2099-10-31T14:59:59.000Z";

const notStarted: ManifestPeriod = {
  endsAt: ENDS_AT,
  seconds: 3_628_800,
  dayHours: 24,
  note: "",
};
const started: ManifestPeriod = {
  ...notStarted,
  blocks: 1_488_969,
  startBlock: 5_000,
  startedAt: "2026-09-28T01:00:00.000Z",
};

function yaml(run: string): string {
  const dir = mkdtempSync(join(tmpdir(), "eris-runclock-"));
  const path = join(dir, "local.yaml");
  writeFileSync(path, `run:\n${run}\n`);
  return path;
}

test("the failure: with no config the runtime's run is 20 seconds long", () => {
  // What botMain loaded for the guide's command before the manifest carried a period.
  const config = loadConfig({});
  assert.equal(config.runBlocks, 0);
  assert.equal(config.runSeconds, 20);
});

test("the manifest's date wins over a participant's own YAML", () => {
  const path = yaml("  blocks: 100\n  seconds: 300\n  blockTimeSec: 2");
  const { config } = loadYamlConfig(path, manifestRunOverrides(notStarted, 2));
  assert.equal(config.runEndsAt, ENDS_AT);
  assert.ok(
    config.runBlocks > 100_000_000,
    "the blocks to 2099, not the file's 100",
  );
  assert.equal(config.runSeconds, 3_628_800);
  assert.equal(config.segmentHours, 24);
});

test("once the run has started, its block budget wins -- even over a YAML that states a date", () => {
  // Blocks, not the date re-converted: that would count from this process's start instead of the
  // run's. And a YAML endsAt beside it must not trip the "both set" refusal.
  const path = yaml('  endsAt: "2099-01-01T00:00:00Z"\n  blockTimeSec: 2');
  const { config } = loadYamlConfig(path, manifestRunOverrides(started, 2));
  assert.equal(config.runBlocks, 1_488_969);
  assert.equal(config.runEndsAt, null);
});

test("with no config at all, the env defaults' 20 seconds are replaced too", () => {
  const config = loadConfig({ ...manifestRunOverrides(notStarted, 2) });
  assert.equal(config.runSeconds, 3_628_800);
  assert.equal(config.runEndsAt, ENDS_AT);
  assert.equal(config.blockTimeSec, 2);
});

test("the manifest's cadence is the one the date converts at", () => {
  const path = yaml("  blocks: 100\n  blockTimeSec: 12");
  const { config } = loadYamlConfig(path, manifestRunOverrides(notStarted, 2));
  assert.equal(config.blockTimeSec, 2);
});

const base = {
  bn: 0,
  nowMs: 0,
  blockTimeSec: 2,
  firstSeenBlock: 0,
  startupLagBlocks: 0,
  processStartedAtMs: 0,
};

test("started: the environment's own count, whatever this process remembers", () => {
  const period: ManifestPeriod = {
    endsAt: null,
    blocks: 1_000,
    startBlock: 500,
    seconds: 0,
    dayHours: 0,
    note: "",
  };
  // Joined at block 650 with a slow boot: none of that moves the count.
  assert.equal(
    selfHostedBlocksRemaining({
      ...base,
      period,
      bn: 700,
      firstSeenBlock: 650,
      startupLagBlocks: 9,
    }),
    800,
  );
});

test("not started: blocks to the end date at the cadence", () => {
  const endsMs = Date.parse(ENDS_AT);
  assert.equal(
    selfHostedBlocksRemaining({
      ...base,
      period: { ...notStarted, seconds: 0 },
      nowMs: endsMs - 100_000,
    }),
    50,
  );
  assert.equal(
    selfHostedBlocksRemaining({
      ...base,
      period: { ...notStarted, seconds: 0 },
      nowMs: endsMs + 60_000,
    }),
    0,
    "past the date reads 0, never negative",
  );
});

test("the guide's command a minute in: the period is weeks long, not over", () => {
  // The measured failure, replayed through the new path: 60 s after start it read 0.
  const startedAtMs = Date.parse("2026-09-28T01:00:00Z");
  const period: ManifestPeriod = {
    endsAt: "2026-10-31T14:59:59.000Z",
    blocks: 1_450_000,
    startBlock: 10,
    seconds: 3_628_800,
    startedAt: "2026-09-28T01:00:00.000Z",
    dayHours: 24,
    note: "",
  };
  assert.equal(
    selfHostedBlocksRemaining({
      ...base,
      period,
      bn: 40,
      nowMs: startedAtMs + 60_000,
      processStartedAtMs: startedAtMs,
    }),
    1_450_000 - 30,
    "the 42-day ceiling does not bind before the block count does",
  );
});

test("a run stated in blocks with no known start is counted from the first block seen", () => {
  const period: ManifestPeriod = {
    endsAt: null,
    blocks: 360,
    seconds: 0,
    dayHours: 0,
    note: "",
  };
  assert.equal(
    selfHostedBlocksRemaining({
      ...base,
      period,
      bn: 20,
      firstSeenBlock: 10,
      startupLagBlocks: 2,
    }),
    348,
  );
  assert.match(describeSelfHostedBudget(period), /inferred/);
});

test("the ceiling counts from the period's start, and from this process's start without one", () => {
  const period: ManifestPeriod = {
    endsAt: null,
    seconds: 600,
    startedAt: new Date(10 * HOUR).toISOString(),
    dayHours: 0,
    note: "",
  };
  assert.equal(
    selfHostedBlocksRemaining({ ...base, period, nowMs: 10 * HOUR + 400_000 }),
    100,
  );
  const { startedAt: _drop, ...noStart } = period;
  assert.equal(
    selfHostedBlocksRemaining({
      ...base,
      period: noStart,
      nowMs: 10 * HOUR + 400_000,
      processStartedAtMs: 10 * HOUR + 300_000,
    }),
    250,
    "later than the real ceiling -- a late joiner's process start is not the run's",
  );
});

test("no block budget and no ceiling is no limit", () => {
  assert.equal(
    selfHostedBlocksRemaining({
      ...base,
      period: { endsAt: null, seconds: 0, dayHours: 0, note: "" },
    }),
    undefined,
  );
});
