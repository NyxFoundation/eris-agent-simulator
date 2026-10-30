// The registry's discovery backlog is fair, and the environment's launch cannot be pushed out.
//
// Before: one pending list sorted by (kind, age), 8 written a block, truncated from the tail past
// 2,048, and probed 64 a sweep first-come. A creator deploying ~150 ten-byte contracts a block that
// answer name/symbol/decimals (a runtime returning [0x20, 0] reads as name "", symbol "", decimals 32)
// filled the `erc20` tier ahead of the launch token -- which sits in the same tier -- delaying its
// publication past the wave or dropping it for good, and the observation's newest-128 window pushed
// whatever did get published out of everybody's view. These pin the queue (environment first,
// round-robin by creator, per-creator caps that drop only the spammer's own entries) on a faked
// chain through sweepMarkets + registerPending, and the observation keeping the environment's
// listings beyond its window.
import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeFunctionData,
  getContractAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { AgentObservation } from "@eris/sdk";
import { TOKENS } from "@eris/sdk/constants.js";
import {
  capByCreator,
  fairOrder,
  MAX_CLASSIFY_PER_SWEEP,
  MAX_PENDING_PER_CREATOR,
  registerPending,
  sweepMarkets,
  type MarketRegistryRuntime,
} from "../core/src/realtime/marketRegistry.js";
import type { RunLogger } from "../core/src/logger.js";
import type { SimContext } from "../sdk/src/protocols/types.js";
import { marketRegistryAbi, REGISTRY_KINDS } from "../sdk/src/marketRegistry.js";
import {
  MarketRegistryWatcher,
  REGISTRY_OBSERVATION_LIMIT,
  REGISTRY_PINNED_LIMIT,
} from "../sdk/src/agentMarkets.js";
import { launchPools } from "../example/agents/lib/launchSwap.js";

const USDC = TOKENS.USDC.address;
const SPAMMER = "0x00000000000000000000000000000000000005a5" as Address;
const HONEST = "0x00000000000000000000000000000000000000a1" as Address;
const LAUNCH_WALLET = "0x000000000000000000000000000000000000001a" as Address;
const FACTORY = "0x00000000000000000000000000000000000000fa" as Address;
const LAUNCHER = "0x000000000000000000000000000000000000001c" as Address;
const LAUNCH_TOKEN = "0x00000000000000000000000000000000000000e1" as Address;
const LAUNCH_POOL = "0x00000000000000000000000000000000000000e2" as Address;
const REGISTRY = "0x0000000000000000000000000000000000000111" as Address;
const LAUNCH_TX = `0x${"7".repeat(64)}` as Hex;

const quiet = { event: () => undefined } as unknown as RunLogger;

// ---------------------------------------------------------------------------
// the ordering and the caps, as pure functions
// ---------------------------------------------------------------------------

type Item = { id: string; creator: string; tier: number };
const item = (id: string, tier = 1): Item => ({ id, creator: id[0], tier });
const ids = (items: Item[]) => items.map((i) => i.id);
const order = (items: Item[]) =>
  fairOrder(items, (i) => i.tier, (i) => i.creator);

test("fairOrder: one item per creator per round, the lower tier first", () => {
  assert.deepEqual(
    ids(order([item("a1"), item("a2"), item("a3"), item("b1"), item("c1"), item("a4"), item("e1", 0)])),
    ["e1", "a1", "b1", "c1", "a2", "a3", "a4"],
  );
  // Creator keys are compared case-insensitively (addresses arrive checksummed and lowercase).
  assert.deepEqual(
    ids(
      fairOrder(
        [
          { id: "x1", creator: "0xAbC", tier: 1 },
          { id: "y1", creator: "0xdef", tier: 1 },
          { id: "x2", creator: "0xabc", tier: 1 },
        ],
        (i) => i.tier,
        (i) => i.creator,
      ),
    ),
    ["x1", "y1", "x2"],
  );
});

test("fairOrder: a backlog drained from the head continues its rotation; a newcomer joins the end", () => {
  const first = order([item("a1"), item("a2"), item("b1"), item("b2"), item("c1"), item("c2")]);
  assert.deepEqual(ids(first), ["a1", "b1", "c1", "a2", "b2", "c2"]);
  // Two written this block; c has not had its turn yet and keeps it.
  const next = order([...first.slice(2), item("d1")]);
  assert.deepEqual(ids(next), ["c1", "a2", "b2", "d1", "c2"]);
});

test("capByCreator: past its share a creator loses its own latest entries, nobody else's", () => {
  const items = order([
    item("a1"), item("a2"), item("a3"), item("a4"), item("a5"), item("b1"), item("e1", 0),
  ]);
  const { kept, dropped } = capByCreator(items, {
    perCreator: 3,
    total: 100,
    creatorOf: (i) => i.creator,
    exempt: (i) => i.tier === 0,
  });
  assert.deepEqual(ids(kept), ["e1", "a1", "b1", "a2", "a3"]);
  assert.deepEqual([...dropped], [["a", 2]]);
});

test("capByCreator: the total backstop cuts whoever has the most, and never an exempt entry", () => {
  const items = order([
    item("a1"), item("a2"), item("a3"), item("b1"), item("b2"), item("b3"), item("c1"),
    item("e1", 0), item("e2", 0),
  ]);
  const cap = (total: number) =>
    capByCreator(items, {
      perCreator: 10,
      total,
      creatorOf: (i) => i.creator,
      exempt: (i) => i.tier === 0,
    });
  const five = cap(5);
  assert.deepEqual(ids(five.kept), ["e1", "e2", "a1", "b1", "c1", "a2", "b2"]);
  assert.deepEqual([...five.dropped].sort(), [["a", 1], ["b", 1]]);
  // A tie at the top: the spare slot goes to the creator earlier in drain order.
  const six = cap(6);
  assert.deepEqual([...six.dropped], [["b", 1]]);
  // The environment's entries survive a total of zero.
  assert.deepEqual(ids(cap(0).kept), ["e1", "e2"]);
});

// ---------------------------------------------------------------------------
// sweepMarkets + registerPending on a faked chain, block by block
// ---------------------------------------------------------------------------

type Create = { from: Address; nonce: number };

function chainFake(opts: { creates: (block: number) => Create[]; launchAt: number }) {
  const published = new Map<number, Array<{ market: string; creator: string; verified: boolean }>>();
  let probesThisSweep = 0;
  const publicClient = {
    getLogs: async (req: { address?: string; fromBlock: bigint; toBlock: bigint }) => {
      const at = BigInt(opts.launchAt);
      if (at < req.fromBlock || at > req.toBlock) return [];
      const a = String(req.address).toLowerCase();
      // One launcher transaction: the factory's PoolCreated and the launcher's Launched.
      if (a === FACTORY.toLowerCase())
        return [
          {
            args: { token0: USDC, token1: LAUNCH_TOKEN, fee: 3000, pool: LAUNCH_POOL },
            transactionHash: LAUNCH_TX,
          },
        ];
      if (a === LAUNCHER.toLowerCase())
        return [{ args: { caller: LAUNCH_WALLET, token: LAUNCH_TOKEN, pool: LAUNCH_POOL } }];
      return [];
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      assert.equal(hash, LAUNCH_TX);
      return { from: LAUNCH_WALLET };
    },
    getCode: async () => "0x6000",
    getBlock: async (req?: { blockNumber?: bigint }) =>
      req?.blockNumber === undefined
        ? { transactions: [], baseFeePerGas: 0n }
        : {
            transactions: opts
              .creates(Number(req.blockNumber))
              .map((tx) => ({ to: null, ...tx })),
          },
    // Every contract here answers the probe the way a 10-byte [0x20, 0] runtime does.
    readContract: async (req: { functionName: string }) => {
      probesThisSweep++;
      return req.functionName === "decimals" ? 32 : "";
    },
  };
  let block = 0;
  const walletClient = {
    sendTransaction: async (req: { data: Hex }) => {
      const { args } = decodeFunctionData({ abi: marketRegistryAbi, data: req.data });
      const entries = (args as unknown as [
        Array<{ market: string; creator: string; verified: boolean }>,
      ])[0];
      published.set(block, entries.map((e) => ({ ...e })));
      return `0x${block.toString(16).padStart(64, "0")}` as Hex;
    },
  };
  const runtime: MarketRegistryRuntime = {
    address: REGISTRY,
    deployBlock: 1,
    uniswapFactory: FACTORY,
    tokenLauncher: LAUNCHER,
    registrarPk: `0x${"1".repeat(64)}`,
    registrarAddress: "0x00000000000000000000000000000000000000d4",
    environmentCreators: new Set([LAUNCH_WALLET.toLowerCase()]),
    pending: [],
    seen: new Set(),
    readFailuresReported: new Set(),
    classifyQueue: [],
    perBlockCap: 8,
  };
  const events: Array<Record<string, unknown>> = [];
  const logger = { event: (e: Record<string, unknown>) => events.push(e) } as unknown as RunLogger;
  const ctx = { publicClient, walletClient } as unknown as SimContext;
  const step = async (b: number) => {
    block = b;
    probesThisSweep = 0;
    await sweepMarkets(ctx, runtime, b, b, new Set(), logger);
    const probed = probesThisSweep / 3;
    await registerPending(ctx, runtime, b, 0n, logger);
    return probed;
  };
  return { runtime, events, published, step };
}

const SPAM_PER_BLOCK = 150; // ~56k gas each under the 10M per-agent block budget

test("a spamming creator cannot delay the environment's listing or an honest creator's token", async () => {
  const honestAt = new Map([
    [12, 0],
    [25, 1],
  ]);
  const created = (b: number): Create[] => [
    ...Array.from({ length: SPAM_PER_BLOCK }, (_, i) => ({
      from: SPAMMER,
      nonce: (b - 10) * SPAM_PER_BLOCK + i,
    })),
    ...(honestAt.has(b) ? [{ from: HONEST, nonce: honestAt.get(b)! }] : []),
  ];
  const { runtime, events, published, step } = chainFake({
    creates: (b) => (b >= 10 && b < 30 ? created(b) : []),
    launchAt: 20,
  });
  for (let b = 10; b < 30; b++) {
    const probed = await step(b);
    assert.ok(probed <= MAX_CLASSIFY_PER_SWEEP, `block ${b} probed ${probed}`);
    const backlog = (list: Array<{ creator: string }>) =>
      list.filter((e) => e.creator.toLowerCase() === SPAMMER.toLowerCase()).length;
    assert.ok(backlog(runtime.classifyQueue) <= MAX_PENDING_PER_CREATOR);
    assert.ok(backlog(runtime.pending) <= MAX_PENDING_PER_CREATOR);
  }

  // The launch: both entries in the write of the block they were found in, ahead of everything.
  const at20 = published.get(20)!.map((e) => e.market.toLowerCase());
  assert.deepEqual(at20.slice(0, 2).sort(), [LAUNCH_POOL, LAUNCH_TOKEN].map((a) => a.toLowerCase()).sort());

  // The honest creator's tokens: probed and written in the block they were deployed.
  const blockOf = (market: Address): number | undefined => {
    for (const [b, entries] of published)
      if (entries.some((e) => e.market.toLowerCase() === market.toLowerCase())) return b;
    return undefined;
  };
  assert.equal(blockOf(getContractAddress({ from: HONEST, nonce: 0n })), 12);
  assert.equal(blockOf(getContractAddress({ from: HONEST, nonce: 1n })), 25);

  // What was dropped was the spammer's, and the drops were reported.
  const drops = events.filter((e) => e.type === "market_registration_dropped");
  assert.ok(drops.length > 0);
  for (const d of drops)
    for (const c of d.byCreator as Array<{ creator: string }>)
      assert.equal(c.creator, SPAMMER.toLowerCase());
  assert.ok(drops.some((d) => d.stage === "classify"));
  assert.ok(drops.some((d) => d.stage === "publish"));
});

// ---------------------------------------------------------------------------
// the observation keeps the environment's listings beyond its window
// ---------------------------------------------------------------------------

const CODE = "0x6000" as Hex;
const CODEHASH = keccak256(CODE);
const kindIndex = (k: (typeof REGISTRY_KINDS)[number]) => REGISTRY_KINDS.indexOf(k);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

type Raw = {
  market: Address;
  kind: number;
  creator: Address;
  token0: Address;
  token1: Address;
  oracle: Address;
  codehash: Hex;
  verified: boolean;
  registeredAtBlock: bigint;
  extra: Hex;
};

let next = 0x1000;
function raw(over: Partial<Raw> & Pick<Raw, "kind" | "creator">): Raw {
  return {
    market: `0x${(next++).toString(16).padStart(40, "0")}` as Address,
    token0: ZERO,
    token1: ZERO,
    oracle: ZERO,
    codehash: CODEHASH,
    verified: false,
    registeredAtBlock: 0n,
    extra: `0x${"00".repeat(32)}`,
    ...over,
  };
}
const spam = (n: number) =>
  Array.from({ length: n }, () => raw({ kind: kindIndex("erc20"), creator: SPAMMER }));
const launchPool = () =>
  raw({
    market: LAUNCH_POOL,
    kind: kindIndex("uniswapV3Pool"),
    creator: LAUNCH_WALLET,
    token0: USDC,
    token1: LAUNCH_TOKEN,
    verified: true,
  });
const launchToken = () =>
  raw({ market: LAUNCH_TOKEN, kind: kindIndex("erc20"), creator: LAUNCH_WALLET, verified: true });

function registryFake(list: Raw[]) {
  const client = {
    getBlockNumber: async () => 100n,
    readContract: async (req: { functionName: string; args?: readonly bigint[] }) => {
      if (req.functionName === "count") return BigInt(list.length);
      if (req.functionName === "entriesFrom") {
        const [start, limit] = req.args!.map(Number);
        return list.slice(start, start + limit).map((e, i) => ({
          ...e,
          registeredAtBlock: BigInt(start + i),
        }));
      }
      throw new Error(`unexpected ${req.functionName}`);
    },
    getCode: async () => CODE,
    getLogs: async () => [],
    multicall: async (req: { contracts: unknown[] }) =>
      req.contracts.map(() => ({ status: "failure" })),
  };
  return client as unknown as PublicClient;
}

const asObservation = (registry: unknown) => ({ registry }) as unknown as AgentObservation;

test("the observation keeps the environment's listing however much was published after it", async () => {
  // A participant's own Uniswap pool is `verified` too, and old: it is not pinned.
  const othersPool = raw({
    kind: kindIndex("uniswapV3Pool"),
    creator: SPAMMER,
    token0: USDC,
    token1: "0x00000000000000000000000000000000000000f1",
    verified: true,
  });
  const list = [othersPool, ...spam(3), launchPool(), launchToken(), ...spam(400)];
  const watcher = new MarketRegistryWatcher(REGISTRY, HONEST, 0, new Set());
  const reg = await watcher.observe(registryFake(list), 10);
  assert.equal(reg.error, undefined);
  assert.equal(reg.entries.length, REGISTRY_OBSERVATION_LIMIT + 2);
  assert.equal(reg.dropped, list.length - reg.entries.length);
  const markets = reg.entries.map((e) => e.market.toLowerCase());
  assert.ok(markets.includes(LAUNCH_POOL.toLowerCase()));
  assert.ok(markets.includes(LAUNCH_TOKEN.toLowerCase()));
  assert.ok(!markets.includes(othersPool.market.toLowerCase()));
  // Still newest first, end to end.
  const blocks = reg.entries.map((e) => Number(e.registeredAtBlock));
  assert.deepEqual(blocks, [...blocks].sort((a, b) => b - a));

  const found = launchPools(asObservation(reg), { tokenCodehash: CODEHASH });
  assert.deepEqual(
    found.map((p) => [p.pool.toLowerCase(), p.token.toLowerCase()]),
    [[LAUNCH_POOL.toLowerCase(), LAUNCH_TOKEN.toLowerCase()]],
  );
});

test("a pool published before its token is pinned once the token is read", async () => {
  const list = [launchPool(), ...spam(300)];
  const watcher = new MarketRegistryWatcher(REGISTRY, HONEST, 0, new Set());
  const client = registryFake(list);
  const before = await watcher.observe(client, 10);
  assert.ok(!before.entries.some((e) => e.market.toLowerCase() === LAUNCH_POOL.toLowerCase()));

  list.push(launchToken(), ...spam(200));
  const after = await watcher.observe(client, 11);
  assert.equal(launchPools(asObservation(after)).length, 1);
  assert.equal(after.dropped, list.length - after.entries.length);
});

test("the pinned set is bounded", async () => {
  // More verified tokens than the environment would ever list, all older than the window.
  const list = [
    ...Array.from({ length: REGISTRY_PINNED_LIMIT + 8 }, () =>
      raw({ kind: kindIndex("erc20"), creator: LAUNCH_WALLET, verified: true }),
    ),
    ...spam(REGISTRY_OBSERVATION_LIMIT),
  ];
  const watcher = new MarketRegistryWatcher(REGISTRY, HONEST, 0, new Set());
  const reg = await watcher.observe(registryFake(list), 10);
  assert.equal(reg.entries.length, REGISTRY_OBSERVATION_LIMIT + REGISTRY_PINNED_LIMIT);
  // The newest of them.
  assert.equal(Number(reg.entries.at(-1)!.registeredAtBlock), 8);
});
