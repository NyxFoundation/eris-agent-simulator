// Which Aave reserves the closer acts on (issue #190). Pure, so the rule is testable without a chain.
//
// Enumerated from `Pool.getReservesList()`, the same source as the coordinator's guard
// (core/src/realtime/aaveReserveGuard.ts), not from vendor/aave/deployments: a closer that read the
// deployment files of some other deploy found nothing listed, exited 0, and left the coordinator
// refusing the run. The deployer is its own package and cannot import the guard, so the set of
// reserves the environment owns is rebuilt here from the same facts: every token in
// deployments.json, plus the LST share token (listed as collateral, kept out of the registry).
import type { Address } from "viem";

export type ReserveDeployments = {
  tokens: Record<string, Address>;
  protocols: Record<string, Record<string, unknown>>;
};

// The reserves the environment owns: the deployer's tokens plus the LST share token.
export function environmentReserveAssets(reg: ReserveDeployments): Set<string> {
  const out = new Set(Object.values(reg.tokens).map((a) => a.toLowerCase()));
  const lst = reg.protocols.lst?.lstToken;
  if (typeof lst === "string") out.add(lst.toLowerCase());
  return out;
}

// Every listed reserve the environment does not own, keyed by the vendor deployment file's name
// when there is one (an unrecognized listing is closed all the same: only POOL_ADMIN can list).
//
// Throws, before anything is sent, when a shared reserve the deployer registered is not in the
// list: then deployments.json does not describe this Pool, and "not ours" would include the shared
// reserves themselves -- freezing those stops the whole venue.
export function vendorReserves(
  listed: readonly Address[],
  reg: ReserveDeployments,
  sharedKeys: readonly string[],
  vendorKeys: ReadonlyMap<string, string>,
): { key: string; asset: Address }[] {
  const listedSet = new Set(listed.map((a) => a.toLowerCase()));
  // The registry has to describe this deploy at all. A shared key it does not carry is ordinary (a
  // deploy without WBTC), but carrying *none* of them is not: `missing` then came out empty, nothing
  // threw, `ours` was the empty set, and every reserve the Pool lists -- the shared ones included --
  // became a target to freeze. deployments.json is gitignored, so an empty or absent one is reachable
  // by moving the repository to another box, or by a deploy that stopped before it wrote.
  if (!sharedKeys.some((k) => reg.tokens[k]))
    throw new Error(
      `[aave] deployments.json records none of the shared reserves (${sharedKeys.join(", ")}), so it ` +
        "does not describe this Pool. Nothing was sent: with no reserve recognized as ours, every " +
        "reserve the Pool lists would be closed, the shared ones included. Re-run the deploy, or " +
        "point at the deployments.json this chain was deployed from.",
    );
  const missing = sharedKeys.filter(
    (k) => reg.tokens[k] && !listedSet.has(reg.tokens[k].toLowerCase()),
  );
  if (missing.length > 0)
    throw new Error(
      `[aave] the Pool does not list the shared reserves ${missing.join(", ")} that ` +
        "deployments.json records, so deployments.json is not this chain's deploy. Nothing was " +
        "sent: closing every reserve that is not in it would close the shared ones too.",
    );
  const ours = environmentReserveAssets(reg);
  return listed
    .filter((a) => !ours.has(a.toLowerCase()))
    .map((asset) => ({ key: vendorKeys.get(asset.toLowerCase()) ?? "unknown", asset }));
}
