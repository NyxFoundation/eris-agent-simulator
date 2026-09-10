// The key that deployed the venues is configuration, not a constant (issue #74).
//
// A chain that participants can send transactions to cannot run on anvil's published test mnemonic:
// account 0 of it is the deployer, and the deployer owns every seeded LP position, the eUSD the
// environment sells during a depeg, and each venue's admin role. Redeploying under a secret
// mnemonic moves all of that to an account this repository cannot know, so the stress events that
// trade *as the environment* have to be told which key that is -- and a missing answer must not
// quietly fall back to a key everyone has.
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../sdk/src/config.js";
import { DEFAULT_ANVIL_PRIVATE_KEYS } from "../sdk/src/constants.js";
import { SECRET_ENV_KEYS } from "../sdk/src/runConfig.js";

const ALT_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

test("the deployer key defaults to anvil account 0", () => {
  // ADR 0016 §4: a locally deployed chain runs on the default mnemonic unless someone says
  // otherwise, and every committed regime is calibrated against those addresses.
  assert.equal(
    loadConfig({}).privateKeys.deployer,
    DEFAULT_ANVIL_PRIVATE_KEYS[0],
  );
});

test("DEPLOYER_PRIVATE_KEY names the deployer of a secret-mnemonic chain", () => {
  assert.equal(
    loadConfig({ DEPLOYER_PRIVATE_KEY: ALT_KEY }).privateKeys.deployer,
    ALT_KEY,
  );
});

test("DEPLOYER_PRIVATE_KEY survives YAML config resolution", () => {
  // Run knobs come from YAML and secrets come from .env (ADR 0013). A key that is not on this list
  // is dropped on the way from process.env into the resolved config, so the run would go back to
  // anvil account 0 while .env.local looked correct.
  assert.ok(
    (SECRET_ENV_KEYS as readonly string[]).includes("DEPLOYER_PRIVATE_KEY"),
  );
});
