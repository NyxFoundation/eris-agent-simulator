// The poc's clean-cross-section pin on a local anvil (`.local-snapshot`), as the deployer sees it.
//
// sdk/src/chain.ts `resetFork` (local mode) reverts the chain to the snapshot id in this file at the
// start of every `sim:realtime` and every `gen:state-dump`. Anything sent to the chain after that
// snapshot was taken is therefore undone by the next run -- which is how `close:aave-vendor` used to
// be undone on a local anvil (issue #190). The format is the poc's: `<genesisHash>:<snapshotId>`,
// and a file whose genesis hash is not this chain's is ignored there, so it is ignored here too.
import { resolve } from "node:path";
import type { Hex } from "viem";
import { ROOT } from "./util.js";

// The poc root: the deployer is a sub-directory of the repo.
const POC_ROOT = resolve(ROOT, "..");

// Where the poc keeps it: `run.localSnapshotFile` (default `.local-snapshot`), relative to the repo
// root. The deployer does not read the poc's YAML, so a non-default path is passed in the env var
// the poc's own config maps that key to.
export function localSnapshotPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolve(POC_ROOT, env.ERIS_LOCAL_SNAPSHOT_FILE ?? ".local-snapshot");
}

// The snapshot id this chain would be reverted to, or undefined when the file is absent, in the old
// bare-id format, or pins another anvil instance (the poc ignores all three).
export function pinnedSnapshotId(
  contents: string | undefined,
  genesisHash: Hex,
): Hex | undefined {
  if (contents === undefined) return undefined;
  const [hash, id] = contents.trim().split(":");
  return hash && id && hash.toLowerCase() === genesisHash.toLowerCase()
    ? (id as Hex)
    : undefined;
}

export function formatLocalSnapshot(genesisHash: Hex, id: Hex): string {
  return `${genesisHash}:${id}`;
}
