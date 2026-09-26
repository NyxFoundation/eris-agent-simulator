// Issue #136: a practice period ends on a date (rules §2.7: the trial ends 10/31), not N blocks after
// whenever the coordinator happened to start. `run.endsAt` converts to blocks at load time.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunLength } from "../sdk/src/config.js";
import { buildSource, resolveRunInputs } from "../core/src/runConfig.js";
import { loadConfig } from "../core/src/config.js";

const START = Date.parse("2026-09-27T00:00:00+09:00");

test("a date converts to the blocks that remain at the cadence", () => {
  const r = resolveRunLength(
    { ERIS_RUN_ENDS_AT: "2026-10-31T23:59:59+09:00" },
    2,
    START,
  );
  // 34 days 23:59:59 = 3,023,999 s -> 1,511,999 two-second blocks (floored: never past the date)
  assert.equal(r.runBlocks, 1_511_999);
  assert.equal(r.runEndsAt, "2026-10-31T14:59:59.000Z");
});

test("a restart ends on the same date: the later start gets fewer blocks, not a fresh length", () => {
  const env = { ERIS_RUN_ENDS_AT: "2026-10-31T23:59:59+09:00" };
  const first = resolveRunLength(env, 2, START);
  const restarted = resolveRunLength(env, 2, START + 3 * 86_400_000);
  assert.equal(first.runBlocks - restarted.runBlocks, (3 * 86_400) / 2);
  assert.equal(first.runEndsAt, restarted.runEndsAt);
});

test("stated in blocks, nothing changes", () => {
  assert.deepEqual(resolveRunLength({ ERIS_RUN_BLOCKS: "360" }, 2, START), {
    runBlocks: 360,
    runEndsAt: null,
  });
  assert.deepEqual(resolveRunLength({}, 2, START), {
    runBlocks: 0,
    runEndsAt: null,
  });
});

test("both, a date without a zone, a past date and a zero cadence are refused", () => {
  assert.throws(
    () =>
      resolveRunLength(
        {
          ERIS_RUN_ENDS_AT: "2026-10-31T23:59:59+09:00",
          ERIS_RUN_BLOCKS: "360",
        },
        2,
        START,
      ),
    /both set/,
  );
  assert.throws(
    () =>
      resolveRunLength({ ERIS_RUN_ENDS_AT: "2026-10-31T23:59:59" }, 2, START),
    /time zone/,
  );
  assert.throws(
    () => resolveRunLength({ ERIS_RUN_ENDS_AT: "not-a-dateZ" }, 2, START),
    /ISO 8601/,
  );
  assert.throws(
    () =>
      resolveRunLength({ ERIS_RUN_ENDS_AT: "2026-09-01T00:00:00Z" }, 2, START),
    /no blocks to run/,
  );
  assert.throws(
    () =>
      resolveRunLength({ ERIS_RUN_ENDS_AT: "2026-10-31T23:59:59Z" }, 0, START),
    /blockTimeSec/,
  );
});

test("YAML run.endsAt reaches SimConfig through the schema", () => {
  const source = buildSource({
    run: { endsAt: "2099-01-01T00:00:00Z", blockTimeSec: 2 },
  });
  assert.equal(source.ERIS_RUN_ENDS_AT, "2099-01-01T00:00:00Z");
  const config = loadConfig(source);
  assert.ok(config.runBlocks > 0);
  assert.equal(config.runEndsAt, "2099-01-01T00:00:00.000Z");
});

function writeConfig(run: string): string {
  const dir = mkdtempSync(join(tmpdir(), "eris-endsat-"));
  const path = join(dir, "c.yaml");
  writeFileSync(
    path,
    `run:\n${run}\nagents:\n  - id: noop\n    wallet: AUTO\n`,
  );
  return path;
}

test("a one-off --blocks replaces the file's endsAt (a short smoke run of the practice config)", () => {
  const path = writeConfig(
    '  endsAt: "2099-01-01T00:00:00Z"\n  blockTimeSec: 2',
  );
  const { config } = resolveRunInputs([
    "node",
    "x",
    "--config",
    path,
    "--blocks",
    "40",
  ]);
  assert.equal(config.runBlocks, 40);
  assert.equal(config.runEndsAt, null);
});

test("a one-off --ends-at replaces the file's blocks", () => {
  const path = writeConfig("  blocks: 360\n  blockTimeSec: 2");
  const { config } = resolveRunInputs([
    "node",
    "x",
    "--config",
    path,
    "--ends-at",
    "2099-01-01T00:00:00Z",
  ]);
  assert.ok(config.runBlocks > 360);
  assert.equal(config.runEndsAt, "2099-01-01T00:00:00.000Z");
});

test("the file stating both is refused", () => {
  const path = writeConfig(
    '  blocks: 360\n  endsAt: "2099-01-01T00:00:00Z"\n  blockTimeSec: 2',
  );
  assert.throws(
    () => resolveRunInputs(["node", "x", "--config", path]),
    /both set/,
  );
});
