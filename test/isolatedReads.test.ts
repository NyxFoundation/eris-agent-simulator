// One agent's oversized vault read must not fail or starve anyone else's (isolatedReads.ts).
// Measured on anvil 1.5.1 with a 30M block limit: 9,248 gas per open LST request, 3,250 requests
// past the limit; a raw aggregate3 with the bloated read first and 100 reads after it failed as a
// whole (MemoryOOG), so the read goes alone, capped.
import test from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import {
  readIsolated,
  splitIsolatedReads,
} from "../core/src/realtime/isolatedReads.js";
import {
  LST_ACCOUNT_SUMMARY_GAS,
  lstValuationRun,
} from "../sdk/src/protocols/lst.js";
import type { ValuationContext } from "../sdk/src/protocols/types.js";

const read = (functionName: string, isolatedGas?: bigint) => ({
  address: "0x0000000000000000000000000000000000000001" as const,
  abi: [],
  functionName,
  ...(isolatedGas !== undefined ? { isolatedGas } : {}),
});

test("marked reads bypass the shared multicall and come back in their original places", async () => {
  const contracts = [
    read("latestAnswer"),
    read("accountSummaryAt", 10n),
    read("balanceOf"),
    read("accountSummaryAt", 10n),
  ];
  let shared: string[] = [];
  let alone: string[] = [];
  const out = await splitIsolatedReads(
    contracts,
    async (cs) => {
      shared = cs.map((c) => c.functionName);
      return cs.map((c) => `m:${c.functionName}`);
    },
    async (cs) => {
      alone = cs.map((c) => c.functionName);
      // The attacker's read fails; the other isolated read does not.
      return [undefined, "honest-summary"];
    },
  );
  assert.deepEqual(shared, ["latestAnswer", "balanceOf"]);
  assert.deepEqual(alone, ["accountSummaryAt", "accountSummaryAt"]);
  assert.deepEqual(out, [
    "m:latestAnswer",
    undefined,
    "m:balanceOf",
    "honest-summary",
  ]);
});

test("with no marked read the multicall sees exactly the original batch", async () => {
  const contracts = [read("a"), read("b")];
  let isolatedCalled = false;
  const out = await splitIsolatedReads(
    contracts,
    async (cs) => cs.map((c) => c.functionName),
    async () => {
      isolatedCalled = true;
      return [];
    },
  );
  assert.deepEqual(out, ["a", "b"]);
  assert.equal(isolatedCalled, false);
});

test("an isolated read is one capped eth_call, and its failure is undefined, not a throw", async () => {
  const calls: Array<{ gas?: bigint; blockNumber?: bigint; isolatedGas?: unknown }> = [];
  const client = {
    readContract: async (args: {
      gas?: bigint;
      blockNumber?: bigint;
      args?: readonly unknown[];
      isolatedGas?: unknown;
    }) => {
      calls.push(args);
      if (args.args?.[0] === "attacker")
        throw new Error("EVM error OutOfGas");
      return [1n, 2n, 3n, 4n, 5n, 6n];
    },
  } as unknown as PublicClient;
  const out = await readIsolated(
    client,
    [
      { ...read("accountSummaryAt", LST_ACCOUNT_SUMMARY_GAS), args: ["attacker", 9n] },
      { ...read("accountSummaryAt", LST_ACCOUNT_SUMMARY_GAS), args: ["honest", 9n] },
    ],
    123n,
  );
  assert.equal(out[0], undefined);
  assert.deepEqual(out[1], [1n, 2n, 3n, 4n, 5n, 6n]);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.gas, LST_ACCOUNT_SUMMARY_GAS);
    assert.equal(c.blockNumber, 123n);
    // The marker is the reader's, not the node's.
    assert.equal(c.isolatedGas, undefined);
  }
});

test("the LST valuation marks every per-agent accountSummaryAt as isolated, and nothing else", async () => {
  const deployment = {
    vault: "0x00000000000000000000000000000000000000aa",
    lstToken: "0x00000000000000000000000000000000000000aa",
    pool: "0x00000000000000000000000000000000000000bb",
    asset: "0x00000000000000000000000000000000000000cc",
    poolLstIndex: 1,
  } as never;
  const ctx = {
    blockNumber: 10,
    horizonBlock: 10,
    agents: [
      { id: "a", address: "0x00000000000000000000000000000000000000a1" },
      { id: "b", address: "0x00000000000000000000000000000000000000b1" },
    ],
    activeStables: [],
    fairByBase: () => ({ WETH: 3000 }),
    stablePrices: () => ({}),
  } as unknown as ValuationContext;
  const run = lstValuationRun(deployment, ctx);
  const first = await run.next();
  assert.equal(first.done, false);
  const reads = first.value as Array<{ functionName: string; isolatedGas?: bigint }>;
  for (const r of reads)
    assert.equal(
      r.isolatedGas,
      r.functionName === "accountSummaryAt" ? LST_ACCOUNT_SUMMARY_GAS : undefined,
      r.functionName,
    );
  assert.equal(reads.filter((r) => r.isolatedGas !== undefined).length, 2);
});
