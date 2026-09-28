// Issue #167: every agent of a scenario-matrix epoch is told which epoch it is -- the scheduled
// ordinal s and the schedule's length k (rules §4.4.1) -- in env and as obs.epoch.
import test from "node:test";
import assert from "node:assert/strict";
import {
  epochOrdinalEnv,
  epochOrdinalFromEnv,
  readEpochOrdinal,
} from "../sdk/src/epoch.js";
import { matrixEpochOverrides } from "../core/src/backtest/epochOrdinal.js";
import { Reader } from "../example/agents/runtime/read.js";
import { loadConfig } from "../sdk/src/config.js";
import type { SimContext } from "../sdk/src/protocols/types.js";
import type { AgentObservation } from "../sdk/src/types.js";

test("an ordinal is two integers given together, 1 <= index <= count; neither is no ordinal", () => {
  assert.equal(readEpochOrdinal(undefined, undefined), undefined);
  assert.deepEqual(readEpochOrdinal("3", "40"), { index: 3, count: 40 });
  assert.deepEqual(epochOrdinalFromEnv(epochOrdinalEnv({ index: 40, count: 40 })), { index: 40, count: 40 });
  for (const [i, k] of [["3", undefined], [undefined, "40"], ["0", "40"], ["41", "40"], ["1.5", "40"], ["x", "40"]])
    assert.throws(() => readEpochOrdinal(i, k), /1 <= index <= count/, `${i} / ${k}`);
});

// The matrix runner's loop, as cli/backtest.ts runs it: skip what the stored matrix has, run the rest
// with the overrides of each scenario's own s.
function runsOf(plan: { s: number }[], k: number, complete: Set<number>) {
  return plan.filter((sc) => !complete.has(sc.s)).map((sc) => matrixEpochOverrides(sc.s, k));
}

test("the ordinal is the epoch's scheduled s, never a count of what this invocation ran", () => {
  // A fresh matrix: 1..k.
  assert.deepEqual(
    runsOf([{ s: 1 }, { s: 2 }], 2, new Set()).map((o) => [o.ERIS_EPOCH_INDEX, o.ERIS_EPOCH_COUNT]),
    [["1", "2"], ["2", "2"]],
  );
  // A resume of a 40-epoch schedule where s = 1 and 3 are stored and s = 2 failed: the re-run is
  // epoch 2 of 40, although it is the first thing this invocation runs.
  const resumed = runsOf([{ s: 1 }, { s: 2 }, { s: 3 }, { s: 4 }], 40, new Set([1, 3]));
  assert.deepEqual(resumed.map((o) => o.ERIS_EPOCH_INDEX), ["2", "4"]);
  // A partial rehearsal of a 60-epoch plan that starts at s = 38.
  assert.deepEqual(runsOf([{ s: 38 }, { s: 39 }], 60, new Set())[0], {
    ERIS_RESET_UNIT: "scenario",
    ERIS_EPOCH_INDEX: "38",
    ERIS_EPOCH_COUNT: "60",
  });
});

// The Reader's observation step, driven directly: a snapshot needs a chain, this does not.
function observed(env: Record<string, string | undefined>): AgentObservation {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const reader = new Reader({
      ctx: { config: loadConfig({}) } as unknown as SimContext,
      adapters: [],
      priceFeed: "0x2222222222222222222222222222222222222222",
      address: "0x1111111111111111111111111111111111111111",
      runId: "test",
      extraBaseSymbols: [],
    }) as unknown as { observeEpoch(o: AgentObservation): void };
    const obs = {} as AgentObservation;
    reader.observeEpoch(obs);
    return obs;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("obs.epoch carries the ordinal in a matrix epoch, and is absent anywhere else", () => {
  assert.deepEqual(observed({ ERIS_EPOCH_INDEX: "7", ERIS_EPOCH_COUNT: "40" }).epoch, { index: 7, count: 40 });
  // A single run, a single-regime backtest, the practice period: no ordinal, and no field -- not 1 of 1.
  assert.equal("epoch" in observed({ ERIS_EPOCH_INDEX: undefined, ERIS_EPOCH_COUNT: undefined }), false);
  // Half an ordinal is the environment's bug: left out, and the agent keeps its epoch.
  assert.equal("epoch" in observed({ ERIS_EPOCH_INDEX: "7", ERIS_EPOCH_COUNT: undefined }), false);
});
