// Reading MarketRegistry must not cost more as the list grows.
//
// `createMarket` is permissionless and cheap, and the environment registers up to 8 entries a block,
// so the list's length is anyone's choice. Every agent's observation used to call `all()`, whose
// cost grows with that length (cold storage, forge-measured: 20.9M gas at 1,000 entries, ~29.5M at
// 1,500, out of gas under the 30M call cap at 1,600). Past that every observation failed on every
// block -- for every agent at once.
//
// The client is faked, and `all()` on it fails past 1,500 entries the way the chain does, so a
// regression to it is a failing test rather than a quiet cost.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address, PublicClient } from "viem";
import {
  readRegistryEntries,
  REGISTRY_PAGE_SIZE,
} from "../sdk/src/marketRegistry.js";
import { MarketRegistryWatcher } from "../sdk/src/agentMarkets.js";

const REGISTRY = "0x00000000000000000000000000000000000000aa" as Address;
const AGENT = "0x00000000000000000000000000000000000000bb" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ALL_GAS_LIMIT_ENTRIES = 1_500;

function entry(i: number) {
  const hex = (i + 1).toString(16).padStart(40, "0");
  return {
    market: `0x${hex}` as Address,
    kind: 5,
    creator: AGENT,
    token0: ZERO,
    token1: ZERO,
    oracle: ZERO,
    codehash: `0x${"00".repeat(32)}` as const,
    verified: true,
    registeredAtBlock: 1n,
    extra: `0x${(i + 1).toString(16).padStart(64, "0")}` as const,
  };
}

function fakeChain(initial: number) {
  const state = { n: initial, fail: false };
  const calls: Array<{ fn: string; args?: readonly bigint[] }> = [];
  const client = {
    getBlockNumber: async () => 100n,
    readContract: async (req: { functionName: string; args?: readonly bigint[] }) => {
      calls.push({ fn: req.functionName, args: req.args });
      if (state.fail) throw new Error("connection refused\nmore detail");
      if (req.functionName === "count") return BigInt(state.n);
      if (req.functionName === "all") {
        if (state.n > ALL_GAS_LIMIT_ENTRIES) throw new Error("out of gas");
        return Array.from({ length: state.n }, (_, i) => entry(i));
      }
      if (req.functionName === "entriesFrom") {
        const [start, limit] = req.args!.map(Number);
        const end = Math.min(state.n, start + limit);
        return Array.from({ length: Math.max(0, end - start) }, (_, i) => entry(start + i));
      }
      throw new Error(`unexpected ${req.functionName}`);
    },
    getCode: async () => "0x",
    getLogs: async () => [],
    multicall: async (req: { contracts: unknown[] }) =>
      req.contracts.map(() => ({ status: "failure" })),
  };
  return { state, calls, client: client as unknown as PublicClient };
}

test("the whole list reads past the size where all() runs out of gas", async () => {
  const { calls, client } = fakeChain(3_000);
  const entries = await readRegistryEntries(client, REGISTRY);
  assert.equal(entries.length, 3_000);
  assert.equal(entries[2_999].market, entry(2_999).market);
  assert.ok(!calls.some((c) => c.fn === "all"), "must never call all()");
  for (const c of calls.filter((c) => c.fn === "entriesFrom"))
    assert.ok(Number(c.args![1]) <= REGISTRY_PAGE_SIZE);
});

test("the watcher reads each entry once and only the new ones after that", async () => {
  const { state, calls, client } = fakeChain(2_000);
  const watcher = new MarketRegistryWatcher(REGISTRY, AGENT, 0, new Set());
  const first = await watcher.observe(client, 10);
  assert.equal(first.error, undefined);
  assert.equal(first.entries.length + first.dropped, 2_000);

  calls.length = 0;
  state.n = 2_008;
  const second = await watcher.observe(client, 11);
  const pages = calls.filter((c) => c.fn === "entriesFrom");
  assert.deepEqual(
    pages.map((c) => c.args!.map(Number)),
    [[2_000, REGISTRY_PAGE_SIZE]],
    "one page, starting where the last read ended",
  );
  assert.equal(second.entries[0].market, entry(2_007).market, "newest first");
  assert.equal(second.dropped, 2_008 - second.entries.length);

  calls.length = 0;
  await watcher.observe(client, 12);
  assert.equal(calls.filter((c) => c.fn === "entriesFrom").length, 0, "nothing new, nothing paged");
});

test("a failed registry read returns the last good section flagged, instead of throwing", async () => {
  const { state, client } = fakeChain(5);
  const watcher = new MarketRegistryWatcher(REGISTRY, AGENT, 0, new Set());
  const good = await watcher.observe(client, 10);
  state.fail = true;
  const bad = await watcher.observe(client, 11);
  assert.equal(bad.error, "connection refused");
  assert.deepEqual(bad.entries, good.entries);

  const fresh = new MarketRegistryWatcher(REGISTRY, AGENT, 0, new Set());
  const never = await fresh.observe(client, 11);
  assert.equal(never.error, "connection refused");
  assert.deepEqual(never.entries, []);
});

test("a shorter list (the chain went back) is read again from the start", async () => {
  const { state, client } = fakeChain(300);
  const watcher = new MarketRegistryWatcher(REGISTRY, AGENT, 0, new Set());
  await watcher.observe(client, 10);
  state.n = 3;
  const after = await watcher.observe(client, 11);
  assert.equal(after.entries.length, 3);
  assert.equal(after.dropped, 0);
});
