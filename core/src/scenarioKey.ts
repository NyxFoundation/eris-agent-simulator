// The scenario key (ADR 0027): which key the environment's streams are drawn under.
//
// A key file is YAML with one field, `scenarioKey: <64 lowercase hex>`, the same shape as the
// hidden-set and lottery-seed files, so `npm run competition -- commit <file>` prints its
// commitment. The public set uses the public key (sdk/src/rng.ts, SHA-256("eris-public-v1")); the
// live week and the practice period use an operator secret.
//
// Every environment process installs the key before it draws: the coordinator (or the backtest
// runner that embeds it) and the flow bot, which the coordinator hands the file path and the
// commitment it expects. Agents are never given either.

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  PUBLIC_SCENARIO_KEY_HEX,
  setScenarioKey,
  setScenarioRegime,
} from "@eris/sdk/rng.js";
import { commitmentOf } from "./competition/schedule.js";

export const SCENARIO_KEY_FILE_ENV = "ERIS_SCENARIO_KEY_FILE";
export const SCENARIO_KEY_COMMITMENT_ENV = "ERIS_SCENARIO_KEY_COMMITMENT";
// The regime the streams are named by (issue #186). Travels with the key to the flow bot.
export const SCENARIO_REGIME_ENV = "ERIS_SCENARIO_REGIME";

export type ScenarioKeyRecord = {
  source: "public" | "file";
  // sha256 over the canonical JSON of `{ scenarioKey }`, as `competition commit` prints it.
  commitment: string;
};

export type LoadedScenarioKey = ScenarioKeyRecord & {
  hex: string;
  path?: string;
};

const KEY_HEX = /^[0-9a-f]{64}$/;

export function commitmentOfKey(hex: string): string {
  return commitmentOf({ scenarioKey: hex });
}

export const PUBLIC_SCENARIO_KEY: LoadedScenarioKey = {
  source: "public",
  hex: PUBLIC_SCENARIO_KEY_HEX,
  commitment: commitmentOfKey(PUBLIC_SCENARIO_KEY_HEX),
};

// Parse a key file's text. Only `scenarioKey` is allowed: another field would change what
// `competition commit` hashes without changing the key, and two commitments for one key is how a
// published hash stops matching.
export function parseScenarioKeyFile(
  text: string,
  path = "<key file>",
): string {
  const doc = parseYaml(text) as unknown;
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    throw new Error(`${path}: expected a mapping with one field, scenarioKey`);
  const keys = Object.keys(doc);
  if (keys.length !== 1 || keys[0] !== "scenarioKey")
    throw new Error(
      `${path}: expected exactly one field, scenarioKey (found: ${keys.join(", ") || "none"})`,
    );
  const hex = (doc as { scenarioKey: unknown }).scenarioKey;
  if (typeof hex !== "string" || !KEY_HEX.test(hex))
    throw new Error(
      `${path}: scenarioKey must be 64 lowercase hex characters (32 bytes)`,
    );
  return hex;
}

export function readScenarioKeyFile(path: string): LoadedScenarioKey {
  const abs = resolve(path);
  const hex = parseScenarioKeyFile(readFileSync(abs, "utf8"), abs);
  return { source: "file", hex, path: abs, commitment: commitmentOfKey(hex) };
}

// `public` names the public key explicitly (the backtest refuses an ordered plan without a choice).
// Otherwise a path, or, with nothing given, the env var and then the public key.
export function resolveScenarioKey(
  given?: string,
  env: NodeJS.ProcessEnv = process.env,
): LoadedScenarioKey {
  const choice = given ?? env[SCENARIO_KEY_FILE_ENV];
  if (choice === undefined || choice.trim() === "" || choice === "public")
    return PUBLIC_SCENARIO_KEY;
  return readScenarioKeyFile(choice);
}

let installed: LoadedScenarioKey | null = null;

// Install for every stream constructed from now on in this process.
export function installScenarioKey(key: LoadedScenarioKey): ScenarioKeyRecord {
  setScenarioKey(key.hex);
  installed = key;
  return scenarioKeyRecord(key);
}

// The key a caller installed, or the env's (public when unset), installed now.
export function ensureScenarioKey(): LoadedScenarioKey {
  if (!installed) installScenarioKey(resolveScenarioKey());
  return installed as LoadedScenarioKey;
}

export function scenarioKeyRecord(key: LoadedScenarioKey): ScenarioKeyRecord {
  return { source: key.source, commitment: key.commitment };
}

// Env for an environment child process (the flow bot): where the key is and what it must hash to.
// An empty path means the public key, so a path in the parent's env cannot leak into a child that
// was meant to draw under the public key.
export function scenarioKeyChildEnv(
  key: LoadedScenarioKey,
  regime = "",
): Record<string, string> {
  return {
    [SCENARIO_KEY_FILE_ENV]: key.source === "file" ? (key.path as string) : "",
    [SCENARIO_KEY_COMMITMENT_ENV]: key.commitment,
    [SCENARIO_REGIME_ENV]: regime,
  };
}

// The child's side: install the key its parent named, and refuse to run under any other.
export function installChildScenarioKey(
  env: NodeJS.ProcessEnv = process.env,
): ScenarioKeyRecord {
  const key = resolveScenarioKey(undefined, env);
  const expected = env[SCENARIO_KEY_COMMITMENT_ENV];
  if (expected !== undefined && expected !== "" && expected !== key.commitment)
    throw new Error(
      `scenario key mismatch: the coordinator expects ${expected}, this process loaded ${key.commitment}`,
    );
  setScenarioRegime(env[SCENARIO_REGIME_ENV] ?? "");
  return installScenarioKey(key);
}

// A fresh secret key file (mode 0600; refuses to overwrite). Returns the commitment to publish.
export function writeNewScenarioKeyFile(path: string): string {
  const hex = randomBytes(32).toString("hex");
  writeFileSync(resolve(path), stringifyYaml({ scenarioKey: hex }), {
    mode: 0o600,
    flag: "wx",
  });
  return commitmentOfKey(hex);
}
