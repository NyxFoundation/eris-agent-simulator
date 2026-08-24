// ADR 0020 §1: the world's reset unit is a config axis, and the value has to survive the trip from
// YAML to SimConfig intact -- it is the label a stored run is later grouped by, so a value that
// silently changes on the way through is worse than one that is missing.
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../core/src/config.js";
import { buildSource } from "../core/src/runConfig.js";

test("run.resetUnit: defaults to continuous", () => {
  // The default is backwards compatibility with sim:realtime (one world per run), not a statement
  // about the competition -- ADR 0020 §2 puts the competition in `scenario`, declared explicitly.
  const config = loadConfig(buildSource({ run: { seed: 1 } }));
  assert.equal(config.resetUnit, "continuous");
});

test("run.resetUnit: scenario reaches SimConfig from YAML", () => {
  const source = buildSource({ run: { resetUnit: "scenario" } });
  assert.equal(source.ERIS_RESET_UNIT, "scenario");
  assert.equal(loadConfig(source).resetUnit, "scenario");
});

test("run.resetUnit: an unknown value throws instead of falling back", () => {
  // The failure this prevents: `resetUnitt`/`senario` quietly reading as continuous, so a scenario
  // matrix stamps `continuous` into every summary.json and the cross-run guard has nothing to catch.
  assert.throws(
    () => loadConfig(buildSource({ run: { resetUnit: "senario" } })),
    /run\.resetUnit must be "continuous" or "scenario"/,
  );
});

test("run.resetUnit: a programmatic override wins over the config file", () => {
  // How the scenario-matrix runner declares the mode (core/src/cli/backtest.ts passes
  // ERIS_RESET_UNIT to runRealtimeSimulation). The coordinator's fail-fast relies on this being the
  // only path that can produce `scenario`, so the precedence is part of the contract.
  const config = loadConfig(
    buildSource(
      { run: { resetUnit: "continuous" } },
      { ERIS_RESET_UNIT: "scenario" },
    ),
  );
  assert.equal(config.resetUnit, "scenario");
});
