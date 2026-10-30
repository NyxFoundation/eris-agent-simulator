// Every account the environment signs with during an epoch, in one list.
//
// The list has three readers, and each of them is wrong in its own way about an account it misses:
//
//   - the RPC gateway (RPC_PENDING_SEALED_SENDERS). It answers `eth_getTransactionCount(address,
//     "pending")` as of "latest" for these addresses, because an environment wallet's pending nonce
//     says one block early that the environment has something unmined. That is not "a moment without
//     a direction": the informed flow wallet of a venue trades only when the next block's fair price
//     is more than 30bps from that venue's pool price (core/src/flow/logic.ts), so its bump says the
//     next price lies outside a band around a price everyone can read; every venue's bumps together
//     name the block before a gap; a launch wave wallet bumps only for a token that is not a dud; the
//     whale wallet names the print (and a resend that can be sandwiched). An address left off is a
//     signal left on.
//   - the nonce floor (nonceFloor.ts). A signer it does not raise has its earlier epoch's signed
//     transactions valid again in the next one.
//   - the coordinator's own wallet map. It is built here (deriveFlowWallets) so that a flow wallet
//     the coordinator creates is, by construction, a wallet this list names.
//
// What is not on it, and why, is ENVIRONMENT_KEY_KINDS below; test/environmentWallets.test.ts reads
// every `environmentKey(` call in the repository and fails on a kind that table does not classify,
// or on a signing kind derived anywhere this module does not read.
import type { Address, Hex } from "viem";
import { accountAddress } from "@eris/sdk/chain.js";
import { resolveEnabledProtocolIds } from "@eris/sdk/protocols/registry.js";
import type { FlowKind, FlowWallet } from "@eris/sdk/protocols/types.js";
import type { ProtocolId } from "@eris/sdk/types.js";
import type { SimConfig } from "../config.js";
import { deriveLiquityVictims } from "../liquityVictims.js";
import { deriveStressVictims } from "../stressVictims.js";
import { environmentKey } from "../walletKeys.js";
import { environmentSignerOwners } from "./environmentSigners.js";
import {
  LAUNCH_WALLET_SLOTS,
  launchWalletKey,
  launchWaveWalletKey,
} from "./tokenLaunch.js";
import { deriveVulnPoolWallet } from "./vulnPools.js";
import { WHALE_WALLET_KEY } from "./whale.js";
import { GATEWAY_SEALED_SENDERS_ENV } from "./liveWeek.js";

const FLOW_KINDS: readonly FlowKind[] = ["informed", "uninformed"];

/**
 * The flow map's keys, in the order the coordinator funds and attributes them: an informed and an
 * uninformed wallet per enabled venue, the Aave borrower actors, the whale, and every launch slot's
 * listing and wave wallet. The whale and the launch slots are there in every run, whatever the
 * schedule draws (rules §3.3: a wallet only one regime has names the regime).
 */
export function flowWalletKeys(opts: {
  enabledIds: readonly ProtocolId[];
  aaveFlowActorCount: number;
}): string[] {
  const keys: string[] = [];
  for (const id of opts.enabledIds)
    for (const kind of FLOW_KINDS) keys.push(`${id}:${kind}`);
  // Independent actors at separate addresses so their Aave positions persist side by side.
  if (opts.enabledIds.includes("aave"))
    for (let i = 0; i < opts.aaveFlowActorCount; i++) keys.push(`aave:actor${i}`);
  keys.push(WHALE_WALLET_KEY);
  for (let slot = 0; slot < LAUNCH_WALLET_SLOTS; slot++)
    keys.push(launchWalletKey(slot), launchWaveWalletKey(slot));
  return keys;
}

/** The coordinator's flow map: one wallet per flowWalletKeys entry, keyed from the wallet secret. */
export function deriveFlowWallets(opts: {
  enabledIds: readonly ProtocolId[];
  aaveFlowActorCount: number;
}): Map<string, FlowWallet> {
  const map = new Map<string, FlowWallet>();
  for (const key of flowWalletKeys(opts)) {
    const privateKey = environmentKey("flow", key);
    map.set(key, { id: `flow-${key}`, address: accountAddress(privateKey), privateKey });
  }
  return map;
}

/**
 * Every kind `environmentKey` derives, and whether its account signs for the environment while an
 * epoch runs (and so belongs on the sealed list). A kind missing here fails
 * test/environmentWallets.test.ts: whoever adds one decides which it is.
 */
export const ENVIRONMENT_KEY_KINDS = {
  // The flow map: every venue's informed and uninformed flow, the Aave actors, the whale, the launch
  // listing and wave wallets.
  flow: { signs: true },
  // Owns the vuln pool factory and deploys the pools at their windows. In every run.
  "vuln-pools": { signs: true },
  // The victim cohorts. They sign at setup only, before the first scored block; sealed anyway so
  // the list does not depend on reading the setup path.
  "stress-victim": { signs: true },
  "liquity-victim": { signs: true },
  // A `wallet: AUTO` agent: a participant's wallet. Its pending nonce is the participant's own, and
  // the reference runtime seeds its nonce from it (example/agents/runtime/send.ts).
  agent: { signs: false },
  // The canary a period's world record carries (an address that changes with the wallet secret).
  // Never funded, never signs.
  period: { signs: false },
  // A CREATE2 salt for the token launcher, not an account.
  "launch-salt": { signs: false },
  // The operator tools' probe accounts (npm run stress:rpc / check:ordering --live). Run by hand,
  // never inside an epoch, and they allocate nonces through whatever RPC they are pointed at -- the
  // gateway included, where a sealed pending nonce would break them.
  "rpc-stress": { signs: false },
  "rpc-stress-writer": { signs: false },
  "ordering-probe": { signs: false },
} as const satisfies Record<string, { signs: boolean }>;

export type EnvironmentKeyKind = keyof typeof ENVIRONMENT_KEY_KINDS;

/** Where a signer comes from: a role key, the treasury, or a signing environmentKey kind. */
export type EnvironmentSignerKind =
  | "role"
  | "treasury"
  | {
      [K in EnvironmentKeyKind]: (typeof ENVIRONMENT_KEY_KINDS)[K]["signs"] extends true ? K : never;
    }[EnvironmentKeyKind];

export type EnvironmentSigner = {
  /** Lowercase. */
  address: Address;
  kind: EnvironmentSignerKind;
  /** The id the account's transactions carry in blocks.csv (oracle, flow-uniswap:informed, ...). */
  id: string;
};

/** What the signer set depends on: the venues, the actor and victim counts, and the env's keys. */
export type EnvironmentSignerConfig = Pick<
  SimConfig,
  | "enabledProtocols"
  | "aaveFlowActorCount"
  | "stressVictimCount"
  | "stressLiquityVictimCount"
  | "privateKeys"
  | "treasuryPrivateKey"
>;

/**
 * Every account the environment signs with in a run of `config`, under the wallet secret this process
 * has installed (walletKeys.ts). The role keys come from the config (env), the rest from the secret.
 * Agents are not on it: their wallets are the participants'.
 */
export function environmentSigners(
  config: EnvironmentSignerConfig,
  enabledIds: readonly ProtocolId[] = resolveEnabledProtocolIds(config.enabledProtocols),
): EnvironmentSigner[] {
  const out: EnvironmentSigner[] = [];
  const add = (address: Address, kind: EnvironmentSignerKind, id: string): void => {
    out.push({ address: address.toLowerCase() as Address, kind, id });
  };
  for (const [address, owner] of environmentSignerOwners(config.privateKeys))
    add(address as Address, "role", owner.ownerId);
  for (const wallet of deriveFlowWallets({
    enabledIds,
    aaveFlowActorCount: config.aaveFlowActorCount,
  }).values())
    add(wallet.address, "flow", wallet.id);
  add(deriveVulnPoolWallet().address, "vuln-pools", "vuln-pools");
  for (const v of deriveStressVictims(config.stressVictimCount)) add(v.address, "stress-victim", v.id);
  for (const v of deriveLiquityVictims(config.stressLiquityVictimCount))
    add(v.address, "liquity-victim", v.id);
  // Funds and tops up on a chain without cheatcodes (run.chainMode: external). Unused on anvil, and
  // harmless to seal there.
  if (config.treasuryPrivateKey) add(accountAddress(config.treasuryPrivateKey as Hex), "treasury", "treasury");
  return out;
}

/** The distinct addresses of `environmentSigners`, over several configs (a union), sorted. */
export function environmentSignerAddresses(
  configs: Iterable<EnvironmentSignerConfig>,
): Address[] {
  const set = new Set<string>();
  for (const config of configs) for (const s of environmentSigners(config)) set.add(s.address);
  return [...set].sort() as Address[];
}

// The gateway's list as the coordinator is told it (GATEWAY_SEALED_SENDERS_ENV, liveWeek.ts): the
// same value the gateway was started with (RPC_PENDING_SEALED_SENDERS), handed to the coordinator
// alongside. The gateway is another process, often another container, and the list it holds was made
// by someone running `liveWeek.ts sealed-senders` under some wallet secret and some role keys. Nothing
// above can see a list made under the wrong ones -- a rotated secret, a stale `.env`, the four role
// keys from before -- and every wallet it misses leaks its unmined transactions while the run looks
// sealed.

/** The addresses in a sealed-senders value (comma-separated, any case), lowercased. */
export function parseSealedSenders(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The signers the gateway's list does not seal. Containment, not equality: the gateway's list is the
 * union over every regime the week can draw, and one epoch signs with a subset of it.
 */
export function signersNotSealed(
  signers: readonly EnvironmentSigner[],
  sealed: ReadonlySet<string>,
): EnvironmentSigner[] {
  return signers.filter((s) => !sealed.has(s.address));
}

/** What a run records about the gateway's coverage of its signers. Addresses only; never a key. */
export type GatewaySealRecord =
  | { gateway: "unchecked" }
  | { gateway: "covered"; sealed: number }
  | { gateway: "missing"; sealed: number; missing: Array<{ id: string; address: Address }> };

/** Compare this run's signers with the gateway's list from `env`, if one was handed over. */
export function gatewaySealRecord(
  signers: readonly EnvironmentSigner[],
  env: Record<string, string | undefined>,
): GatewaySealRecord {
  const value = env[GATEWAY_SEALED_SENDERS_ENV]?.trim();
  if (!value) return { gateway: "unchecked" };
  const sealed = parseSealedSenders(value);
  const missing = signersNotSealed(signers, sealed);
  return missing.length === 0
    ? { gateway: "covered", sealed: sealed.size }
    : {
        gateway: "missing",
        sealed: sealed.size,
        missing: missing.map((s) => ({ id: s.id, address: s.address })),
      };
}
