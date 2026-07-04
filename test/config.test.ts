import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadAgents,
  loadConfig,
  privateKeyForWalletName,
} from "../core/src/config.js";

test("loadConfig falls back to valid Anvil private keys for empty env values", () => {
  const config = loadConfig({
    AGENT0_PRIVATE_KEY: "",
    AGENT1_PRIVATE_KEY: "",
    AGENT2_PRIVATE_KEY: "",
    FLOW_UNINFORMED_PRIVATE_KEY: "",
    FLOW_INFORMED_PRIVATE_KEY: "",
    SETUP_PRIVATE_KEY: "",
  });
  assert.match(config.privateKeys.agent0, /^0x[0-9a-f]{64}$/i);
  assert.match(config.privateKeys.agent1, /^0x[0-9a-f]{64}$/i);
  assert.match(config.privateKeys.agent2, /^0x[0-9a-f]{64}$/i);
});

test("loadAgents rejects duplicate ids", () => {
  const path = writeAgentsFile({
    agents: [
      { id: "same", command: "node", wallet: "AGENT0_PRIVATE_KEY" },
      { id: "same", command: "node", wallet: "AGENT1_PRIVATE_KEY" },
    ],
  });
  assert.throws(() => loadAgents(path), /duplicate agent id/);
});

test("loadAgents rejects unsupported wallet bindings", () => {
  const path = writeAgentsFile({
    agents: [
      { id: "bad", command: "node", wallet: "FLOW_INFORMED_PRIVATE_KEY" },
    ],
  });
  assert.throws(() => loadAgents(path), /wallet must be one of/);
});

test("loadAgents accepts AGENT3..AGENT6 named wallets", () => {
  const path = writeAgentsFile({
    agents: [
      { id: "a3", command: "node", wallet: "AGENT3_PRIVATE_KEY" },
      { id: "a4", command: "node", wallet: "AGENT4_PRIVATE_KEY" },
      { id: "a5", command: "node", wallet: "AGENT5_PRIVATE_KEY" },
      { id: "a6", command: "node", wallet: "AGENT6_PRIVATE_KEY" },
    ],
  });
  const agents = loadAgents(path);
  assert.equal(agents.length, 4);
  const config = loadConfig({});
  for (const agent of agents) {
    const pk = privateKeyForWalletName(config, agent.wallet, agent.id);
    assert.match(pk, /^0x[0-9a-f]{64}$/i);
  }
});

test("loadAgents rejects reused named wallets", () => {
  const path = writeAgentsFile({
    agents: [
      { id: "first", command: "node", wallet: "AGENT0_PRIVATE_KEY" },
      { id: "second", command: "node", wallet: "AGENT0_PRIVATE_KEY" },
    ],
  });
  assert.throws(() => loadAgents(path), /reuses named wallet/);
});

test("AUTO wallet derives a deterministic key per (seed, agentId)", () => {
  const config = loadConfig({ SEED: "42" });
  const a = privateKeyForWalletName(config, "AUTO", "agent-x");
  const b = privateKeyForWalletName(config, "AUTO", "agent-x");
  const c = privateKeyForWalletName(config, "AUTO", "agent-y");
  const configOtherSeed = loadConfig({ SEED: "43" });
  const d = privateKeyForWalletName(configOtherSeed, "AUTO", "agent-x");
  assert.equal(a, b, "same seed+id → same key");
  assert.notEqual(a, c, "different id → different key");
  assert.notEqual(a, d, "different seed → different key");
  assert.match(a, /^0x[0-9a-f]{64}$/i);
});

test("loadAgents allows multiple AUTO agents with distinct ids", () => {
  const path = writeAgentsFile({
    agents: [
      { id: "auto-1", command: "node", wallet: "AUTO" },
      { id: "auto-2", command: "node", wallet: "AUTO" },
      { id: "auto-3", command: "node", wallet: "AUTO" },
    ],
  });
  const agents = loadAgents(path);
  assert.equal(agents.length, 3);
});

test("loadAgents validates and forwards env field", () => {
  const path = writeAgentsFile({
    agents: [
      {
        id: "with-env",
        command: "node",
        wallet: "AGENT0_PRIVATE_KEY",
        env: { BID_PROFIT_FRACTION: "0.5", FOO: "bar" },
      },
    ],
  });
  const agents = loadAgents(path);
  assert.deepEqual(agents[0].env, { BID_PROFIT_FRACTION: "0.5", FOO: "bar" });
});

test("loadAgents rejects non-string env values", () => {
  const path = writeAgentsFile({
    agents: [
      {
        id: "bad-env",
        command: "node",
        wallet: "AGENT0_PRIVATE_KEY",
        env: { COUNT: 3 },
      },
    ],
  });
  assert.throws(() => loadAgents(path), /env must contain only string/);
});

test("ADR 0015 §6: command 省略のロスターは規約解決前提でそのまま通る", () => {
  const path = writeAgentsFile({
    agents: [
      { id: "arb-bot", wallet: "AGENT1_PRIVATE_KEY" },
      { id: "my-arb", wallet: "AUTO", description: "prompt agent" },
    ],
  });
  const agents = loadAgents(path);
  assert.equal(agents.length, 2);
  assert.equal(agents[0].command, undefined);
  assert.equal(agents[0].args, undefined);
});

test("ADR 0015 §6: args だけの指定（command 無し）は拒否する", () => {
  const path = writeAgentsFile({
    agents: [{ id: "bad", args: ["x.ts"], wallet: "AGENT1_PRIVATE_KEY" }],
  });
  assert.throws(() => loadAgents(path), /args requires an explicit command/);
});

function writeAgentsFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "eris-config-test-"));
  const path = join(dir, "agents.local.json");
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}
