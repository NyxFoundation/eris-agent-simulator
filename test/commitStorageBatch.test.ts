import assert from "node:assert/strict";
import test from "node:test";
import { batchServedInOrder, commitStorageBatch } from "@eris/sdk/chain.js";
import { rpc, startAnvil } from "./helpers/localRpc.js";

// ADR 0011 / PR #287 review: the gated miner's one-request commit, against a real anvil.

const SLOT_OWNER = "0x00000000000000000000000000000000000c0de1";

test("commitStorageBatch writes, mines one block, and returns the head after the mine", async (t) => {
  const url = await startAnvil(t);
  const before = Number(BigInt((await rpc(url, "eth_blockNumber")).body.result as string));
  const value = `0x${"0".repeat(63)}7`;
  const head = await commitStorageBatch(url, [
    { address: SLOT_OWNER, slot: "0x0", value: value as `0x${string}` },
  ]);
  assert.equal(head, before + 1, "the head after the mine, not the one before it");
  const stored = (await rpc(url, "eth_getStorageAt", [SLOT_OWNER, "0x0", `0x${head.toString(16)}`]))
    .body.result as string;
  assert.equal(BigInt(stored), 7n);
});

test("batchServedInOrder measures this anvil and says whether writes land before the mine", async (t) => {
  const url = await startAnvil(t);
  const result = await batchServedInOrder(url, 5, 30);
  assert.equal(result.trials, 5);
  // Every probe is mined on a default anvil too (base fee 1 gwei): a zero-fee probe used to sit in
  // the pool there and read as "mined first" five times out of five.
  assert.equal(result.probesMined, 5);
  // Report rather than pin the order: it is the node's, and the coordinator falls back when it fails.
  t.diagnostic(`anvil applied the writes first in ${result.writeFirst}/5 batches`);
});
