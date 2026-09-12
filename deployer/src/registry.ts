import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";
import { ROOT } from "./util.js";
import { accounts } from "./clients.js";
import { CHAIN_ID, RPC_URL } from "./config.js";

const OUT_DIR = resolve(ROOT, "deployments");
const OUT_FILE = resolve(OUT_DIR, "deployments.json");

export type Deployments = {
  chainId: number;
  rpcUrl: string;
  updatedAt: string;
  tokens: Record<string, Address>;
  protocols: Record<string, Record<string, unknown>>;
  // Who deployed this chain. Written out because consumers used to hardcode anvil's default
  // account 0 for it -- which is only right while the chain runs on the public test mnemonic
  // (issue #74). Aave's ACL admin, the owner of every seeded LP position and the holder of the
  // genesis Trove's eUSD are all this address.
  accounts: { deployer: Address; keeper: Address; trader: Address };
};

function empty(): Deployments {
  return {
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    updatedAt: new Date().toISOString(),
    tokens: {},
    protocols: {},
    accounts: currentAccounts(),
  };
}

let state: Deployments = load();

function load(): Deployments {
  if (existsSync(OUT_FILE)) {
    try {
      return JSON.parse(readFileSync(OUT_FILE, "utf8")) as Deployments;
    } catch {
      /* rebuild if corrupted */
    }
  }
  return empty();
}

export function getRegistry(): Deployments {
  return state;
}

export function setTokens(tokens: Record<string, Address>) {
  state.tokens = { ...state.tokens, ...tokens };
  flush();
}

export function setProtocol(name: string, data: Record<string, unknown>) {
  state.protocols[name] = { ...(state.protocols[name] ?? {}), ...data };
  flush();
}

export function token(key: string): Address {
  const a = state.tokens[key];
  if (!a) throw new Error(`token not in registry: ${key}`);
  return a;
}

function currentAccounts(): Deployments["accounts"] {
  return {
    deployer: accounts.deployer.address,
    keeper: accounts.keeper.address,
    trader: accounts.trader.address,
  };
}

export function flush() {
  mkdirSync(OUT_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  // Rewritten on every flush rather than only on reset: a registry loaded from an older file (or
  // from a run under a different MNEMONIC) would otherwise keep naming accounts that no longer own
  // anything on this chain.
  state.accounts = currentAccounts();
  writeFileSync(OUT_FILE, JSON.stringify(state, null, 2));
}

/** Wipe everything (at the start of a fresh deploy) */
export function reset() {
  state = empty();
  flush();
}
