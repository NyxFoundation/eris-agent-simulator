// One block's observation is read at that block, and one venue's failed read does not cost the block.
//
// Practice devnet, 2026-10-24 onwards: Aave's getUserReserveData(USDC, self) intermittently reverted
// with an arithmetic underflow, and the revert took the whole observation with it, so decide was
// skipped even for strategies that never trade Aave. The read is pinned to the block and retried
// once; failing that, the venue's last good section is served, marked stale.
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, custom, type PublicClient } from "viem";
import type { ProtocolAdapter } from "@eris/sdk/protocols/types.js";
import {
  pinnedClient,
  pinRequest,
} from "../example/agents/runtime/pinnedClient.js";

const { servingLastGood } = await import("../example/agents/runtime/read.js");

const ADDR = "0x1234567890abcdef1234567890abcdef12345678" as const;

test("pinRequest writes the block into state reads at latest or with no block", () => {
  const tag = "0x2a" as const;
  assert.deepEqual(
    pinRequest({ method: "eth_call", params: [{ to: ADDR }, "latest"] }, tag)
      .params,
    [{ to: ADDR }, tag],
  );
  assert.deepEqual(
    pinRequest({ method: "eth_call", params: [{ to: ADDR }] }, tag).params,
    [{ to: ADDR }, tag],
  );
  assert.deepEqual(
    pinRequest({ method: "eth_getStorageAt", params: [ADDR, "0x0"] }, tag)
      .params,
    [ADDR, "0x0", tag],
  );
  assert.deepEqual(
    pinRequest({ method: "eth_getBalance", params: [ADDR, null] }, tag).params,
    [ADDR, tag],
  );
});

test("pinRequest leaves every other tag and method as written", () => {
  const tag = "0x2a" as const;
  for (const args of [
    { method: "eth_call", params: [{ to: ADDR }, "0x10"] },
    { method: "eth_getTransactionCount", params: [ADDR, "pending"] },
    { method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "latest" }] },
    { method: "eth_getBlockByNumber", params: ["latest", false] },
    { method: "eth_estimateGas", params: [{ to: ADDR }, "latest"] },
    { method: "eth_blockNumber", params: [] },
  ])
    assert.equal(pinRequest(args, tag), args);
});

test("pinnedClient pins viem's reads", async () => {
  const seen: { method: string; params: unknown }[] = [];
  const base = createPublicClient({
    batch: { multicall: true },
    transport: custom({
      async request({ method, params }) {
        seen.push({ method, params });
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_getBalance") return "0x0";
        return `0x${"0".repeat(64)}`;
      },
    }),
  }) as PublicClient;
  const client = pinnedClient(base, 42);
  await client.getBalance({ address: ADDR });
  await client.call({ to: ADDR, data: "0x" });
  const reads = seen.filter((r) => r.method !== "eth_chainId");
  assert.equal(reads.length, 2);
  for (const r of reads) assert.equal((r.params as unknown[])[1], "0x2a");
  // An explicit block is the caller's.
  seen.length = 0;
  await client.getBalance({ address: ADDR, blockNumber: 7n });
  assert.equal((seen[0].params as unknown[])[1], "0x7");
});

function adapter(observe: () => Promise<unknown>): ProtocolAdapter {
  return { id: "aave", observe } as unknown as ProtocolAdapter;
}

test("a failed venue read serves the last good section, marked stale", async () => {
  const lastGood = new Map();
  const warnings: string[] = [];
  const warn = (line: string) => void warnings.push(line);
  let fail = false;
  const aave = adapter(async () => {
    if (fail)
      throw new Error(
        "Arithmetic operation resulted in underflow or overflow.\n\nRaw Call Arguments: ...",
      );
    return { healthFactor: "5", supplied: { USDC: "1" } };
  });
  const good = await servingLastGood(aave, 10, lastGood, warn, 0).observe(
    {} as never,
    undefined,
    ADDR,
    1,
  );
  assert.deepEqual(good, { healthFactor: "5", supplied: { USDC: "1" } });
  // The strategy may mutate what it was handed; the stored copy is unaffected.
  (good as { healthFactor: string }).healthFactor = "0";

  fail = true;
  const served = await servingLastGood(aave, 11, lastGood, warn, 0).observe(
    {} as never,
    undefined,
    ADDR,
    1,
  );
  assert.deepEqual(served, {
    healthFactor: "5",
    supplied: { USDC: "1" },
    stale: {
      block: "10",
      error: "Arithmetic operation resulted in underflow or overflow.",
    },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /block 11: aave read failed twice, serving block 10/);
});

test("a read that fails once and succeeds on the retry is this block's, not stale", async () => {
  const lastGood = new Map();
  let calls = 0;
  const aave = adapter(async () => {
    calls += 1;
    if (calls === 1) throw new Error("underflow");
    return { healthFactor: String(calls) };
  });
  const section = await servingLastGood(aave, 5, lastGood, () => {
    throw new Error("no warning expected");
  }, 0).observe({} as never, undefined, ADDR, 1);
  assert.deepEqual(section, { healthFactor: "2" });
  assert.equal(lastGood.get("aave")?.block, 5);
});

test("with no good read yet, the failure still takes the block", async () => {
  const aave = adapter(async () => {
    throw new Error("boom");
  });
  await assert.rejects(
    servingLastGood(aave, 1, new Map(), () => {}, 0).observe(
      {} as never,
      undefined,
      ADDR,
      1,
    ),
    /boom/,
  );
});

test("a venue that reports itself absent forgets its last section", async () => {
  const lastGood = new Map();
  let calls = 0;
  const aave = adapter(async () => {
    calls += 1;
    if (calls === 1) return { healthFactor: "5" };
    if (calls === 2) return undefined;
    throw new Error("boom");
  });
  const wrap = (bn: number) => servingLastGood(aave, bn, lastGood, () => {}, 0);
  await wrap(1).observe({} as never, undefined, ADDR, 1);
  assert.equal(await wrap(2).observe({} as never, undefined, ADDR, 1), undefined);
  await assert.rejects(wrap(3).observe({} as never, undefined, ADDR, 1), /boom/);
});
