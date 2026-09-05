// Environment-side discovery and publication of agent-created markets (issue #40 T2).
//
// The environment watches for contracts agents deploy and publishes what it finds to
// `contracts/MarketRegistry.sol`, the second instance of the PriceFeed pattern. Three responsibilities:
//
//   1. deployAgentMarketVenues — setup: deploy the registry and the permissionless lending singleton.
//   2. sweepMarkets            — every block: factory logs + a top-level CREATE scan, classified,
//                               capped per block with the overflow carried into the next one.
//   3. registerPending         — every block: one batched `register` write from a dedicated key.
//
// **Discovery is log-first and misses are accepted.** Uniswap V3 `PoolCreated`, the lending
// singleton's `CreateMarket`, plus a scan of each block's transactions for `to === null`. CREATE /
// CREATE2 from *inside* a contract is not covered. The miss is symmetric and that is why it is
// tolerable: a contract nobody can see cannot bait anybody either.
//
// **The write is not on the admin key.** The oracle update sends from admin every block, and two
// concurrent senders on one key race on the nonce — anvil drops the loser as "replacement
// transaction underpriced", which is how the LST redemption rate once froze for a whole run. The
// registrar has its own key and its own place in the block's task list.
import {
  decodeEventLog,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isExternalChain, mine, sendNoMine } from "@eris/sdk/chain.js";
import { readForgeArtifact } from "@eris/sdk/forge.js";
import { MULTICALL3 } from "@eris/sdk/constants.js";
import {
  marketRegistryAbi,
  registryKindIndex,
  ZERO_ADDRESS,
} from "@eris/sdk/marketRegistry.js";
import { simpleLendingAbi } from "@eris/sdk/protocols/lending.js";
import { uniswapFactory } from "@eris/sdk/protocols/uniswap.js";
import { uniswapV3FactoryEventsAbi } from "@eris/sdk/abis.js";
import type { RegistryKind } from "@eris/sdk/types.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import type { RunLogger } from "../logger.js";

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

// ERC-20 classification. ERC-165 does not cover ERC-20, so the only thing available is to ask and
// accept the heuristic: a contract that answers all three is treated as a token. It is a guess, and
// it is labelled as one — the entry's kind is a hint for discovery, never a safety claim.
const erc20ProbeAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

export type PendingEntry = {
  market: Address;
  kind: RegistryKind;
  creator: Address;
  token0: Address;
  token1: Address;
  oracle: Address;
  codehash: Hex;
  verified: boolean;
  extra: Hex;
  // The block the environment saw it, for the lag diagnostic. Not written on chain (the contract
  // stamps its own block number, which is the block the information actually became public).
  seenAtBlock: number;
};

// Ceiling on the discovery backlog. Registration is capped per block and the overflow carries, which
// is what stops a deploy-spam agent from inflating the environment's write cost -- but the queue
// itself is memory, and `createMarket` is permissionless and costs the creator only gas. Past this
// the *oldest* pending entries are dropped and the drop is logged: a queue that grows without bound
// is a way to make the environment do unbounded work, and a queue that truncates silently is a way
// to make a contract permanently invisible without anybody noticing.
export const MAX_PENDING_ENTRIES = 2048;

export type MarketRegistryRuntime = {
  address: Address;
  deployBlock: number;
  lending: Address;
  uniswapFactory?: Address;
  registrarPk: Hex;
  registrarAddress: Address;
  // Discovered but not yet published. Factory-made kinds are drained first: a verified pool is more
  // useful to publish promptly than an arbitrary contract nobody can price anyway.
  pending: PendingEntry[];
  // (market|extra) pairs already discovered, so a re-scan of an overlapping range does not queue
  // the same contract twice.
  seen: Set<string>;
  perBlockCap: number;
};

// Order the overflow drains in: factory-made kinds first, then everything else, FIFO within a tier.
const KIND_PRIORITY: Record<RegistryKind, number> = {
  uniswapV3Pool: 0,
  balancerWeightedPool: 0,
  curvePlainPool: 0,
  curveTwocryptoPool: 0,
  lendingMarket: 0,
  erc20: 1,
  unknown: 2,
};

function entryKey(market: string, extra: string): string {
  return `${market.toLowerCase()}|${extra.toLowerCase()}`;
}

async function deployFrom(
  ctx: SimContext,
  pk: Hex,
  name: string,
  args: readonly unknown[] = [],
): Promise<Address> {
  const account = privateKeyToAccount(pk);
  const { abi, bytecode } = readForgeArtifact(name);
  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hash = await ctx.walletClient.deployContract({
    abi,
    bytecode,
    args: args as never,
    account,
    chain: ctx.chain,
    maxFeePerGas: baseFee + 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  if (!isExternalChain()) await mine(ctx.publicClient);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name} deploy failed`);
  return receipt.contractAddress;
}

export async function deployAgentMarketVenues(
  ctx: SimContext,
  registrarPk: Hex,
  perBlockCap: number,
  logger: RunLogger,
): Promise<MarketRegistryRuntime> {
  const registrarAddress = privateKeyToAccount(registrarPk).address;
  // Owner-gated writes: the registry's owner is whoever deployed it, so the registrar must be the
  // deployer. An agent that could write here could publish a `verified` entry for its own trap.
  const address = await deployFrom(ctx, registrarPk, "MarketRegistry");
  const lending = await deployFrom(ctx, registrarPk, "SimpleLending");
  const deployBlock = Number(await ctx.publicClient.getBlockNumber());
  const factory = await uniswapFactory(ctx.publicClient);
  logger.event({
    type: "market_registry_deployed",
    address,
    lending,
    registrar: registrarAddress,
    uniswapFactory: factory ?? null,
    perBlockCap,
    deployBlock,
  });
  return {
    address,
    deployBlock,
    lending,
    uniswapFactory: factory,
    registrarPk,
    registrarAddress,
    pending: [],
    seen: new Set(),
    perBlockCap,
  };
}

// One block range's discoveries, queued into runtime.pending. Never throws: discovery is
// best-effort, and a run whose registry stalled is better than a run that stopped.
export async function sweepMarkets(
  ctx: SimContext,
  runtime: MarketRegistryRuntime,
  fromBlock: number,
  toBlock: number,
  // Addresses the environment owns. A venue the environment deployed is not an agent-created
  // market, and publishing one would tell agents the environment is a participant.
  environmentAddresses: ReadonlySet<string>,
  logger: RunLogger,
): Promise<void> {
  if (fromBlock > toBlock) return;
  const { publicClient } = ctx;
  const found: PendingEntry[] = [];
  // One read per distinct address per sweep. Every market on the lending singleton lives at the
  // singleton's address, so a batch of two hundred `CreateMarket` events used to mean two hundred
  // `eth_getCode` calls for one contract -- inside the block loop.
  const codehashCache = new Map<string, Hex>();
  const codehash = async (address: Address): Promise<Hex> => {
    const key = address.toLowerCase();
    const hit = codehashCache.get(key);
    if (hit) return hit;
    const value = await codehashOf(publicClient, address);
    codehashCache.set(key, value);
    return value;
  };

  // ---- factory logs: address, tokens and parameters, directly ----
  if (runtime.uniswapFactory) {
    try {
      const logs = await publicClient.getLogs({
        address: runtime.uniswapFactory,
        event: uniswapV3FactoryEventsAbi[0],
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      });
      for (const log of logs) {
        const args = log.args as {
          token0?: Address;
          token1?: Address;
          fee?: number;
          pool?: Address;
        };
        if (!args.pool) continue;
        const creator = await senderOf(publicClient, log.transactionHash);
        found.push({
          market: args.pool,
          kind: "uniswapV3Pool",
          creator,
          token0: args.token0 ?? ZERO_ADDRESS,
          token1: args.token1 ?? ZERO_ADDRESS,
          oracle: ZERO_ADDRESS,
          codehash: await codehash(args.pool),
          // Verified: the implementation is the environment's factory's. It says nothing about
          // what is inside the pool, or about the price it was initialized at.
          verified: true,
          extra: ZERO_BYTES32,
          seenAtBlock: toBlock,
        });
      }
    } catch (error) {
      logger.event({
        type: "market_sweep_failed",
        source: "uniswapV3Factory",
        fromBlock,
        toBlock,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ---- the lending singleton's own CreateMarket ----
  try {
    const logs = await publicClient.getLogs({
      address: runtime.lending,
      event: simpleLendingAbi.find(
        (e) => e.type === "event" && e.name === "CreateMarket",
      ) as never,
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
    });
    for (const raw of logs as unknown[]) {
      const log = raw as { topics: readonly Hex[]; data: Hex };
      const decoded = decodeEventLog({
        abi: simpleLendingAbi,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      if (decoded.eventName !== "CreateMarket") continue;
      const a = decoded.args as unknown as {
        id: Hex;
        creator: Address;
        loanToken: Address;
        collateralToken: Address;
        oracle: Address;
      };
      found.push({
        // Every market on the singleton lives at the singleton's address; `extra` is what tells them
        // apart, and the registry's dedup key is the pair.
        market: runtime.lending,
        kind: "lendingMarket",
        creator: a.creator,
        token0: a.loanToken,
        token1: a.collateralToken,
        oracle: a.oracle,
        codehash: await codehash(runtime.lending),
        // Verified: the singleton is environment-owned canonical code with readable parameters.
        // The oracle it points at is emphatically not covered by that.
        verified: true,
        extra: a.id,
        seenAtBlock: toBlock,
      });
    }
  } catch (error) {
    logger.event({
      type: "market_sweep_failed",
      source: "simpleLending",
      fromBlock,
      toBlock,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ---- top-level CREATE: scan each block's transactions for `to === null` ----
  // No receipt fetch: the address is derived from (from, nonce), which the transaction itself
  // carries. CREATE / CREATE2 from inside a contract is invisible here, and is accepted.
  const created: Array<{ address: Address; creator: Address }> = [];
  for (let b = fromBlock; b <= toBlock; b++) {
    try {
      const block = await publicClient.getBlock({
        blockNumber: BigInt(b),
        includeTransactions: true,
      });
      for (const tx of block.transactions) {
        if (typeof tx === "string") continue;
        if (tx.to !== null && tx.to !== undefined) continue;
        created.push({
          address: getContractAddress({ from: tx.from, nonce: BigInt(tx.nonce) }),
          creator: tx.from,
        });
      }
    } catch (error) {
      logger.event({
        type: "market_sweep_failed",
        source: "createScan",
        fromBlock: b,
        toBlock: b,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const fresh = created.filter(
    (c) =>
      !environmentAddresses.has(c.address.toLowerCase()) &&
      !runtime.seen.has(entryKey(c.address, ZERO_BYTES32)),
  );
  if (fresh.length > 0) {
    const kinds = await classifyContracts(
      publicClient,
      fresh.map((c) => c.address),
    );
    for (let i = 0; i < fresh.length; i++) {
      found.push({
        market: fresh[i].address,
        kind: kinds[i],
        creator: fresh[i].creator,
        token0: ZERO_ADDRESS,
        token1: ZERO_ADDRESS,
        oracle: ZERO_ADDRESS,
        codehash: await codehash(fresh[i].address),
        // Nothing deployed by an agent is verified. Its bytecode is whatever they compiled.
        verified: false,
        extra: ZERO_BYTES32,
        seenAtBlock: toBlock,
      });
    }
  }

  for (const entry of found) {
    const key = entryKey(entry.market, entry.extra);
    if (runtime.seen.has(key)) continue;
    if (
      environmentAddresses.has(entry.market.toLowerCase()) &&
      entry.kind !== "lendingMarket"
    )
      continue;
    runtime.seen.add(key);
    runtime.pending.push(entry);
  }
  if (found.length > 0) {
    runtime.pending.sort(
      (a, b) =>
        KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
        a.seenAtBlock - b.seenAtBlock,
    );
  }
  if (runtime.pending.length > MAX_PENDING_ENTRIES) {
    const dropped = runtime.pending.length - MAX_PENDING_ENTRIES;
    runtime.pending = runtime.pending.slice(0, MAX_PENDING_ENTRIES);
    logger.event({
      type: "market_registration_dropped",
      dropped,
      backlog: MAX_PENDING_ENTRIES,
      note:
        "the discovery backlog exceeded its ceiling; these contracts will not be published. " +
        "They are still on chain and still findable by anyone who scans for them -- what is lost " +
        "is the environment publishing them, which is the same loss as an internal CREATE.",
    });
  }
}

// Publish up to the per-block cap. Returns the transaction hash when something was written.
//
// The cap exists because the write is paid by the environment while the deploy is paid by the agent
// (ADR 0011): without it a deploy-spam agent inflates the environment's cost without bound. The
// overflow carries rather than being dropped — a contract discovered and then forgotten would be a
// contract nobody but its creator can see.
export async function registerPending(
  ctx: SimContext,
  runtime: MarketRegistryRuntime,
  blockNumber: number,
  priorityFeeWei: bigint,
  logger: RunLogger,
): Promise<Hex | undefined> {
  if (runtime.pending.length === 0) return undefined;
  const batch = runtime.pending.slice(0, runtime.perBlockCap);
  const overflow = runtime.pending.length - batch.length;
  const data = encodeFunctionData({
    abi: marketRegistryAbi,
    functionName: "register",
    args: [
      batch.map((e) => ({
        market: e.market,
        kind: registryKindIndex(e.kind),
        creator: e.creator,
        token0: e.token0,
        token1: e.token1,
        oracle: e.oracle,
        codehash: e.codehash,
        verified: e.verified,
        // Stamped by the contract; the value sent is ignored.
        registeredAtBlock: 0n,
        extra: e.extra,
      })),
    ],
  });
  const hash = await sendNoMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    runtime.registrarPk,
    { to: runtime.address, data },
    priorityFeeWei,
  );
  runtime.pending = runtime.pending.slice(batch.length);
  for (const e of batch) {
    logger.event({
      type: "market_registered",
      market: e.market,
      kind: e.kind,
      creator: e.creator,
      token0: e.token0 === ZERO_ADDRESS ? null : e.token0,
      token1: e.token1 === ZERO_ADDRESS ? null : e.token1,
      oracle: e.oracle === ZERO_ADDRESS ? null : e.oracle,
      codehash: e.codehash,
      verified: e.verified,
      extra: e.extra === ZERO_BYTES32 ? null : e.extra,
      seenAtBlock: e.seenAtBlock,
      // The write lands in the next block, so this is when the environment asked for it, not when
      // anybody else could read it. The one-block gap is the registry's distribution lag and it is
      // the creator's head start.
      submittedAtBlock: blockNumber,
    });
  }
  if (overflow > 0) {
    // Silent truncation would read as "everything was published". It is not: these carry.
    logger.event({
      type: "market_registration_deferred",
      blockNumber,
      deferred: overflow,
      cap: runtime.perBlockCap,
    });
  }
  return hash;
}

async function senderOf(
  publicClient: PublicClient,
  hash: Hex | null,
): Promise<Address> {
  if (!hash) return ZERO_ADDRESS;
  try {
    const tx = await publicClient.getTransaction({ hash });
    return tx.from;
  } catch {
    return ZERO_ADDRESS;
  }
}

async function codehashOf(
  publicClient: PublicClient,
  address: Address,
): Promise<Hex> {
  try {
    const code = await publicClient.getCode({ address });
    return keccak256((code ?? "0x") as Hex);
  } catch {
    return ZERO_BYTES32;
  }
}

// ERC-20 or not. Three static calls per candidate through one multicall; a contract that answers
// all three is called an erc20 and everything else is `unknown`. Deliberately a heuristic: the
// alternative (only record a token once a known factory pairs it) hides a token until somebody
// makes a market in it, which is exactly when it is too late to look at it.
export async function classifyContracts(
  publicClient: PublicClient,
  addresses: readonly Address[],
): Promise<RegistryKind[]> {
  if (addresses.length === 0) return [];
  let results: Array<{ status: "success" | "failure"; result?: unknown }>;
  try {
    results = (await publicClient.multicall({
      contracts: addresses.flatMap((address) => [
        { address, abi: erc20ProbeAbi, functionName: "name" },
        { address, abi: erc20ProbeAbi, functionName: "symbol" },
        { address, abi: erc20ProbeAbi, functionName: "decimals" },
      ]) as never,
      multicallAddress: MULTICALL3,
      allowFailure: true,
    })) as Array<{ status: "success" | "failure"; result?: unknown }>;
  } catch {
    return addresses.map(() => "unknown" as RegistryKind);
  }
  return addresses.map((_, i) => {
    const ok =
      results[i * 3]?.status === "success" &&
      results[i * 3 + 1]?.status === "success" &&
      results[i * 3 + 2]?.status === "success";
    return ok ? ("erc20" as RegistryKind) : ("unknown" as RegistryKind);
  });
}
