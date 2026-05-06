import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgents, loadConfig } from "../src/config.js";

test("loadConfig falls back to valid Anvil private keys for empty env values", () => {
  const config = loadConfig({
    AGENT0_PRIVATE_KEY: "",
    AGENT1_PRIVATE_KEY: "",
    AGENT2_PRIVATE_KEY: "",
    FLOW_UNINFORMED_PRIVATE_KEY: "",
    FLOW_INFORMED_PRIVATE_KEY: "",
    SETUP_PRIVATE_KEY: ""
  });
  assert.match(config.privateKeys.agent0, /^0x[0-9a-f]{64}$/i);
  assert.match(config.privateKeys.agent1, /^0x[0-9a-f]{64}$/i);
  assert.match(config.privateKeys.agent2, /^0x[0-9a-f]{64}$/i);
});

test("loadAgents rejects duplicate ids", () => {
  const path = writeAgentsFile({
    agents: [
      { id: "same", command: "node", wallet: "AGENT0_PRIVATE_KEY" },
      { id: "same", command: "node", wallet: "AGENT1_PRIVATE_KEY" }
    ]
  });
  assert.throws(() => loadAgents(path), /duplicate agent id/);
});

test("loadAgents rejects unsupported wallet bindings", () => {
  const path = writeAgentsFile({
    agents: [{ id: "bad", command: "node", wallet: "FLOW_INFORMED_PRIVATE_KEY" }]
  });
  assert.throws(() => loadAgents(path), /wallet must be one of/);
});

function writeAgentsFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "eris-config-test-"));
  const path = join(dir, "agents.local.json");
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}
