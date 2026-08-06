// Discovery of tokens nothing in the value computation sums (issue #41).
//
// ERC-20 balances cannot be enumerated, so the scorer finds them from the run window's Transfer
// logs. The filtering is what matters: a false positive turns a correctly-valued holding into a
// scary report, and a false negative is the original silent zero.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { findUnaccountedTokens } from "../core/src/realtime/reconstruct.js";
import { TOKENS, UNISWAP } from "@eris/sdk/constants.js";

const AGENT = "0x00000000000000000000000000000000000a9e17" as Address;
const UNKNOWN = "0x00000000000000000000000000000000000000ff" as Address;
const OTHER = "0x00000000000000000000000000000000000000ee" as Address;
const USDT = "0x00000000000000000000000000000000000000d7" as Address;

const TOPIC = "0x0" as `0x${string}`;
const erc20Log = (address: Address) => ({
  address,
  topics: [TOPIC, TOPIC, TOPIC],
});
// ERC-721 shares Transfer's topic0 but indexes tokenId too.
const erc721Log = (address: Address) => ({
  address,
  topics: [TOPIC, TOPIC, TOPIC, TOPIC],
});

function fakeClient(opts: {
  logs: Array<{ address: Address; topics: `0x${string}`[] }>;
  balances: Record<string, bigint | "fail">;
}) {
  const calls: { multicallContracts: unknown[][] } = { multicallContracts: [] };
  const client = {
    async getLogs() {
      return opts.logs;
    },
    async multicall({ contracts }: { contracts: Array<{ address: Address }> }) {
      calls.multicallContracts.push(contracts);
      return contracts.map((c) => {
        const value = opts.balances[c.address.toLowerCase()];
        return value === "fail" || value === undefined
          ? { status: "failure" as const }
          : { status: "success" as const, result: value };
      });
    },
  };
  return { client, calls };
}

const base = {
  agents: [{ id: "a1", address: AGENT }],
  enabledIds: ["uniswap"] as never,
  activeStables: [TOKENS.USDC.address as Address, USDT],
  fromBlock: 100,
  toBlock: 120,
};

test("findUnaccountedTokens reports a token nothing else sums", async () => {
  const { client } = fakeClient({
    logs: [erc20Log(UNKNOWN)],
    balances: { [UNKNOWN.toLowerCase()]: 12345n },
  });
  const found = await findUnaccountedTokens({
    ...base,
    publicClient: client as never,
  });
  assert.deepEqual(found, [
    {
      agentId: "a1",
      source: "erc20-unaccounted",
      token: UNKNOWN,
      amountRaw: "12345",
    },
  ]);
});

test("findUnaccountedTokens skips tokens the value computation already covers", async () => {
  const { client } = fakeClient({
    logs: [
      erc20Log(TOKENS.WETH.address), // registry base
      erc20Log(TOKENS.WBTC?.address ?? TOKENS.WETH.address), // registry base (local deploy)
      erc20Log(TOKENS.USDC.address), // active stable
      erc20Log(USDT), // active stable
      erc20Log(UNISWAP.nonfungiblePositionManager), // ERC-721, valued as positions
    ],
    balances: { [UNKNOWN.toLowerCase()]: 1n },
  });
  const found = await findUnaccountedTokens({
    ...base,
    publicClient: client as never,
  });
  assert.deepEqual(found, []);
});

test("findUnaccountedTokens ignores ERC-721 transfers", async () => {
  // Same topic0 as ERC-20 Transfer; only the topic count distinguishes them.
  const { client } = fakeClient({
    logs: [erc721Log(UNKNOWN)],
    balances: { [UNKNOWN.toLowerCase()]: 999n },
  });
  const found = await findUnaccountedTokens({
    ...base,
    publicClient: client as never,
  });
  assert.deepEqual(found, []);
});

test("findUnaccountedTokens drops zero balances and failed reads", async () => {
  const { client } = fakeClient({
    logs: [erc20Log(UNKNOWN), erc20Log(OTHER)],
    balances: { [UNKNOWN.toLowerCase()]: 0n, [OTHER.toLowerCase()]: "fail" },
  });
  const found = await findUnaccountedTokens({
    ...base,
    publicClient: client as never,
  });
  assert.deepEqual(found, []);
});

test("findUnaccountedTokens reads each token once per agent", async () => {
  const { client, calls } = fakeClient({
    logs: [erc20Log(UNKNOWN), erc20Log(UNKNOWN), erc20Log(UNKNOWN)],
    balances: { [UNKNOWN.toLowerCase()]: 7n },
  });
  const found = await findUnaccountedTokens({
    ...base,
    publicClient: client as never,
  });
  assert.equal(found.length, 1);
  assert.equal(calls.multicallContracts[0].length, 1);
});

test("findUnaccountedTokens survives a log-scan failure", async () => {
  // Discovery is best-effort: it must never take a run's scoring down with it.
  const client = {
    async getLogs() {
      throw new Error("getLogs unsupported");
    },
    async multicall() {
      throw new Error("should not be reached");
    },
  };
  const found = await findUnaccountedTokens({
    ...base,
    publicClient: client as never,
  });
  assert.deepEqual(found, []);
});
