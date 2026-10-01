// Close Aave's own test market on a chain that is already running (issue #190).
//
// A fresh deploy does this itself (deployAaveV3 -> closeVendorTestMarket). This is for a chain
// deployed before that, which cannot simply be redeployed -- the practice devnet keeps its state for
// the whole period. Same function, same key: the deployer (index 0 of MNEMONIC) owns the Faucet and
// is POOL_ADMIN. Points at RPC_URL and reads deployments.json + vendor/aave/deployments like deploy.
// Which reserves it closes comes from Pool.getReservesList() minus the environment's own (every
// token in deployments.json + the LST share token) -- the same set the coordinator's guard checks.
//
//   cd deployer && RPC_URL=http://<node>:8545 npm run close:aave-vendor
//
// On a local anvil the poc has pinned (`.local-snapshot` in the repo root, written by resetFork),
// a close sent on top of the chain is undone by the next `sim:realtime` / `gen:state-dump`: both
// revert to that pin first, and the pin was taken before the close. So when the file pins this
// chain the closer refuses unless told what to do about it:
//
//   cd deployer && npm run close:aave-vendor -- --revert-local-snapshot
//
// reverts to the pin (discarding whatever the last run left -- the next run would discard it too),
// closes there, and re-pins, so the closed state is the clean cross-section from then on. The other
// way out is to delete `.local-snapshot` (the current state becomes the base) or to redeploy. A
// chain without a pin -- the practice devnet, any `chainMode: external` node -- is never reverted.
// A non-default `run.localSnapshotFile` is passed as ERIS_LOCAL_SNAPSHOT_FILE.
//
// Exit codes: 1 when a reserve could not be frozen or deactivated at all (it is still open), or the
// local pin was left in place; 2 when one could only be frozen because a participant still supplies
// or borrows there (it keeps counting); 0 otherwise -- including a reserve frozen over the
// treasury's interest residue alone, which Aave never lets anyone deactivate and which no
// participant holds.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Hex } from "viem";
import { publicClient } from "./clients.js";
import {
  formatLocalSnapshot,
  localSnapshotPath,
  pinnedSnapshotId,
} from "./localSnapshot.js";
import { closeVendorTestMarket } from "./protocols/aave-v3.js";

type AnvilRequest = Parameters<typeof publicClient.request>[0];
const rpc = <T>(method: string, params: unknown[] = []) =>
  publicClient.request({ method, params } as AnvilRequest) as Promise<T>;

const revertPin = process.argv.includes("--revert-local-snapshot");
const pinFile = localSnapshotPath();
const genesisHash = (await publicClient.getBlock({ blockNumber: 0n })).hash;
const pinned = pinnedSnapshotId(
  existsSync(pinFile) ? readFileSync(pinFile, "utf8") : undefined,
  genesisHash,
);

if (pinned && !revertPin) {
  console.error(
    `[aave] ${pinFile} pins this chain (snapshot ${pinned}), and the next sim:realtime / ` +
      "gen:state-dump reverts to it -- to a state from before this close, re-opening every vendor " +
      "reserve. Nothing was sent. Either\n" +
      "  npm run close:aave-vendor -- --revert-local-snapshot   (revert to the pin, close there, re-pin)\n" +
      `or delete ${pinFile} first (the chain as it is now becomes the base), or redeploy.`,
  );
  process.exit(1);
}

if (pinned) {
  const reverted = await rpc<boolean>("evm_revert", [pinned]);
  // The pin was taken with automine off (a run turns it off and never back on), and evm_revert
  // restores the mining mode with the state: without this every close tx waits for a block that
  // never comes.
  await rpc<null>("evm_setAutomine", [true]);
  console.log(
    reverted
      ? `[aave] reverted to the clean cross-section pinned in ${pinFile} (${pinned})`
      : `[aave] the pin in ${pinFile} (${pinned}) no longer exists on this anvil; closing on the ` +
          "current state, which is what the next run would start from anyway",
  );
}

let outcomes: Awaited<ReturnType<typeof closeVendorTestMarket>>;
try {
  outcomes = await closeVendorTestMarket();
} finally {
  // evm_revert consumed the pin; re-take it either way so the file never names a dead snapshot.
  if (pinned) {
    const id = await rpc<Hex>("evm_snapshot");
    writeFileSync(pinFile, formatLocalSnapshot(genesisHash, id));
    console.log(`[aave] re-pinned the clean cross-section in ${pinFile} (${id})`);
  }
}
console.log(JSON.stringify(outcomes, null, 2));
process.exit(
  outcomes.some((o) => o.status === "failed")
    ? 1
    : outcomes.some((o) => o.status === "frozen")
      ? 2
      : 0,
);
