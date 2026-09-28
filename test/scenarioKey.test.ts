// ADR 0027: the scenario key's file, commitment, and hand-off to the environment's processes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { priceRngForAsset, resetScenarioKey } from "@eris/sdk/rng.js";
import { commitmentOf } from "../core/src/competition/schedule.js";
import {
  installChildScenarioKey,
  parseScenarioKeyFile,
  PUBLIC_SCENARIO_KEY,
  resolveScenarioKey,
  SCENARIO_KEY_COMMITMENT_ENV,
  SCENARIO_KEY_FILE_ENV,
  scenarioKeyChildEnv,
  writeNewScenarioKeyFile,
} from "../core/src/scenarioKey.js";
import { assertResumable } from "../core/src/backtest/resume.js";

const dir = mkdtempSync(join(tmpdir(), "eris-scenario-key-"));
const HEX = "3c".repeat(32);

function keyFile(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

test("a key file's commitment is what `competition commit` prints for it", () => {
  const path = keyFile("k.yaml", `scenarioKey: "${HEX}"\n`);
  const key = resolveScenarioKey(path);
  assert.equal(key.source, "file");
  assert.equal(key.hex, HEX);
  assert.equal(
    key.commitment,
    commitmentOf(parseYaml(readFileSync(path, "utf8"))),
  );
  assert.equal(
    PUBLIC_SCENARIO_KEY.commitment,
    "sha256:5940f4fcac9ac09f1ad6fdb1a34d8fa4ef87862ab5edbc6364020a83c730d8e0",
  );
});

test("a key file holds exactly one 32-byte lowercase hex key", () => {
  assert.throws(
    () => parseScenarioKeyFile(`scenarioKey: "${HEX}"\nsalt: x\n`),
    /exactly one field/,
  );
  assert.throws(
    () => parseScenarioKeyFile(`key: "${HEX}"\n`),
    /exactly one field/,
  );
  assert.throws(
    () => parseScenarioKeyFile(`scenarioKey: "${HEX.toUpperCase()}"\n`),
    /64 lowercase hex/,
  );
  assert.throws(
    () => parseScenarioKeyFile(`scenarioKey: "${HEX.slice(2)}"\n`),
    /64 lowercase hex/,
  );
  assert.throws(() => parseScenarioKeyFile("- a\n"), /mapping/);
});

test("with nothing named the key is the env's, then the public one; `public` names it explicitly", () => {
  const path = keyFile("env.yaml", `scenarioKey: "${HEX}"\n`);
  assert.equal(resolveScenarioKey(undefined, {}).source, "public");
  assert.equal(
    resolveScenarioKey(undefined, { [SCENARIO_KEY_FILE_ENV]: "" }).source,
    "public",
  );
  assert.equal(
    resolveScenarioKey(undefined, { [SCENARIO_KEY_FILE_ENV]: path }).hex,
    HEX,
  );
  assert.equal(
    resolveScenarioKey("public", { [SCENARIO_KEY_FILE_ENV]: path }).source,
    "public",
  );
});

test("the flow bot draws under the coordinator's key, and refuses any other", () => {
  const path = keyFile("child.yaml", `scenarioKey: "${HEX}"\n`);
  const publicDraw = priceRngForAsset(101, "WETH").next();
  try {
    const env = scenarioKeyChildEnv(resolveScenarioKey(path));
    assert.equal(env[SCENARIO_KEY_FILE_ENV], path);
    const record = installChildScenarioKey(env);
    assert.equal(record.source, "file");
    assert.notEqual(priceRngForAsset(101, "WETH").next(), publicDraw);
    // The public key hands an empty path, so a path in the parent's env cannot reach the child.
    assert.equal(
      scenarioKeyChildEnv(PUBLIC_SCENARIO_KEY)[SCENARIO_KEY_FILE_ENV],
      "",
    );
    assert.throws(
      () =>
        installChildScenarioKey({
          [SCENARIO_KEY_FILE_ENV]: path,
          [SCENARIO_KEY_COMMITMENT_ENV]: PUBLIC_SCENARIO_KEY.commitment,
        }),
      /scenario key mismatch/,
    );
  } finally {
    resetScenarioKey();
  }
  assert.equal(priceRngForAsset(101, "WETH").next(), publicDraw);
});

test("keygen writes a fresh key readable only by its owner, and never overwrites one", () => {
  const path = join(dir, "new.yaml");
  const commitment = writeNewScenarioKeyFile(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const key = resolveScenarioKey(path);
  assert.equal(key.commitment, commitment);
  assert.notEqual(key.hex, PUBLIC_SCENARIO_KEY.hex);
  assert.throws(() => writeNewScenarioKeyFile(path), /EEXIST/);
  assert.notEqual(writeNewScenarioKeyFile(join(dir, "other.yaml")), commitment);
});

test("a matrix resumes only under the key it was realized under", () => {
  const target = {
    scenarioSet: "plan.yaml",
    k: 2,
    resetUnit: "scenario",
    repeat: 1,
    scenarioKeyCommitment: "sha256:aa",
  };
  const stored = {
    scenarioSet: "plan.yaml",
    k: 2,
    resetUnit: "scenario",
    repeat: 1,
  };
  assertResumable(
    { ...stored, scenarioKey: { source: "file", commitment: "sha256:aa" } },
    target,
  );
  assert.throws(
    () =>
      assertResumable(
        { ...stored, scenarioKey: { source: "file", commitment: "sha256:bb" } },
        target,
      ),
    /scenarioKey: stored/,
  );
  assert.throws(
    () => assertResumable(stored, target),
    /predates the scenario key/,
  );
});
