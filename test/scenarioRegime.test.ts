// Issue #186: a scenario is (regime, seed), and the regime names every keyed stream alongside the
// seed. Before, only the stress schedule mixed its event list in, so calm#101 and crash#101 drew the
// same price shocks and the same flow.
import test from "node:test";
import assert from "node:assert/strict";
import {
  priceRngForAsset,
  resetScenarioKey,
  resetScenarioRegime,
  Rng,
  setScenarioRegime,
} from "../sdk/src/rng.js";
import { join } from "node:path";
import { isEnvironmentOnlyEnv } from "../core/src/realtime/agentProcess.js";
import { regimeName, resolveRegimePath } from "../core/src/backtest/shared.js";
import {
  installChildScenarioKey,
  PUBLIC_SCENARIO_KEY,
  SCENARIO_REGIME_ENV,
  scenarioKeyChildEnv,
} from "../core/src/scenarioKey.js";

const draws = (rng: Rng, n = 8) => [...Array(n)].map(() => rng.next());

test.afterEach(() => {
  resetScenarioRegime();
  resetScenarioKey();
});

test("two regimes on the same seed draw different price paths and flow", () => {
  setScenarioRegime("calm");
  const calmPrice = draws(priceRngForAsset(101, "WETH"));
  const calmFlow = draws(Rng.fromSeed(101, "flow"));
  setScenarioRegime("crash");
  const crashPrice = draws(priceRngForAsset(101, "WETH"));
  const crashFlow = draws(Rng.fromSeed(101, "flow"));
  assert.notDeepEqual(calmPrice, crashPrice);
  assert.notDeepEqual(calmFlow, crashFlow);
});

test("one regime on one seed is still one world: the draws repeat", () => {
  setScenarioRegime("crash");
  const a = draws(priceRngForAsset(101, "WETH"));
  const b = draws(priceRngForAsset(101, "WETH"));
  assert.deepEqual(a, b);
});

test("no regime is the stream of before: a run that names none draws what it always drew", () => {
  const before = draws(priceRngForAsset(101, "WETH"));
  setScenarioRegime("calm");
  setScenarioRegime("");
  assert.deepEqual(draws(priceRngForAsset(101, "WETH")), before);
});

test("the flow bot takes the regime from the coordinator with the key", () => {
  const env = scenarioKeyChildEnv(PUBLIC_SCENARIO_KEY, "whale");
  assert.equal(env[SCENARIO_REGIME_ENV], "whale");
  setScenarioRegime("whale");
  const coordinator = draws(Rng.fromSeed(7, "flow"));
  resetScenarioRegime();
  installChildScenarioKey({ ...env });
  assert.deepEqual(draws(Rng.fromSeed(7, "flow")), coordinator);
});

test("an agent never gets the regime", () => {
  assert.equal(isEnvironmentOnlyEnv(SCENARIO_REGIME_ENV), true);
});

// Review of #187: a single --regime used the file's basename while a set or plan used the string as
// written, so `config/regimes/calm.yaml` and `calm` named two streams. Every path now takes the name.
test("a regime spelled as a name or as a path is one regime name", () => {
  const root = process.cwd();
  const names = [
    "calm",
    "config/regimes/calm.yaml",
    "./config/regimes/calm.yaml",
    join(root, "config/regimes/calm.yaml"),
  ].map((r) => regimeName(resolveRegimePath(root, r)));
  assert.deepEqual(names, ["calm", "calm", "calm", "calm"]);
  assert.equal(regimeName("/x/y/crash.yml"), "crash");
});
