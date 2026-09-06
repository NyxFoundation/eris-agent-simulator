// Agent-created market discovery (issue #40 T2 / T3).
//
// The read side of `contracts/MarketRegistry.sol`, shared by the environment (which writes it), the
// agent runtime (which turns it into the observation) and the scorer (which uses it to decide what a
// holding is). One owner for "what is an entry, and what does its kind mean".
//
// The registry is a **discovery** mechanism. `verified` means the contract came out of a factory
// whose implementation the environment deployed, so its code is known and its parameters are
// readable. It does not mean the contract is safe to touch, and it says nothing at all about the
// contract's contents: a verified Uniswap V3 pool seeded at a lying price is still a trap.
import {
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { MULTICALL3 } from "./constants.js";
import type { RegistryEntryObservation, RegistryKind } from "./types.js";

// Mirrors MarketRegistry.Kind. Index order is the on-chain enum's, so a change here without a change
// there silently re-labels every entry.
export const REGISTRY_KINDS: RegistryKind[] = [
  "unknown",
  "uniswapV3Pool",
  "balancerWeightedPool",
  "curvePlainPool",
  "curveTwocryptoPool",
  "lendingMarket",
  "erc20",
];

export function registryKindOf(index: number): RegistryKind {
  return REGISTRY_KINDS[index] ?? "unknown";
}

export function registryKindIndex(kind: RegistryKind): number {
  const i = REGISTRY_KINDS.indexOf(kind);
  return i < 0 ? 0 : i;
}

// Kinds whose implementation is environment-owned canonical code. Everything else is `unknown` in
// the sense that matters: no safety claim.
const VERIFIABLE_KINDS = new Set<RegistryKind>([
  "uniswapV3Pool",
  "balancerWeightedPool",
  "curvePlainPool",
  "curveTwocryptoPool",
  "lendingMarket",
]);

export function kindIsVerifiable(kind: RegistryKind): boolean {
  return VERIFIABLE_KINDS.has(kind);
}

export const marketRegistryAbi = [
  {
    type: "function",
    name: "count",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "isRegistered",
    stateMutability: "view",
    inputs: [{ name: "market", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "all",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "market", type: "address" },
          { name: "kind", type: "uint8" },
          { name: "creator", type: "address" },
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "oracle", type: "address" },
          { name: "codehash", type: "bytes32" },
          { name: "verified", type: "bool" },
          { name: "registeredAtBlock", type: "uint64" },
          { name: "extra", type: "bytes32" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "entriesFrom",
    stateMutability: "view",
    inputs: [
      { name: "start", type: "uint256" },
      { name: "limit", type: "uint256" },
    ],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "market", type: "address" },
          { name: "kind", type: "uint8" },
          { name: "creator", type: "address" },
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "oracle", type: "address" },
          { name: "codehash", type: "bytes32" },
          { name: "verified", type: "bool" },
          { name: "registeredAtBlock", type: "uint64" },
          { name: "extra", type: "bytes32" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "entries",
        type: "tuple[]",
        components: [
          { name: "market", type: "address" },
          { name: "kind", type: "uint8" },
          { name: "creator", type: "address" },
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "oracle", type: "address" },
          { name: "codehash", type: "bytes32" },
          { name: "verified", type: "bool" },
          { name: "registeredAtBlock", type: "uint64" },
          { name: "extra", type: "bytes32" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "MarketRegistered",
    inputs: [
      { name: "market", type: "address", indexed: true },
      { name: "kind", type: "uint8", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "token0", type: "address", indexed: false },
      { name: "token1", type: "address", indexed: false },
      { name: "oracle", type: "address", indexed: false },
      { name: "codehash", type: "bytes32", indexed: false },
      { name: "verified", type: "bool", indexed: false },
      { name: "extra", type: "bytes32", indexed: false },
      { name: "blockNumber", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

// `owner()` is the one question worth asking of an arbitrary price source. A contract that does not
// answer is not thereby ownerless — it may own itself through code nobody read — so the caller gets
// `undefined` rather than the zero address.
export const ownableAbi = parseAbi([
  "function owner() view returns (address)",
]);

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as Address;

// The on-chain tuple, before it becomes an observation.
export type RegistryEntry = {
  market: Address;
  kind: RegistryKind;
  creator: Address;
  token0: Address;
  token1: Address;
  oracle: Address;
  codehash: Hex;
  verified: boolean;
  registeredAtBlock: bigint;
  extra: Hex;
};

type RawEntry = {
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

export function decodeEntries(raw: readonly RawEntry[]): RegistryEntry[] {
  return raw.map((e) => ({
    market: e.market,
    kind: registryKindOf(Number(e.kind)),
    creator: e.creator,
    token0: e.token0,
    token1: e.token1,
    oracle: e.oracle,
    codehash: e.codehash,
    verified: e.verified,
    registeredAtBlock: BigInt(e.registeredAtBlock),
    extra: e.extra,
  }));
}

/// Read the whole list. Sized for a competition group (32 participants at a handful of contracts
/// each); a registry that outgrows one call is a load-test finding, not a normal state.
export async function readRegistryEntries(
  publicClient: PublicClient,
  registry: Address,
  blockNumber?: bigint,
): Promise<RegistryEntry[]> {
  const raw = (await publicClient.readContract({
    address: registry,
    abi: marketRegistryAbi,
    functionName: "all",
    ...(blockNumber === undefined ? {} : { blockNumber }),
  })) as readonly RawEntry[];
  return decodeEntries(raw);
}

/// Current runtime codehash of each entry, so an agent can compare it against the hash the registry
/// recorded at registration. Batched into one multicall-free `eth_getCode` fan-out because there is
/// no contract to multicall through for code reads.
export async function readCodehashes(
  publicClient: PublicClient,
  addresses: readonly Address[],
): Promise<Record<string, Hex>> {
  // Deduplicated, because the address is not one-to-one with the entry: every market on the lending
  // singleton lives at the singleton's address, so a field that opened two hundred markets would
  // otherwise cost two hundred `eth_getCode` calls per agent per block for one contract.
  const unique = [
    ...new Map(addresses.map((a) => [a.toLowerCase(), a])).values(),
  ];
  const out: Record<string, Hex> = {};
  const codes = await Promise.all(
    unique.map((address) =>
      publicClient.getCode({ address }).catch(() => undefined),
    ),
  );
  unique.forEach((address, i) => {
    const code = codes[i];
    if (code === undefined) return;
    out[address.toLowerCase()] = keccak256(code);
  });
  return out;
}

/// Who can move each oracle. Undefined for an address that does not answer `owner()`.
export async function readOracleOwners(
  publicClient: PublicClient,
  oracles: readonly Address[],
): Promise<Record<string, Address>> {
  const unique = [...new Set(oracles.map((o) => o.toLowerCase()))].filter(
    (o) => o !== ZERO_ADDRESS,
  ) as Address[];
  if (unique.length === 0) return {};
  const results = (await publicClient.multicall({
    contracts: unique.map((address) => ({
      address,
      abi: ownableAbi,
      functionName: "owner",
    })) as never,
    multicallAddress: MULTICALL3,
    allowFailure: true,
  })) as Array<{ status: "success" | "failure"; result?: unknown }>;
  const out: Record<string, Address> = {};
  unique.forEach((address, i) => {
    const r = results[i];
    if (r.status === "success" && typeof r.result === "string")
      out[address.toLowerCase()] = r.result as Address;
  });
  return out;
}

export function entryObservation(
  entry: RegistryEntry,
  opts: {
    agent: Address;
    codehashNow?: Hex;
    oracleOwner?: Address;
  },
): RegistryEntryObservation {
  const isLending = entry.kind === "lendingMarket";
  return {
    market: entry.market,
    kind: entry.kind,
    creator: entry.creator,
    mine: entry.creator.toLowerCase() === opts.agent.toLowerCase(),
    ...(entry.token0 === ZERO_ADDRESS ? {} : { token0: entry.token0 }),
    ...(entry.token1 === ZERO_ADDRESS ? {} : { token1: entry.token1 }),
    ...(entry.oracle === ZERO_ADDRESS ? {} : { oracle: entry.oracle }),
    ...(opts.oracleOwner ? { oracleOwner: opts.oracleOwner } : {}),
    codehashAtRegistration: entry.codehash,
    ...(opts.codehashNow ? { codehashNow: opts.codehashNow } : {}),
    verified: entry.verified,
    registeredAtBlock: entry.registeredAtBlock.toString(),
    ...(isLending || entry.extra !== `0x${"0".repeat(64)}`
      ? { extra: entry.extra }
      : {}),
  };
}
