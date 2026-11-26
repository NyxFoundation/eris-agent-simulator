// The backtest loads only the inference names from .env.local (core/src/cli/backtest.ts): the file
// is where the README puts OLLAMA_API_KEY, and without the load every keyed revision call of a
// backtest failed with 401. The rest of the file -- deployer and wallet keys -- must stay out.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INFERENCE_ENV_LOCAL, loadEnvLocal } from "../core/src/cli/bootstrapEnv.js";

const ROOT = resolve(import.meta.dirname, "..");

function withEnvFile(body: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "eris-envfile-"));
  try {
    const path = join(dir, "env");
    writeFileSync(path, body);
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadEnvLocal with `only` loads the listed names and nothing else", () => {
  const names = ["ERIS_TEST_ENVFILE_KEEP", "ERIS_TEST_ENVFILE_DROP"];
  for (const n of names) delete process.env[n];
  withEnvFile("ERIS_TEST_ENVFILE_KEEP='a'\nERIS_TEST_ENVFILE_DROP=b\n", (path) => {
    loadEnvLocal(path, ["ERIS_TEST_ENVFILE_KEEP"]);
  });
  assert.equal(process.env.ERIS_TEST_ENVFILE_KEEP, "a");
  assert.equal(process.env.ERIS_TEST_ENVFILE_DROP, undefined);
  for (const n of names) delete process.env[n];
});

test("loadEnvLocal: a value already in the environment wins over the file", () => {
  process.env.ERIS_TEST_ENVFILE_SHELL = "shell";
  withEnvFile("ERIS_TEST_ENVFILE_SHELL=file\n", (path) => {
    loadEnvLocal(path, ["ERIS_TEST_ENVFILE_SHELL"]);
  });
  assert.equal(process.env.ERIS_TEST_ENVFILE_SHELL, "shell");
  delete process.env.ERIS_TEST_ENVFILE_SHELL;
});

test("the inference list carries the backends' keys and no wallet or deployer key", () => {
  assert.ok(INFERENCE_ENV_LOCAL.includes("OLLAMA_API_KEY"));
  assert.ok(INFERENCE_ENV_LOCAL.includes("ANTHROPIC_API_KEY"));
  assert.equal(
    INFERENCE_ENV_LOCAL.filter((n) => n.includes("PRIVATE_KEY")).length,
    0,
  );
});

test("the backtest loads the inference names before reading its flags", () => {
  const src = readFileSync(resolve(ROOT, "core/src/cli/backtest.ts"), "utf8");
  const main = src.indexOf("async function main()");
  const load = src.indexOf("loadEnvLocal(\".env.local\", INFERENCE_ENV_LOCAL)", main);
  const flags = src.indexOf("parseFlags(process.argv)", main);
  assert.ok(main >= 0 && load > main && load < flags);
});
