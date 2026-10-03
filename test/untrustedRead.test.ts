// Reads of participant-deployed code are gas-capped (issue #213).
//
// The chain enforces the cap; what can be pinned without one is that every read of a participant
// address carries it, that no such read rides in a Multicall3 aggregate, that a read which fails is
// a *missing* value rather than a zero or a thrown observation, and that the coordinator says so
// once per address.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getContractAddress, type Address, type PublicClient } from "viem";
import {
  classifyReadError,
  readUntrusted,
  readUntrustedBatch,
  UNTRUSTED_READ_GAS,
  UNTRUSTED_SIMULATION_GAS,
} from "../sdk/src/untrustedRead.js";
import { readOracleOwners } from "../sdk/src/marketRegistry.js";
import { observeLending, readLendingState } from "../sdk/src/protocols/lending.js";
import type { SimContext } from "../sdk/src/protocols/types.js";
import {
  CLASSIFY_ATTEMPTS,
  MAX_CLASSIFY_PER_SWEEP,
  classifyContracts,
  sweepMarkets,
  type MarketRegistryRuntime,
} from "../core/src/realtime/marketRegistry.js";
import type { RunLogger } from "../core/src/logger.js";
import { quoteLaunch, tokenBalance } from "../example/agents/lib/launchSwap.js";

const HONEST = "0x00000000000000000000000000000000000000a1" as Address;
const TRAP = "0x00000000000000000000000000000000000000b2" as Address;
const SINGLETON = "0x00000000000000000000000000000000000000c3" as Address;
const AGENT = "0x00000000000000000000000000000000000000d4" as Address;

type Recorded = {
  via: "readContract" | "multicall" | "simulateContract";
  address: string;
  functionName: string;
  gas?: bigint;
  retryCount?: number;
};

// What anvil 1.7.1 answers through viem for a call that runs out of gas under the cap
// (measured: `{"code":-32603,"message":"EVM error OutOfGas"}`).
function outOfGasError(): Error {
  return Object.assign(new Error("An internal error was received."), {
    name: "ContractFunctionExecutionError",
    details: "EVM error OutOfGas",
  });
}

function revertError(): Error {
  return Object.assign(new Error("The contract function reverted."), {
    name: "ContractFunctionExecutionError",
    details: "execution reverted",
  });
}

// A client whose untrusted targets behave per `behaviour`, recording what every read carried.
function fakeClient(opts: {
  behaviour: (address: string, functionName: string) => unknown;
  recorded: Recorded[];
  multicall?: (contracts: Array<{ address: string; functionName: string }>) => unknown[];
}) {
  return {
    readContract: async (args: {
      address: string;
      functionName: string;
      gas?: bigint;
      requestOptions?: { retryCount?: number };
    }) => {
      opts.recorded.push({
        via: "readContract",
        address: args.address,
        functionName: args.functionName,
        gas: args.gas,
        retryCount: args.requestOptions?.retryCount,
      });
      const out = opts.behaviour(args.address, args.functionName);
      if (out instanceof Error) throw out;
      if (out instanceof Promise) return out;
      return out;
    },
    multicall: async (args: {
      contracts: Array<{ address: string; functionName: string }>;
    }) => {
      for (const c of args.contracts)
        opts.recorded.push({
          via: "multicall",
          address: c.address,
          functionName: c.functionName,
        });
      if (!opts.multicall)
        throw new Error("multicall must not be used for a participant address");
      return opts.multicall(args.contracts).map((result) =>
        result instanceof Error
          ? { status: "failure" as const, error: result }
          : { status: "success" as const, result },
      );
    },
    simulateContract: async (args: {
      address: string;
      functionName: string;
      gas?: bigint;
    }) => {
      opts.recorded.push({
        via: "simulateContract",
        address: args.address,
        functionName: args.functionName,
        gas: args.gas,
      });
      return { result: [1_000n] };
    },
  } as unknown as PublicClient;
}

// ---------------------------------------------------------------------------
// the constant
// ---------------------------------------------------------------------------

test("the untrusted-read cap is the lending singleton's own staticcall budget", () => {
  // `SimpleLending._price` / `_borrowRate` staticcall the creator's oracle and IRM with this much.
  // If the two drift, a price the singleton can read becomes one the observation cannot (or the
  // reverse), and the agent sees a market it can be liquidated in but cannot price.
  const source = readFileSync("contracts/SimpleLending.sol", "utf8");
  const m = source.match(/EXTERNAL_CALL_GAS\s*=\s*([0-9_]+)\s*;/);
  assert.ok(m, "SimpleLending.sol declares EXTERNAL_CALL_GAS");
  assert.equal(UNTRUSTED_READ_GAS, BigInt(m![1].replace(/_/g, "")));
  assert.ok(UNTRUSTED_SIMULATION_GAS > UNTRUSTED_READ_GAS);
});

// ---------------------------------------------------------------------------
// readUntrustedBatch
// ---------------------------------------------------------------------------

test("every untrusted read is one eth_call carrying the gas cap, never a multicall", async () => {
  const recorded: Recorded[] = [];
  const client = fakeClient({
    recorded,
    behaviour: (address) => (address === TRAP ? outOfGasError() : 42n),
  });
  const results = await readUntrustedBatch(client, [
    { address: HONEST, abi: [], functionName: "price" },
    { address: TRAP, abi: [], functionName: "price" },
  ]);
  assert.deepEqual(
    recorded.map((r) => [r.via, r.address, r.gas]),
    [
      ["readContract", HONEST, UNTRUSTED_READ_GAS],
      ["readContract", TRAP, UNTRUSTED_READ_GAS],
    ],
  );
  assert.deepEqual(results[0], { value: 42n });
  assert.equal(results[1].value, undefined);
  assert.equal(results[1].failure, "out-of-gas");
  assert.equal(results[1].message, "EVM error OutOfGas");
  // anvil reports out-of-gas as a JSON-RPC internal error, which viem's transport would retry
  // with backoff (measured ~450 ms per failing read). The answer does not change on a retry.
  assert.ok(recorded.every((r) => r.retryCount === 0));
});

test("a read past the deadline is `timeout`, not a wait on the transport", async () => {
  const recorded: Recorded[] = [];
  const client = fakeClient({
    recorded,
    behaviour: () => new Promise(() => undefined), // never answers
  });
  const t0 = Date.now();
  const read = await readUntrusted(
    client,
    { address: TRAP, abi: [], functionName: "owner" },
    { timeoutMs: 30 },
  );
  assert.ok(Date.now() - t0 < 1_000);
  assert.equal(read.value, undefined);
  assert.equal(read.failure, "timeout");
});

test("the failure kinds: out of gas and revert are told apart, the rest is `error`", () => {
  assert.equal(classifyReadError(outOfGasError()), "out-of-gas");
  assert.equal(classifyReadError(new Error("out of gas")), "out-of-gas");
  assert.equal(classifyReadError(revertError()), "revert");
  assert.equal(
    classifyReadError(
      Object.assign(new Error("returned no data"), {
        name: "ContractFunctionZeroDataError",
      }),
    ),
    "revert",
  );
  assert.equal(classifyReadError(new Error("fetch failed")), "error");
});

// ---------------------------------------------------------------------------
// the sdk readers
// ---------------------------------------------------------------------------

test("readOracleOwners: capped per oracle, and an oracle that cannot answer is absent", async () => {
  const recorded: Recorded[] = [];
  const client = fakeClient({
    recorded,
    behaviour: (address) => (address === TRAP ? outOfGasError() : AGENT),
  });
  const owners = await readOracleOwners(client, [
    HONEST,
    TRAP,
    HONEST, // duplicate: one read
    "0x0000000000000000000000000000000000000000",
  ]);
  assert.deepEqual(owners, { [HONEST]: AGENT });
  assert.ok(!(TRAP in owners), "no zero address stands in for an unreadable owner");
  assert.deepEqual(
    recorded.map((r) => [r.via, r.address, r.functionName, r.gas]),
    [
      ["readContract", HONEST, "owner", UNTRUSTED_READ_GAS],
      ["readContract", TRAP, "owner", UNTRUSTED_READ_GAS],
    ],
  );
});

test("readLendingState: the singleton reads are the venue's, the oracle reads are capped", async () => {
  const idHonest = `0x${"1".repeat(64)}` as `0x${string}`;
  const idTrap = `0x${"2".repeat(64)}` as `0x${string}`;
  const recorded: Recorded[] = [];
  const client = fakeClient({
    recorded,
    behaviour: (address, functionName) => {
      // The ids come from the per-user-safe pair, not from a whole-list getter (issue #212).
      if (address === SINGLETON && functionName === "marketCount") return 2n;
      if (address === TRAP) return outOfGasError();
      return functionName === "price" ? 3_000n * 10n ** 36n : AGENT;
    },
    multicall: (contracts) =>
      contracts.map((c) => {
        // Newest first: index 1 is the market created second.
        if (c.functionName === "marketIdAt")
          return (c as { args?: unknown[] }).args?.[0] === 1n ? idTrap : idHonest;
        if (c.functionName === "market") return [1n, 1n, 0n, 0n, 1n, 0n];
        if (c.functionName === "marketParams") {
          const trap =
            (c as { args?: unknown[] }).args?.[0] === idTrap;
          return [HONEST, HONEST, trap ? TRAP : HONEST, HONEST, 9n * 10n ** 17n];
        }
        // observeLending's per-agent reads on the singleton.
        if (c.functionName === "expectedPosition") return [0n, 0n, 0n];
        if (c.functionName === "isHealthy") return true;
        if (c.functionName === "liquidationIncentiveFactor") return 10n ** 18n;
        return new Error(`unexpected ${c.functionName}`);
      }),
  });
  const ctx = { lending: SINGLETON, publicClient: client } as unknown as SimContext;
  const state = await readLendingState(ctx);

  // Nothing of the singleton's carried a gas cap; nothing of the oracles' went through multicall.
  for (const r of recorded) {
    if (r.address === SINGLETON) assert.equal(r.gas, undefined, `${r.functionName} on the venue`);
    else {
      assert.equal(r.via, "readContract", `${r.functionName} on ${r.address}`);
      assert.equal(r.gas, UNTRUSTED_READ_GAS);
    }
  }
  assert.equal(state.priceById[idHonest], 3_000n * 10n ** 36n);
  assert.equal(state.oracleOwnerById[idHonest], AGENT);
  // The trap's market is still in the observation -- the agent can be liquidated in it -- but
  // without a price and without an owner, and the price is not zero.
  assert.ok(state.marketIds.includes(idTrap));
  assert.ok(!(idTrap in state.priceById));
  assert.ok(!(idTrap in state.oracleOwnerById));

  // And the agent sees the same: the honest market's price, the trap's market with no price field
  // at all -- not "0", which a strategy would read as a price.
  const obs = await observeLending(ctx, state, AGENT);
  const byId = new Map(obs?.markets.map((m) => [m.marketId, m]));
  assert.equal(byId.get(idHonest)?.price, (3_000n * 10n ** 36n).toString());
  assert.ok(byId.has(idTrap));
  assert.ok(!("price" in (byId.get(idTrap) ?? {})));
  assert.equal(byId.get(idTrap)?.oracleOwner, undefined);
});

// ---------------------------------------------------------------------------
// the coordinator's probe
// ---------------------------------------------------------------------------

test("classifyContracts: capped probes; out of gas is a failure, a revert is just not a token", async () => {
  const recorded: Recorded[] = [];
  const VAULT = "0x00000000000000000000000000000000000000e5" as Address;
  const client = fakeClient({
    recorded,
    behaviour: (address, functionName) => {
      if (address === TRAP) return outOfGasError();
      if (address === VAULT) return revertError();
      return functionName === "decimals" ? 18 : "TOKEN";
    },
  });
  const kinds = await classifyContracts(client, [HONEST, TRAP, VAULT]);
  assert.deepEqual(
    kinds.map((k) => [k.kind, k.failure?.failure, k.failure?.functionName]),
    [
      ["erc20", undefined, undefined],
      ["unknown", "out-of-gas", "name"],
      ["unknown", undefined, undefined],
    ],
  );
  assert.equal(recorded.length, 9);
  assert.ok(recorded.every((r) => r.via === "readContract" && r.gas === UNTRUSTED_READ_GAS));
});

test("classifyContracts: a node that does not answer is `timeout`, within the deadline", async () => {
  const client = fakeClient({
    recorded: [],
    behaviour: () => new Promise(() => undefined),
  });
  const t0 = Date.now();
  const [k] = await classifyContracts(client, [TRAP], { timeoutMs: 30 });
  assert.ok(Date.now() - t0 < 1_000);
  assert.equal(k.kind, "unknown");
  assert.equal(k.failure?.failure, "timeout");
});

test("sweepMarkets: an unreadable contract is published as unknown and reported once", async () => {
  const CREATOR = "0x00000000000000000000000000000000000000f6" as Address;
  const trapAddr = getContractAddress({ from: CREATOR, nonce: 7n });
  const honestAddr = getContractAddress({ from: CREATOR, nonce: 8n });
  const recorded: Recorded[] = [];
  const base = fakeClient({
    recorded,
    behaviour: (address, functionName) => {
      if (address.toLowerCase() === trapAddr.toLowerCase()) return outOfGasError();
      return functionName === "decimals" ? 18 : "TOKEN";
    },
  });
  const client = Object.assign(base, {
    getLogs: async () => [],
    getCode: async () => "0x6000",
    getBlock: async () => ({
      transactions: [
        { to: null, from: CREATOR, nonce: 7 },
        { to: null, from: CREATOR, nonce: 8 },
      ],
    }),
  });
  const runtime: MarketRegistryRuntime = {
    address: "0x0000000000000000000000000000000000000111",
    deployBlock: 1,
    lending: SINGLETON,
    uniswapFactory: undefined,
    registrarPk: `0x${"1".repeat(64)}`,
    registrarAddress: AGENT,
    pending: [],
    seen: new Set(),
    readFailuresReported: new Set(),
    classifyQueue: [],
    perBlockCap: 8,
  };
  const events: Array<Record<string, unknown>> = [];
  const logger = { event: (e: Record<string, unknown>) => events.push(e) } as unknown as RunLogger;
  const ctx = { publicClient: client } as unknown as SimContext;

  await sweepMarkets(ctx, runtime, 10, 10, new Set(), logger);
  // Both are published; the one that would not answer is `unknown`.
  assert.deepEqual(
    runtime.pending.map((e) => [e.market.toLowerCase(), e.kind]).sort(),
    [
      [honestAddr.toLowerCase(), "erc20"],
      [trapAddr.toLowerCase(), "unknown"],
    ].sort(),
  );
  const failed = events.filter((e) => e.type === "agent_market_read_failed");
  assert.equal(failed.length, 1);
  assert.equal(String(failed[0].address).toLowerCase(), trapAddr.toLowerCase());
  assert.equal(failed[0].reason, "out-of-gas");
  assert.equal(failed[0].functionName, "name");
  assert.equal(failed[0].gas, Number(UNTRUSTED_READ_GAS));
  // The sweep never stalled on the trap: nothing waited on a transport timeout.
  assert.ok(recorded.every((r) => r.gas === UNTRUSTED_READ_GAS));

  // The same range again: nothing is re-probed, nothing is re-reported.
  await sweepMarkets(ctx, runtime, 10, 10, new Set(), logger);
  assert.equal(events.filter((e) => e.type === "agent_market_read_failed").length, 1);
  assert.equal(runtime.pending.length, 2);
});

function sweepFixture(opts: {
  creator: Address;
  nonces: number[];
  behaviour: (address: string, functionName: string) => unknown;
  recorded: Recorded[];
}) {
  const base = fakeClient({ recorded: opts.recorded, behaviour: opts.behaviour });
  let scanned = false;
  const client = Object.assign(base, {
    getLogs: async () => [],
    getCode: async () => "0x6000",
    // The CREATEs are in the first block scanned and nowhere after, so a contract that is probed
    // again on a later sweep can only have come from the queue.
    getBlock: async () => {
      const transactions = scanned
        ? []
        : opts.nonces.map((nonce) => ({ to: null, from: opts.creator, nonce }));
      scanned = true;
      return { transactions };
    },
  });
  const runtime: MarketRegistryRuntime = {
    address: "0x0000000000000000000000000000000000000111",
    deployBlock: 1,
    lending: SINGLETON,
    uniswapFactory: undefined,
    registrarPk: `0x${"1".repeat(64)}`,
    registrarAddress: AGENT,
    pending: [],
    seen: new Set(),
    readFailuresReported: new Set(),
    classifyQueue: [],
    perBlockCap: 8,
  };
  const events: Array<Record<string, unknown>> = [];
  const logger = { event: (e: Record<string, unknown>) => events.push(e) } as unknown as RunLogger;
  const ctx = { publicClient: client } as unknown as SimContext;
  return { runtime, events, logger, ctx };
}

test("sweepMarkets: a probe the node did not answer is retried, not registered as unknown", async () => {
  const CREATOR = "0x00000000000000000000000000000000000000f7" as Address;
  const token = getContractAddress({ from: CREATOR, nonce: 1n });
  let nodeDown = true;
  const recorded: Recorded[] = [];
  const { runtime, events, logger, ctx } = sweepFixture({
    creator: CREATOR,
    nonces: [1],
    recorded,
    behaviour: (_address, functionName) =>
      nodeDown ? new Error("fetch failed") : functionName === "decimals" ? 18 : "TOKEN",
  });
  await sweepMarkets(ctx, runtime, 10, 10, new Set(), logger);
  assert.equal(runtime.pending.length, 0, "nothing is published on a transport failure");
  assert.equal(runtime.classifyQueue.length, 1);
  assert.equal(events.filter((e) => e.type === "agent_market_read_failed").length, 0);

  nodeDown = false;
  await sweepMarkets(ctx, runtime, 11, 11, new Set(), logger);
  assert.deepEqual(
    runtime.pending.map((e) => [e.market.toLowerCase(), e.kind]),
    [[token.toLowerCase(), "erc20"]],
  );
  assert.equal(runtime.classifyQueue.length, 0);
});

test("sweepMarkets: a node that never answers is published as unknown after the last attempt", async () => {
  const CREATOR = "0x00000000000000000000000000000000000000f8" as Address;
  const { runtime, events, logger, ctx } = sweepFixture({
    creator: CREATOR,
    nonces: [1],
    recorded: [],
    behaviour: () => new Error("fetch failed"),
  });
  for (let b = 10; b < 10 + CLASSIFY_ATTEMPTS; b++)
    await sweepMarkets(ctx, runtime, b, b, new Set(), logger);
  assert.deepEqual(runtime.pending.map((e) => e.kind), ["unknown"]);
  assert.equal(runtime.classifyQueue.length, 0);
  const failed = events.filter((e) => e.type === "agent_market_read_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason, "error");
});

test("sweepMarkets: one sweep probes at most MAX_CLASSIFY_PER_SWEEP contracts; the rest carry", async () => {
  const CREATOR = "0x00000000000000000000000000000000000000f9" as Address;
  const n = MAX_CLASSIFY_PER_SWEEP + 5;
  const recorded: Recorded[] = [];
  const { runtime, logger, ctx } = sweepFixture({
    creator: CREATOR,
    nonces: Array.from({ length: n }, (_, i) => i),
    recorded,
    behaviour: (_address, functionName) => (functionName === "decimals" ? 18 : "TOKEN"),
  });
  await sweepMarkets(ctx, runtime, 10, 10, new Set(), logger);
  assert.equal(recorded.length, MAX_CLASSIFY_PER_SWEEP * 3);
  assert.equal(runtime.pending.length, MAX_CLASSIFY_PER_SWEEP);
  assert.equal(runtime.classifyQueue.length, 5);
  await sweepMarkets(ctx, runtime, 11, 11, new Set(), logger);
  assert.equal(runtime.pending.length, n);
  assert.equal(runtime.classifyQueue.length, 0);
});

// ---------------------------------------------------------------------------
// the launch helpers (example)
// ---------------------------------------------------------------------------

test("launchSwap: a launch token's balance is capped and unreadable is undefined, not zero", async () => {
  const recorded: Recorded[] = [];
  const client = fakeClient({
    recorded,
    behaviour: (address) => (address === TRAP ? outOfGasError() : 5n),
  });
  assert.equal(await tokenBalance(client, HONEST, AGENT), 5n);
  assert.equal(await tokenBalance(client, TRAP, AGENT), undefined);
  assert.ok(recorded.every((r) => r.gas === UNTRUSTED_READ_GAS));
});

test("launchSwap: the quote through the token's transfer carries the simulation cap", async () => {
  const recorded: Recorded[] = [];
  const client = fakeClient({ recorded, behaviour: () => 0n });
  await quoteLaunch(client, { tokenIn: HONEST, tokenOut: TRAP, fee: 3000, amountIn: 1n });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].via, "simulateContract");
  assert.equal(recorded[0].gas, UNTRUSTED_SIMULATION_GAS);
});
