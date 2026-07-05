import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/src/config.js";
import {
  buildSource,
  loadRunConfig,
  toEnvString,
} from "../core/src/runConfig.js";

test("toEnvString: normalizes per type into a string loadConfig can read", () => {
  assert.equal(toEnvString(true), "1");
  assert.equal(toEnvString(false), "0");
  assert.equal(toEnvString(42), "42");
  assert.equal(toEnvString("uniswap"), "uniswap");
  // string/number arrays -> CSV
  assert.equal(
    toEnvString(["uniswap", "balancer", "curve"]),
    "uniswap,balancer,curve",
  );
  // object / object array -> JSON
  assert.equal(toEnvString({ a: 1 }), '{"a":1}');
  assert.equal(toEnvString([{ type: "crash" }]), '[{"type":"crash"}]');
  assert.equal(toEnvString(null), "");
  assert.equal(toEnvString(undefined), "");
});

test("buildSource(nested schema) -> loadConfig: reflected in SimConfig", () => {
  const source = buildSource({
    run: {
      seed: 7,
      blocks: 24,
      protocols: ["uniswap", "balancer"],
      economicGas: true,
    },
    funding: { wethWei: "0" },
    agents: [{ id: "x" }], // agents is excluded from source
  });
  // nested keys are mapped to internal env names
  assert.equal(source.SEED, "7");
  assert.equal(source.ERIS_RUN_BLOCKS, "24");
  assert.equal(source.ENABLED_PROTOCOLS, "uniswap,balancer");
  assert.equal(source.ERIS_ECONOMIC_GAS, "1");
  assert.equal(source.INITIAL_WETH_WEI, "0");
  assert.equal("agents" in source, false);

  const config = loadConfig(source);
  assert.equal(config.seed, 7);
  assert.equal(config.runBlocks, 24);
  assert.deepEqual(config.enabledProtocols, ["uniswap", "balancer"]);
  assert.equal(config.economicGas, true);
  assert.equal(config.initialWethWei, 0n);
});

test("buildSource: expands the per-base map into <prefix>_<SYM>_<unit> (WETH=WEI)", () => {
  // WETH is in the fork default registry, so the unit suffix (WEI) can be derived.
  const source = buildSource({ funding: { base: { WETH: "5" } } });
  assert.equal(source.INITIAL_WETH_WEI, "5");
});

test("buildSource: for backward compatibility, uppercase keys pass through as env names", () => {
  const source = buildSource({ ENABLED_PROTOCOLS: ["uniswap"] });
  assert.equal(source.ENABLED_PROTOCOLS, "uniswap");
});

test("buildSource: overrides (internal env names) take top priority", () => {
  const source = buildSource({ run: { seed: 1 } }, { SEED: 99 });
  assert.equal(source.SEED, "99");
});

test("buildSource: brings in only secret env from process.env (not config env)", () => {
  const prevRpc = process.env.ARB_RPC_URL;
  const prevBlocks = process.env.ERIS_RUN_BLOCKS;
  process.env.ARB_RPC_URL = "https://secret.example";
  process.env.ERIS_RUN_BLOCKS = "999"; // config env is not mixed into source
  try {
    const source = buildSource({ SEED: 1 });
    assert.equal(source.ARB_RPC_URL, "https://secret.example"); // secrets are brought in
    assert.equal(source.ERIS_RUN_BLOCKS, undefined); // config env is ignored (single YAML source)
  } finally {
    if (prevRpc === undefined) delete process.env.ARB_RPC_URL;
    else process.env.ARB_RPC_URL = prevRpc;
    if (prevBlocks === undefined) delete process.env.ERIS_RUN_BLOCKS;
    else process.env.ERIS_RUN_BLOCKS = prevBlocks;
  }
});

test("loadRunConfig: resolves config + inline roster from a YAML file", () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-yaml-"));
  const path = join(dir, "eris.config.yaml");
  writeFileSync(
    path,
    [
      "run:",
      "  seed: 3",
      "  blocks: 12",
      "  protocols: [uniswap, curve]",
      "agents:",
      "  - id: noop",
      "    command: node",
      "    args: [--import, tsx, examples/agents/noop.ts]",
      "    wallet: AGENT1_PRIVATE_KEY",
      "  - id: arb",
      "    command: node",
      "    args: [--import, tsx, examples/agents/venue-arb.ts]",
      "    wallet: AGENT2_PRIVATE_KEY",
      "",
    ].join("\n"),
  );
  const { config, agents, configPath, source } = loadRunConfig(path);
  assert.equal(config.seed, 3);
  assert.equal(config.runBlocks, 12);
  assert.deepEqual(config.enabledProtocols, ["uniswap", "curve"]);
  assert.equal(configPath, path);
  assert.equal(source.ERIS_CONFIG, path); // config file path propagated to children
  assert.equal(agents.length, 2);
  assert.deepEqual(
    agents.map((a) => a.id),
    ["noop", "arb"],
  );
});

test("loadRunConfig: a nonexistent path is an explicit error", () => {
  assert.throws(() => loadRunConfig("/no/such/eris.config.yaml"), /not found/);
});
