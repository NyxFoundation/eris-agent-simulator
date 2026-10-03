// The registered field, written out for the RPC gateway's sender check (core/src/realtime/senders.ts).
// The gateway refuses a raw transaction not signed by an address bound to the caller's key; the
// coordinator writes those bindings from the field it accepted, so registering a participant is one
// edit (config/registrations.yaml) rather than two lists that drift.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendersDocument, writeSendersFile } from "../core/src/realtime/senders.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";

test("sendersDocument binds each external agent's address to its participant unit", () => {
  const doc = sendersDocument([
    { id: "alice", address: A, external: true, participant: "team-alice" },
    { id: "alice-2", address: B.toUpperCase().replace("0X", "0x"), external: true, participant: "team-alice" },
    // No `participant`: the agent id is the unit (and the name the key is issued under).
    { id: "bob", address: C, external: true },
    // Run by the coordinator: never passes the gateway, so never listed -- a key named like it must
    // not be able to send from its wallet.
    { id: "arb-bot", address: "0x4444444444444444444444444444444444444444", external: false },
  ]);
  assert.deepEqual(doc.senders, { "team-alice": [A, B], bob: [C] });
});

test("writeSendersFile replaces the file by rename and creates its directory", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "senders-")), "rpc-senders");
  const path = join(dir, "senders.json");
  writeSendersFile(path, sendersDocument([{ id: "bob", address: C, external: true }]));
  writeSendersFile(path, sendersDocument([{ id: "bob", address: A, external: true }]));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).senders, { bob: [A] });
  assert.deepEqual(readdirSync(dir), ["senders.json"], "no temp file left behind");
});

test("run.sendersFile reaches SimConfig from YAML", async () => {
  const { buildSource } = await import("../core/src/runConfig.js");
  const { loadConfig } = await import("../core/src/config.js");
  const source = buildSource({ run: { sendersFile: "runs/rpc-senders/senders.json" } });
  assert.equal(source.ERIS_SENDERS_FILE, "runs/rpc-senders/senders.json");
  assert.equal(loadConfig(source).sendersFile, "runs/rpc-senders/senders.json");
  assert.equal(loadConfig(buildSource({ run: { seed: 1 } })).sendersFile, undefined);
});
