// The environment's own accounts have to be attributable (issue #212).
//
// blocks.csv labels a mined transaction by its sender, and the derived-sender ledger asks whether
// an address is already known before deciding an agent's wallet funded it. An environment account
// missing from the owner map is wrong twice over: its transactions go in as `external`, and one
// transfer from an agent to it hands that agent everything it ever sent -- the registry writes on
// the setup key, the depeg and liquidity-pull trades on the deployer key.
import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ENVIRONMENT_SIGNER_IDS,
  environmentSignerOwners,
} from "../core/src/realtime/environmentSigners.js";
import { DerivedSenderLedger } from "../core/src/realtime/derivedSenders.js";
import type { RoleKeys } from "../core/src/realtime/roleKeyGuard.js";

const keys = (): RoleKeys => ({
  admin: generatePrivateKey(),
  keeper: generatePrivateKey(),
  setup: generatePrivateKey(),
  deployer: generatePrivateKey(),
});

test("every role key is attributed, by the id its transactions carry", () => {
  const k = keys();
  const owners = environmentSignerOwners(k);
  assert.equal(owners.size, 4, "one entry per role key");
  for (const [role, ownerId] of Object.entries(ENVIRONMENT_SIGNER_IDS)) {
    const address = privateKeyToAccount(k[role as keyof RoleKeys]).address;
    assert.deepEqual(
      owners.get(address.toLowerCase()),
      { ownerId, role: "system" },
      role,
    );
  }
});

test("the ids cover exactly the keys the role-key guard knows about", async () => {
  // Tied together deliberately: a fifth role key added to RoleKeys without a line in
  // ENVIRONMENT_SIGNER_IDS would be guarded against being public and still attributed to nobody.
  const { buildSource } = await import("../core/src/runConfig.js");
  const { loadConfig } = await import("../core/src/config.js");
  const configured = loadConfig(buildSource({ run: { seed: 1 } })).privateKeys;
  for (const role of Object.keys(ENVIRONMENT_SIGNER_IDS))
    assert.ok(role in configured, `${role} is a configured key`);
  assert.deepEqual(Object.keys(ENVIRONMENT_SIGNER_IDS).sort(), [
    "admin",
    "deployer",
    "keeper",
    "setup",
  ]);
});

test("a transfer to an environment account does not make it the agent's sender", () => {
  const k = keys();
  const owners = environmentSignerOwners(k);
  const wallet = "0x00000000000000000000000000000000000000a1";
  const setup = privateKeyToAccount(k.setup).address.toLowerCase();
  const ledger = new DerivedSenderLedger({
    agentOf: (a) => (a === wallet ? "alice" : undefined),
    isKnown: (a) => a === wallet || owners.has(a),
    trackedTokens: () => new Set(),
  });
  ledger.observe(
    {
      hash: "0x1",
      from: wallet,
      to: setup,
      value: 10n ** 18n,
      logs: [],
    } as never,
    "alice",
  );
  assert.equal(
    ledger.senderOf(setup),
    undefined,
    "the registry writer is the environment's, whoever paid it",
  );
  assert.deepEqual(ledger.byOwner(), {});
});
