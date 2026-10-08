// Issue #137: a transaction left unmined in anvil's pool survives evm_revert, and from then on the
// sender's `pending` nonce is one past the orphan while the chain is back at the snapshot's -- the
// next transaction viem signs for that sender is never mined. The local-mode reset empties the
// pool right after the revert, before the clean snapshot is taken, so nothing from the last epoch
// can shadow the next one's nonces.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetFork, setChainMode } from "@eris/sdk/chain.js";

const GENESIS = `0x${"ab".repeat(32)}`;

function stubClient(calls: string[]) {
  return {
    getBlock: async () => ({ hash: GENESIS }),
    request: async ({ method }: { method: string }) => {
      calls.push(method);
      if (method === "evm_snapshot") return "0x7";
      if (method === "evm_revert") return true;
      return null;
    },
    // biome-ignore lint/suspicious/noExplicitAny: the stub only needs these two methods
  } as any;
}

test.afterEach(() => setChainMode("anvil"));

// Runs first: the snapshot id is module state, and the test after this one is the one that reverts.
test("the first reset of a process, with nothing to revert to, still starts from an empty pool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-reset-"));
  const calls: string[] = [];
  await resetFork(stubClient(calls), { localDeploy: true, localSnapshotFile: join(dir, "none") });
  assert.deepEqual(calls, ["anvil_dropAllTransactions", "evm_snapshot"]);
});

test("local reset drops the pool between the revert and the fresh snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-reset-"));
  const file = join(dir, ".snapshot");
  // The id the previous reset took (in-process memory wins over the file, as in a matrix).
  writeFileSync(file, `${GENESIS}:0x3`);
  const calls: string[] = [];
  await resetFork(stubClient(calls), { localDeploy: true, localSnapshotFile: file });
  assert.deepEqual(calls, ["evm_revert", "anvil_dropAllTransactions", "evm_snapshot"]);
});
