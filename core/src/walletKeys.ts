// The private keys of the wallets the environment makes (issue #189): `wallet: AUTO` agents, the
// flow wallets (and the whale and token-launch wallets on the same map), the Aave and Liquity
// victims, and the operator tools' probe accounts.
//
// They used to be keccak256("<label>:<seed>:<id>"). The label is in this repository and a seed is a
// small integer, so an agent holding its own AUTO key could search seeds until one reproduced it, and
// from the seed compute every other agent's key and every environment wallet's. The gateway relays
// any signed transaction, so a key known is an account owned.
//
// Nothing needs them to be reproducible. What ADR 0027 (c) promises to reproduce after the results
// is the scenario (seed + scenario key) and the scoring (read off the chain by address); a realtime
// run is not replayable to the byte in the first place. So the keys are drawn from a secret nobody
// outside the operator has:
//
//   - by default, 32 random bytes made when this process starts and never written anywhere. A run,
//     and a scenario matrix run in one process, keeps one set of addresses; the next process gets
//     new ones.
//   - with ERIS_WALLET_SECRET_FILE, the secret in that file. The practice period needs this and
//     nothing else does: its chain outlives the coordinator, so a restart has to come back to the
//     same resident wallets, flow wallets and the keys handed to participants. The file is never
//     published, not even after the period -- it is not part of anything anyone reproduces.
//
// It is not the scenario key. That one is published after the results (ADR 0027 §3), and keys
// derived from it would become public with it.
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Hex } from "viem";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const WALLET_SECRET_FILE_ENV = "ERIS_WALLET_SECRET_FILE";

// Bumped if the message layout below ever changes, so two layouts cannot share a key.
const DERIVATION = "eris-wallet/v1";
const KEY_HEX = /^[0-9a-f]{64}$/;

export type WalletSecretSource = "random" | "file";
export type WalletSecret = { source: WalletSecretSource; hex: string; path?: string };

/** What a run records about where its wallet keys came from. Never the secret, nor a hash of it. */
export type WalletKeysRecord = { derivation: string; source: WalletSecretSource };

export function parseWalletSecretFile(text: string, path = "<wallet secret file>"): string {
  const doc = parseYaml(text) as unknown;
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    throw new Error(`${path}: expected a mapping with one field, walletSecret`);
  const keys = Object.keys(doc);
  // A scenario key file is refused by name: that key is published after the results.
  if (keys.length !== 1 || keys[0] !== "walletSecret")
    throw new Error(
      `${path}: expected exactly one field, walletSecret (found: ${keys.join(", ") || "none"}). ` +
        "Make one with `npm run competition -- wallet-keygen <out.yaml>`; a scenario key file is not one",
    );
  const hex = (doc as { walletSecret: unknown }).walletSecret;
  if (typeof hex !== "string" || !KEY_HEX.test(hex))
    throw new Error(`${path}: walletSecret must be 64 lowercase hex characters (32 bytes)`);
  return hex;
}

export function readWalletSecretFile(path: string): WalletSecret {
  const abs = resolve(path);
  return { source: "file", hex: parseWalletSecretFile(readFileSync(abs, "utf8"), abs), path: abs };
}

export function resolveWalletSecret(env: NodeJS.ProcessEnv = process.env): WalletSecret {
  const path = env[WALLET_SECRET_FILE_ENV];
  if (path !== undefined && path.trim() !== "") return readWalletSecretFile(path);
  return { source: "random", hex: randomBytes(32).toString("hex") };
}

let installed: WalletSecret | null = null;

/** The secret every key in this process is derived from, resolved on first use. */
export function walletSecret(): WalletSecret {
  if (!installed) installed = resolveWalletSecret();
  return installed;
}

/** Replace the process's secret (tests). */
export function installWalletSecret(secret: WalletSecret): void {
  installed = secret;
}

export function resetWalletSecret(): void {
  installed = null;
}

export function walletKeysRecord(): WalletKeysRecord {
  return { derivation: DERIVATION, source: walletSecret().source };
}

/**
 * The private key of the environment wallet `id` of kind `kind` (`agent`, `flow`, `stress-victim`,
 * ...). Kinds keep the namespaces apart: a flow key `x` and an agent `x` are different wallets.
 */
export function environmentKey(kind: string, id: string | number): Hex {
  const message = JSON.stringify([DERIVATION, kind, String(id)]);
  const mac = createHmac("sha256", Buffer.from(walletSecret().hex, "hex"))
    .update(message)
    .digest("hex");
  return `0x${mac}`;
}

/** A fresh wallet secret file (mode 0600; refuses to overwrite). */
export function writeNewWalletSecretFile(path: string): void {
  writeFileSync(resolve(path), stringifyYaml({ walletSecret: randomBytes(32).toString("hex") }), {
    mode: 0o600,
    flag: "wx",
  });
}
