// Pools the environment places on the chain after the epoch has started (rules §3.2 regime 7,
// ADR 0014), surfaced in the observation so that a `decide()` strategy can see them at all.
//
// The reference agents that trade these pools (`discovery-arb`, `discovery-arb-verify`) are
// `run(ctx)` agents that subscribe to the factory's PoolCreated logs themselves. A submittable
// agent is a `decide(obs, ctx)` function (rules §2.5, prompt.md alongside), and it sees only what
// the observation carries -- so without this a submitted strategy could not learn that a pool
// exists, let alone decide whether to trust it.
//
// What is disclosed: that a pool exists, its tokens, fee, reserves, an implied quote and its code
// hash. What is not: whether it is rigged. The rules leave inspecting the contract to the participant
// (§3.2), and the disclosure of the source lives in the run's `disclosures/<address>.json`.

import type { Abi, Address, Hex, PublicClient } from "viem";

export const discoveredPoolFactoryAbi = [
  {
    type: "event",
    name: "PoolCreated",
    inputs: [
      { name: "pool", type: "address", indexed: true },
      { name: "token0", type: "address", indexed: true },
      { name: "token1", type: "address", indexed: true },
      { name: "feeBps", type: "uint24", indexed: false },
    ],
  },
] as const satisfies Abi;

export const discoveredPoolAbi = [
  {
    type: "function",
    name: "getReserves",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "r0", type: "uint256" },
      { name: "r1", type: "uint256" },
    ],
  },
] as const satisfies Abi;

const erc20DecimalsAbi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const satisfies Abi;

export type DiscoveredPool = {
  address: Address;
  token0: Address;
  token1: Address;
  token0Decimals: number;
  token1Decimals: number;
  feeBps: number;
  createdAtBlock: number;
  // Raw reserves, in each token's own units. Both "0" until the environment funds the pool.
  reserve0: string;
  reserve1: string;
  // token1 per token0 from the reserves (a spot mid, before fee and impact). Null while unfunded.
  impliedPriceToken1PerToken0: number | null;
  // keccak256 of the deployed bytecode, for comparison against the disclosed source's build.
  codehash: Hex;
};

// token1 per token0, decimals removed. Null when either side is empty: a quote out of nothing is
// not a price, and reading it as one is exactly the mistake an unfunded bait pool invites.
export function impliedPrice(
  reserve0: bigint,
  decimals0: number,
  reserve1: bigint,
  decimals1: number,
): number | null {
  if (reserve0 <= 0n || reserve1 <= 0n) return null;
  return (
    Number(reserve1) / 10 ** decimals1 / (Number(reserve0) / 10 ** decimals0)
  );
}

// Tracks the factory's pools across blocks: PoolCreated logs are read incrementally from the block
// the factory was deployed at, static facts (tokens, decimals, code hash) once per pool, reserves
// at every observation.
export class PoolDiscovery {
  private readonly pools = new Map<Address, Omit<DiscoveredPool, "reserve0" | "reserve1" | "impliedPriceToken1PerToken0">>();
  private readonly decimalsCache = new Map<string, number>();
  private scannedTo: bigint;

  constructor(
    private readonly publicClient: PublicClient,
    private readonly factory: Address,
    fromBlock: bigint,
  ) {
    this.scannedTo = fromBlock > 0n ? fromBlock - 1n : 0n;
  }

  get factoryAddress(): Address {
    return this.factory;
  }

  private async decimalsOf(token: Address): Promise<number> {
    const key = token.toLowerCase();
    const cached = this.decimalsCache.get(key);
    if (cached !== undefined) return cached;
    let d = 18;
    try {
      d = Number(
        await this.publicClient.readContract({
          address: token,
          abi: erc20DecimalsAbi,
          functionName: "decimals",
        }),
      );
    } catch {
      // A token without decimals() is treated as 18; the raw reserves are still reported.
    }
    this.decimalsCache.set(key, d);
    return d;
  }

  async observe(blockNumber: bigint): Promise<DiscoveredPool[]> {
    if (blockNumber > this.scannedTo) {
      const logs = await this.publicClient.getContractEvents({
        address: this.factory,
        abi: discoveredPoolFactoryAbi,
        eventName: "PoolCreated",
        fromBlock: this.scannedTo + 1n,
        toBlock: blockNumber,
      });
      for (const log of logs) {
        const { pool, token0, token1, feeBps } = log.args;
        if (!pool || !token0 || !token1 || this.pools.has(pool)) continue;
        const [token0Decimals, token1Decimals, code] = await Promise.all([
          this.decimalsOf(token0),
          this.decimalsOf(token1),
          this.publicClient.getCode({ address: pool }),
        ]);
        const { keccak256 } = await import("viem");
        this.pools.set(pool, {
          address: pool,
          token0,
          token1,
          token0Decimals,
          token1Decimals,
          feeBps: Number(feeBps ?? 0),
          createdAtBlock: Number(log.blockNumber ?? blockNumber),
          codehash: keccak256(code ?? "0x"),
        });
      }
      this.scannedTo = blockNumber;
    }
    const out: DiscoveredPool[] = [];
    for (const pool of this.pools.values()) {
      let r0 = 0n;
      let r1 = 0n;
      try {
        [r0, r1] = (await this.publicClient.readContract({
          address: pool.address,
          abi: discoveredPoolAbi,
          functionName: "getReserves",
          blockNumber,
        })) as readonly [bigint, bigint];
      } catch {
        // A pool that does not answer getReserves is reported with empty reserves, not dropped:
        // its existence is the fact the observation owes the strategy.
      }
      out.push({
        ...pool,
        reserve0: r0.toString(),
        reserve1: r1.toString(),
        impliedPriceToken1PerToken0: impliedPrice(
          r0,
          pool.token0Decimals,
          r1,
          pool.token1Decimals,
        ),
      });
    }
    return out;
  }
}
