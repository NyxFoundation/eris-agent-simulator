// Issue #189: the environment's wallet keys (AUTO agents, flow / whale / launch wallets, victims)
// are derived from a secret no participant has, never from the seed. A participant holding its own
// AUTO key used to be able to search seeds until one reproduced it, and then compute every other
// agent's key and every environment wallet's.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  environmentKey,
  installWalletSecret,
  parseWalletSecretFile,
  readWalletSecretFile,
  resetWalletSecret,
  resolveWalletSecret,
  WALLET_SECRET_FILE_ENV,
  walletKeysRecord,
  writeNewWalletSecretFile,
} from "../core/src/walletKeys.js";

test("by default every process draws its own secret", () => {
  const a = resolveWalletSecret({});
  const b = resolveWalletSecret({});
  assert.equal(a.source, "random");
  assert.notEqual(a.hex, b.hex);
});

test("a key is HMAC-SHA256(secret, [derivation, kind, id]): stable per secret, separated by kind", () => {
  const hex = "ab".repeat(32);
  installWalletSecret({ source: "random", hex });
  try {
    const k = environmentKey("flow", "uniswap:informed");
    assert.equal(k, environmentKey("flow", "uniswap:informed"));
    const expected = createHmac("sha256", Buffer.from(hex, "hex"))
      .update(JSON.stringify(["eris-wallet/v1", "flow", "uniswap:informed"]))
      .digest("hex");
    assert.equal(k, `0x${expected}`);
    // Same id under another kind is another wallet; numeric and string ids name the same one.
    assert.notEqual(environmentKey("agent", "x"), environmentKey("flow", "x"));
    assert.equal(environmentKey("stress-victim", 0), environmentKey("stress-victim", "0"));
    assert.deepEqual(walletKeysRecord(), { derivation: "eris-wallet/v1", source: "random" });
  } finally {
    resetWalletSecret();
  }
});

test("the practice period's file gives every coordinator restart the same keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-wallet-"));
  const path = join(dir, "wallet-secret.yaml");
  writeNewWalletSecretFile(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => writeNewWalletSecretFile(path), /EEXIST/);
  const keys: string[] = [];
  for (let restart = 0; restart < 2; restart++) {
    installWalletSecret(resolveWalletSecret({ [WALLET_SECRET_FILE_ENV]: path }));
    keys.push(environmentKey("agent", "venue-arb"));
  }
  resetWalletSecret();
  assert.equal(keys[0], keys[1]);
  assert.equal(readWalletSecretFile(path).source, "file");
});

test("a scenario key file is not a wallet secret (that key is published after the results)", () => {
  assert.throws(
    () => parseWalletSecretFile(`scenarioKey: ${"00".repeat(32)}\n`),
    /exactly one field, walletSecret/,
  );
  assert.throws(() => parseWalletSecretFile("walletSecret: abc\n"), /64 lowercase hex/);
  assert.equal(parseWalletSecretFile(`walletSecret: ${"0f".repeat(32)}\n`), "0f".repeat(32));
});

// The regression this issue is about: a private key computed from public text plus the seed.
test("no key in core/ is derived from the seed", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk("core/src");
  const offenders = files.filter((f) =>
    /keccak256\(\s*(?:stringToBytes|toBytes)\([^)]*seed/i.test(readFileSync(f, "utf8")),
  );
  assert.deepEqual(offenders, []);
});
