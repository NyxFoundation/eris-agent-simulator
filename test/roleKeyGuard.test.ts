// A chain participants can send to must not run on keys anyone can know (core/src/realtime/roleKeyGuard.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  checkRoleKeys,
  publicRoleKeys,
  publicTestAddresses,
  type RoleKeys,
} from "../core/src/realtime/roleKeyGuard.js";

const secret = (): RoleKeys => ({
  admin: generatePrivateKey(),
  keeper: generatePrivateKey(),
  setup: generatePrivateKey(),
  deployer: generatePrivateKey(),
});
const privateAdmin = (): Address =>
  privateKeyToAccount(generatePrivateKey()).address;
const ANVIL_0: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

test("the config's default keys are all recognised as public", async () => {
  const { buildSource } = await import("../core/src/runConfig.js");
  const { loadConfig } = await import("../core/src/config.js");
  const keys = loadConfig(buildSource({ run: { seed: 1 } })).privateKeys;
  assert.deepEqual(publicRoleKeys(keys as RoleKeys), [
    "admin",
    "keeper",
    "setup",
    "deployer",
  ]);
});

test("a registrations file on default keys is refused, naming every public key", () => {
  const keys: RoleKeys = {
    admin:
      "0x0a8b0fbd39e39ffbc8f53d98dcd9c7a2e8a53e5ce2fe1d0c7e46a41ec8a1f3d9" as Hex, // not a default
    keeper:
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex, // anvil 1
    setup:
      "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" as Hex, // anvil 9
    deployer:
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex, // anvil 0
  };
  const v = checkRoleKeys({
    keys,
    registrationsFile: "config/registrations.yaml",
    agents: [],
    allowPublic: false,
  });
  assert.equal(v.kind, "refused");
  assert.deepEqual(v.kind === "refused" && v.exposed, [
    "keeper key",
    "setup key",
    "deployer key",
  ]);
});

test("the venues' admin on an anvil test account is refused even with secret keys", () => {
  const v = checkRoleKeys({
    keys: secret(),
    venueAdmin: ANVIL_0,
    registrationsFile: "config/registrations.yaml",
    agents: [],
    allowPublic: false,
  });
  assert.equal(v.kind, "refused");
  assert.match(v.kind === "refused" ? v.exposed.join() : "", /venue admin/);
  assert.ok(publicTestAddresses().has(ANVIL_0.toLowerCase()));
});

test("secret keys and a private venue admin pass", () => {
  const v = checkRoleKeys({
    keys: secret(),
    venueAdmin: privateAdmin(),
    registrationsFile: "config/registrations.yaml",
    agents: [{ external: true }],
    allowPublic: false,
  });
  assert.deepEqual(v, { kind: "ok" });
});

test("nobody else can send: defaults are fine; an external roster entry counts as someone", () => {
  const defaults: RoleKeys = {
    admin:
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
    keeper:
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
    setup:
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
    deployer:
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
  };
  assert.deepEqual(
    checkRoleKeys({
      keys: defaults,
      venueAdmin: ANVIL_0,
      agents: [{}],
      allowPublic: false,
    }),
    {
      kind: "ok",
    },
  );
  assert.equal(
    checkRoleKeys({
      keys: defaults,
      agents: [{ external: true }],
      allowPublic: false,
    }).kind,
    "refused",
  );
});

test("a private rehearsal may run on the defaults when it says so", () => {
  const v = checkRoleKeys({
    keys: {
      ...secret(),
      deployer:
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
    },
    registrationsFile: "config/registrations.yaml",
    agents: [],
    allowPublic: true,
  });
  assert.equal(v.kind, "allowed");
});

test("setup counts only when the market registry runs: a key that signs nothing exposes nothing", () => {
  const keys: RoleKeys = { ...secret(), setup: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" as Hex };
  const base = { keys, registrationsFile: "config/registrations.yaml", agents: [], allowPublic: false };
  assert.deepEqual(checkRoleKeys({ ...base, use: { marketRegistry: false } }), { kind: "ok" });
  assert.equal(checkRoleKeys({ ...base, use: { marketRegistry: true } }).kind, "refused");
});
