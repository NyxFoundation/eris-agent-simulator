// Rules §4.7.1: the live week is k epochs, run across as many invocations as it takes. `--resume`
// continues one matrix directory rather than opening a new one per invocation, so there is one
// standings.json for the competition. What is pinned: which stored epochs are kept, which are
// re-run, and what makes a stored matrix a *different* competition that must not be appended to.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertResumable,
  mergeStoredResults,
  readStoredMatrix,
} from "../core/src/backtest/resume.js";
import type { ScenarioResult } from "../core/src/backtest/standings.js";

const plan = [
  { s: 1, regime: "calm", seed: 101 },
  { s: 2, regime: "crash", seed: 202 },
  { s: 3, regime: "whale", seed: 303 },
  { s: 4, regime: "depeg", seed: 404 },
];
const done = (s: number, regime: string, seed: number): ScenarioResult => ({
  s,
  regime,
  seed,
  agents: [{ id: "a", pnlUsdc: 1 }],
  runDir: `runs/${regime}-${seed}`,
});

test("complete epochs are kept and skipped; failed and missing ones are re-run", () => {
  const stored: ScenarioResult[] = [
    done(1, "calm", 101),
    // Ran, but the environment produced no summary: §4.4.2's remedy is re-execution, so it is not
    // carried as an invalid epoch -- it is run again.
    { s: 2, regime: "crash", seed: 202, error: "anvil died" },
    done(3, "whale", 303),
    // s=4 was never reached by the first invocation.
  ];
  const merged = mergeStoredResults(plan, stored);
  assert.deepEqual(merged.preloaded, [
    done(1, "calm", 101),
    done(3, "whale", 303),
  ]);
  assert.deepEqual([...merged.complete].sort(), [1, 3]);
  assert.deepEqual(merged.rerun, [2, 4]);
});

test("a stored ordinal that is not the plan's scenario is refused", () => {
  // Same path, different content: appending would rank two schedules as one.
  assert.throws(
    () => mergeStoredResults(plan, [done(2, "whale", 202)]),
    /stored s=2 is whale#202 but the plan says crash#202/,
  );
  assert.throws(
    () => mergeStoredResults(plan, [done(9, "calm", 101)]),
    /stored s=9 .* is not in the current plan/,
  );
  assert.throws(
    () =>
      mergeStoredResults(plan, [done(1, "calm", 101), done(1, "calm", 101)]),
    /s=1 twice/,
  );
});

test("a stored matrix of a different competition is refused, and says what differs", () => {
  const stored = {
    schema: 2,
    scenarioSet: "./config/scenarios/public.yaml",
    k: 40,
    resetUnit: "scenario",
    repeat: 1,
  };
  const current = {
    scenarioSet: "config/scenarios/public.yaml",
    k: 40,
    resetUnit: "scenario",
    repeat: 1,
  };
  // Paths compare resolved, so `./x` and `x` are one set.
  assert.doesNotThrow(() =>
    assertResumable(stored, current, (p) => p.replace(/^\.\//, "")),
  );
  assert.throws(
    () =>
      assertResumable(stored, {
        ...current,
        scenarioSet: "config/scenarios/private.yaml",
      }),
    /scenarioSet: stored/,
  );
  assert.throws(
    () => assertResumable(stored, { ...current, k: 8 }),
    /k: stored 40, now 8/,
  );
  assert.throws(
    () => assertResumable({ ...stored, resetUnit: "continuous" }, current),
    /resetUnit: stored continuous/,
  );
  assert.throws(
    () => assertResumable(stored, { ...current, repeat: 3 }),
    /repeat: stored 1, now 3/,
  );
  // A matrix written before `repeat` was recorded ran with 1, and resumes with 1.
  assert.doesNotThrow(() =>
    assertResumable(
      { ...stored, repeat: undefined, scenarioSet: current.scenarioSet },
      current,
    ),
  );
});

test("readStoredMatrix wants a schema-2 matrix.json in the directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "matrix-resume-"));
  try {
    assert.throws(() => readStoredMatrix(dir), /matrix\.json not found/);
    writeFileSync(
      join(dir, "matrix.json"),
      JSON.stringify({ schema: 1, scenarios: [] }),
    );
    assert.throws(() => readStoredMatrix(dir), /schema 1/);
    writeFileSync(
      join(dir, "matrix.json"),
      JSON.stringify({
        schema: 2,
        createdAt: "2026-11-01T00:00:00.000Z",
        scenarioSet: "x.yaml",
        k: 2,
        resetUnit: "scenario",
        scenarios: [done(1, "calm", 101)],
      }),
    );
    const m = readStoredMatrix(dir);
    assert.equal(m.createdAt, "2026-11-01T00:00:00.000Z");
    assert.equal(m.scenarios?.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
