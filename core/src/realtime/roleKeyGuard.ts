// Refuse to open a chain to participants while the environment's own keys are public.
//
// The practice devnet's gateway relays eth_sendRawTransaction, so whoever holds a gateway key can
// sign as any account whose private key they know. Four keys matter:
//
//   admin     owns the run's PriceFeed and writes the Aave aggregators -- the fair price every value
//             in the standings is marked at
//   keeper    executes GMX orders
//   setup     the registrar, and the sender of setup transactions
//   deployer  holds the venues' admin roles (Aave POOL_ADMIN, GMX CONFIG_KEEPER, the LST vault's
//             owner, the seeded liquidity)
//
// Their defaults are fine for a chain nobody else can send to and public for any other: anvil's test
// accounts (their keys are printed in anvil's banner) and `keccak256("eris-role:<role>")` (computable
// from this repository). The venues' admin is fixed by the deployment rather than by a key here, so it
// is checked against the addresses of anvil's test accounts too (issue #74 is the deployer half of
// this; a chain restored from a dump deployed on the default mnemonic hands the roles back).
//
// A private rehearsal legitimately runs on the defaults; it says so with ERIS_ALLOW_PUBLIC_ROLE_KEYS=1,
// and the run records that it did.
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { accountAddress } from "@eris/sdk/chain.js";
import { DEFAULT_ANVIL_PRIVATE_KEYS } from "@eris/sdk/constants.js";

export type RoleKeys = { admin: Hex; keeper: Hex; setup: Hex; deployer: Hex };

/** `setup` signs only for the market registry (agentMarkets); a key that signs nothing exposes nothing. */
export type RoleKeyUse = { marketRegistry: boolean };

const ROLES = ["admin", "keeper", "setup", "deployer"] as const;

/** Every private key this repository makes public: anvil's ten test keys and the derived role defaults. */
function publicKeys(): Set<string> {
  const keys = new Set<string>(
    DEFAULT_ANVIL_PRIVATE_KEYS.map((k) => k.toLowerCase()),
  );
  for (const role of ROLES)
    keys.add(keccak256(stringToBytes(`eris-role:${role}`)).toLowerCase());
  return keys;
}

/** The addresses of anvil's test accounts. */
export function publicTestAddresses(): Set<string> {
  return new Set(
    DEFAULT_ANVIL_PRIVATE_KEYS.map((k) =>
      accountAddress(k as Hex).toLowerCase(),
    ),
  );
}

/** Which of the environment's keys anyone can know, by role name. */
export function publicRoleKeys(
  keys: RoleKeys,
  use: RoleKeyUse = { marketRegistry: true },
): string[] {
  const known = publicKeys();
  return ROLES.filter(
    (role) =>
      (role !== "setup" || use.marketRegistry) &&
      known.has(keys[role].toLowerCase()),
  );
}

/**
 * Whether anyone besides the environment can send transactions to this chain: a registrations file,
 * a roster entry run by a participant, or the live week (liveWeek.ts), where every roster entry is a
 * participant's submitted code that the environment launches itself -- none of them `external`, all
 * of them sending through the gateway.
 */
export function participantsCanSend(opts: {
  registrationsFile?: string;
  agents: ReadonlyArray<{ external?: boolean }>;
  liveWeek?: boolean;
}): boolean {
  return (
    opts.liveWeek === true ||
    Boolean(opts.registrationsFile) ||
    opts.agents.some((a) => a.external === true)
  );
}

export type RoleKeyVerdict =
  | { kind: "ok" }
  | { kind: "allowed"; exposed: string[] }
  | { kind: "refused"; exposed: string[] };

/**
 * The decision the coordinator applies at startup. `venueAdmin` is the deployment's admin address
 * (Aave's ACL admin, when Aave is deployed); undefined when the run has no such venue.
 */
export function checkRoleKeys(opts: {
  keys: RoleKeys;
  use?: RoleKeyUse;
  venueAdmin?: Address;
  registrationsFile?: string;
  agents: ReadonlyArray<{ external?: boolean }>;
  liveWeek?: boolean;
  allowPublic: boolean;
}): RoleKeyVerdict {
  if (!participantsCanSend(opts)) return { kind: "ok" };
  const exposed = publicRoleKeys(opts.keys, opts.use).map((r) => `${r} key`);
  if (
    opts.venueAdmin &&
    publicTestAddresses().has(opts.venueAdmin.toLowerCase())
  )
    exposed.push(
      `venue admin ${opts.venueAdmin} (an anvil test account: the deployment was made on the public mnemonic)`,
    );
  if (exposed.length === 0) return { kind: "ok" };
  return opts.allowPublic
    ? { kind: "allowed", exposed }
    : { kind: "refused", exposed };
}

export function refusalMessage(exposed: string[]): string {
  return (
    `participants can send transactions to this chain, and these are public: ${exposed.join("; ")}. ` +
    "Set ADMIN_PRIVATE_KEY / KEEPER_PRIVATE_KEY / SETUP_PRIVATE_KEY to keys made for this period and " +
    "DEPLOYER_PRIVATE_KEY to index 0 of the secret mnemonic the venues were deployed with " +
    '(docs/guide/practice-devnet.md, "The chain\'s own keys"). A private rehearsal may run on the ' +
    "defaults with ERIS_ALLOW_PUBLIC_ROLE_KEYS=1."
  );
}
