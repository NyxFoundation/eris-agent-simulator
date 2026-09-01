// A segmented period rolls the run directory while an agent process keeps going (ADR 0021 §6).
// The log has to follow, or every segment after the first shows a local agent with no lines --
// which the dashboard states as "it never logged a decision".
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJsonlAppender } from "../example/agents/runtime/agentLog.js";

const lines = (path: string): Record<string, unknown>[] =>
  existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

test("the decision log follows a segment roll", () => {
  const root = mkdtempSync(join(tmpdir(), "eris-seg-"));
  const s0 = join(root, "s00");
  const s1 = join(root, "s01");
  mkdirSync(s0, { recursive: true });
  mkdirSync(s1, { recursive: true });
  const pointer = join(root, "current-segment");
  writeFileSync(pointer, `${s0}\n`);

  const previous = process.env.ERIS_RUN_DIR_POINTER;
  process.env.ERIS_RUN_DIR_POINTER = pointer;
  try {
    const append = createJsonlAppender(s0, "house-arb");
    append({ round: 1 });

    // The coordinator rolls: same process, new directory.
    writeFileSync(pointer, `${s1}\n`);
    append({ round: 2 });

    const first = lines(join(s0, "agents", "house-arb.jsonl"));
    const second = lines(join(s1, "agents", "house-arb.jsonl"));
    assert.deepEqual(first.map((l) => l.round), [1]);
    assert.deepEqual(second.map((l) => l.round), [2], "the line after the roll belongs to the new segment");
  } finally {
    if (previous === undefined) delete process.env.ERIS_RUN_DIR_POINTER;
    else process.env.ERIS_RUN_DIR_POINTER = previous;
  }
});

test("without a pointer the log stays where the process was told to write", () => {
  const root = mkdtempSync(join(tmpdir(), "eris-seg-"));
  mkdirSync(root, { recursive: true });
  const previous = process.env.ERIS_RUN_DIR_POINTER;
  delete process.env.ERIS_RUN_DIR_POINTER;
  try {
    const append = createJsonlAppender(root, "solo");
    append({ round: 7 });
    assert.deepEqual(
      lines(join(root, "agents", "solo.jsonl")).map((l) => l.round),
      [7],
    );
  } finally {
    if (previous !== undefined) process.env.ERIS_RUN_DIR_POINTER = previous;
  }
});

test("an unreadable pointer does not stop the log", () => {
  const root = mkdtempSync(join(tmpdir(), "eris-seg-"));
  mkdirSync(root, { recursive: true });
  const previous = process.env.ERIS_RUN_DIR_POINTER;
  process.env.ERIS_RUN_DIR_POINTER = join(root, "does-not-exist");
  try {
    const append = createJsonlAppender(root, "solo");
    append({ round: 9 });
    assert.deepEqual(
      lines(join(root, "agents", "solo.jsonl")).map((l) => l.round),
      [9],
      "a missing pointer falls back to the directory the process started with",
    );
  } finally {
    if (previous === undefined) delete process.env.ERIS_RUN_DIR_POINTER;
    else process.env.ERIS_RUN_DIR_POINTER = previous;
  }
});
