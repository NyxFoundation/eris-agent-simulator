// Issue #117: `blocksRemaining` is counted from the coordinator's declared first block, so a jump
// in block numbers (anvil's automine backlog flush, a resume) is not charged against the run.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUN_START_FILE,
  readRunStart,
  writeRunStart,
} from "@eris/sdk/runStart.js";
import { blocksRemainingUnderBlockBudget } from "../example/agents/runtime/blockBudget.js";

test("a block-number jump does not move the budget when the first block is declared", () => {
  // The agent saw block 10 before the flush; the coordinator started counting at 230; the next
  // block the agent sees is 231. 360 − (231 − 230) = 359, not 360 − 221.
  assert.equal(
    blocksRemainingUnderBlockBudget({
      bn: 231,
      runBlocks: 360,
      declaredFirstBlock: 230,
      firstSeenBlock: 10,
      startupLagBlocks: 3,
    }),
    359,
  );
  // And it keeps counting down from there.
  assert.equal(
    blocksRemainingUnderBlockBudget({
      bn: 400,
      runBlocks: 360,
      declaredFirstBlock: 230,
      firstSeenBlock: 10,
      startupLagBlocks: 3,
    }),
    190,
  );
});

test("without a declaration the inferred origin (first seen block, less boot lag) is used", () => {
  // The formula the runtime had before #117, byte for byte: a jump after boot is charged.
  assert.equal(
    blocksRemainingUnderBlockBudget({
      bn: 231,
      runBlocks: 360,
      declaredFirstBlock: null,
      firstSeenBlock: 10,
      startupLagBlocks: 3,
    }),
    360 - 3 - 221,
  );
});

test("no block limit means no block budget", () => {
  assert.equal(
    blocksRemainingUnderBlockBudget({
      bn: 5,
      runBlocks: 0,
      declaredFirstBlock: 1,
      firstSeenBlock: 1,
      startupLagBlocks: 0,
    }),
    null,
  );
});

test("run-start.json round-trips, and is absent or malformed → null", () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-run-start-"));
  try {
    assert.equal(
      readRunStart(dir),
      null,
      "absent before the coordinator writes it",
    );
    assert.equal(
      readRunStart(undefined),
      null,
      "a self-hosted agent has no run dir",
    );
    const written = writeRunStart(dir, { runStartBlock: 230, runBlocks: 360 });
    const read = readRunStart(dir);
    assert.ok(read);
    assert.equal(read.runStartBlock, 230);
    assert.equal(read.runBlocks, 360);
    assert.equal(read.writtenAt, written.writtenAt);
    writeFileSync(join(dir, RUN_START_FILE), "{not json");
    assert.equal(
      readRunStart(dir),
      null,
      "malformed reads as absent, never throws",
    );
    writeFileSync(
      join(dir, RUN_START_FILE),
      JSON.stringify({ schema: 2, runStartBlock: 1 }),
    );
    assert.equal(readRunStart(dir), null, "an unknown schema reads as absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
