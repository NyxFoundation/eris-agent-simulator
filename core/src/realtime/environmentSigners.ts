// Every account the environment itself signs with, as blocks.csv owners (issue #212).
//
// Two consumers, one list. blocks.csv labels a mined transaction by its sender, and the
// derived-sender ledger asks whether an address is already known before deciding that an agent's
// wallet funded it. An environment account missing from that list is wrong in both places at once:
// its own transactions go in as `external`, and a single transfer from an agent to it would make
// every one of them that agent's -- the registry writes for the setup key, the stress trades that
// sell and buy back as the environment for the deployer key.
//
// So the list lives here rather than inline, and the test beside it reads the config's own key
// names: a key added to `privateKeys` without a line here is a key nothing attributes.
import { accountAddress } from "@eris/sdk/chain.js";
import type { RoleKeys } from "./roleKeyGuard.js";

export type EnvironmentOwner = { ownerId: string; role: "system" };

// The non-agent, non-flow keys, by the id their transactions carry.
export const ENVIRONMENT_SIGNER_IDS = {
  admin: "oracle",
  keeper: "keeper",
  setup: "setup",
  deployer: "deployer",
} as const;

// Tied to RoleKeys on purpose: the guard that refuses a public role key and the map that attributes
// a role key's transactions have to cover the same four accounts, and the test asserts they do.
export type EnvironmentSignerKey = keyof RoleKeys;

// Lowercase address -> owner. A later, more specific entry may overwrite one of these: a run with
// depeg or liquidity-pull mechanisms relabels the deployer account with the mechanism's own id,
// which is the better answer when it exists. These are the floor under that.
export function environmentSignerOwners(
  privateKeys: RoleKeys,
): Map<string, EnvironmentOwner> {
  const out = new Map<string, EnvironmentOwner>();
  for (const [key, ownerId] of Object.entries(ENVIRONMENT_SIGNER_IDS)) {
    const pk = privateKeys[key as EnvironmentSignerKey];
    if (!pk) continue;
    out.set(accountAddress(pk).toLowerCase(), { ownerId, role: "system" });
  }
  return out;
}
