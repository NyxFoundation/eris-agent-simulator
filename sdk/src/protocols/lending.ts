// Permissionless lending venue adapter (issue #40 T4).
//
// The venue is `contracts/SimpleLending.sol`: one environment-deployed singleton in which **anyone**
// can open a market `(loanToken, collateralToken, oracle, irm, lltv)`. That is what Aave cannot be —
// its reserves are opened by an admin-only `PoolConfigurator` — and it is the point of the venue:
// the parameters are the creator's, including the oracle, and reading them is the counterparty's
// job.
//
// Two things here are load-bearing for scoring and are not obvious:
//
//   1. **The market's own oracle never writes anybody's mark.** It decides liquidations, because
//      that is what the market's participants agreed to. Valuation uses the *environment's* prices
//      for tokens the environment prices, and zero for tokens it does not. An attacker-controlled
//      oracle that marks worthless collateral at $1,000,000 moves who gets liquidated; it must not
//      move the score.
//
//   2. **A supply position marks at recoverable value, not par** (issue #40 axiom 3). Recoverable is
//      the supplier's pro-rata claim on what actually backs the market: the loan tokens still in the
//      contract, plus the environment-priced collateral standing behind the outstanding debt. The
//      worked example is the whole reason: T creates (USDC, SCAM, T's own oracle, 90% LLTV), V
//      supplies 10,000 USDC, T posts worthless SCAM, marks it high through its own oracle, borrows
//      the 10,000 and withdraws to an EOA. At par V still reads 10,000 and the field's total rises
//      by 10,000 — fabricated value, and the attack does not exist as far as the score is concerned.
//      At recoverable V is −10,000 and T is +10,000: a transfer.
//
//   3. **A borrower's position is floored at zero.** Collateral minus debt, clamped — because a
//      borrower whose collateral is worth less than the debt can drop the collateral and walk away.
//      That is the same rule the Liquity adapter already applies to a Trove under 100% ICR, and it
//      is what makes (2)'s books balance: T's un-repayable debt is not a liability it will ever pay.
import { encodeFunctionData, type Abi, type Address, type PublicClient } from "viem";
import { erc20Abi } from "../abis.js";
import { MULTICALL3 } from "../constants.js";
import {
  addStableUnits,
  mergeStableUnits,
  tokenAmountUsd,
  type StableUnits,
  type UnpricedAmount,
} from "../valuation.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  CreateLendingMarketAction,
  LeafAction,
  LendingObservation,
  LendingPositionObservation,
} from "../types.js";
import type {
  AgentProtocolValue,
  BuiltTx,
  ProtocolAdapter,
  SimContext,
  UnpricedHoldingDetail,
  ValidationResult,
  ValuationAgent,
  ValuationContext,
  ValuationRead,
  ValuationRun,
} from "./types.js";

const DECIMAL_INTEGER = /^[0-9]+$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const WAD = 10n ** 18n;
export const ORACLE_PRICE_SCALE = 10n ** 36n;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

// How many markets one observation carries. A registry that outgrows this is telling you the field
// is spamming markets, which the per-block registration cap already bounds; the observation cuts
// rather than growing without limit, and the registry section still lists every entry so nothing
// disappears silently.
export const LENDING_OBSERVATION_LIMIT = 32;

// Hard ceiling on how many market ids any single read will look at. `createMarket` is
// permissionless and costs the creator nothing but gas, so the count is attacker-controlled: one
// transaction into a batching contract opens hundreds. Everything downstream -- the observation,
// both valuation paths, the registry sweep -- has to be bounded by something that is not the
// attacker's choice.
//
// Above this the newest ids win and the drop is *logged*, never silent: a cap that quietly
// truncates reads as "that is all there was".
export const MARKET_SCAN_LIMIT = 512;

// Ids per multicall when walking `_marketIds` through `marketIdAt`. One call is a cold SLOAD plus
// call overhead (~3k gas), so a page costs under 1M whatever the list's length -- which is the
// point: `marketIds()` returns the whole list and stops fitting an eth_call past a few thousand
// entries (the shape PR #201 fixed for `MarketRegistry.all()`), and nothing here calls it.
export const LENDING_ID_PAGE_SIZE = 256;

// Markets per agent the valuation reads, from the contract's per-user index (`userMarketIdsFrom`).
// That index is appended only by the agent's own supply / supplyCollateral / borrow, so nobody else
// can lengthen it: a bound here only ever cuts an agent's *own* positions, and the cut is reported
// (`lending-unscanned`), never silent. The newest-N slice of `marketIds()` this replaces was cut by
// a list anyone could extend -- N empty markets opened after a victim's market pushed the victim's
// position out of the valuation with no warning (issue #212). 128 is an order of magnitude above
// any strategy's footprint and keeps a cross-section at one page per agent.
export const USER_MARKET_LIMIT = 128;

// A market with nothing in it cannot hold anybody's position -- supply, borrow and collateral are
// all zero, so every position in it is zero by construction. That is what makes dropping them exact
// rather than a heuristic, and it is what collapses a spam attack of N empty markets to no
// per-agent reads at all.
export function marketIsEmpty(totals: MarketTotals | undefined): boolean {
  if (!totals) return true;
  return (
    totals.totalSupplyAssets === 0n &&
    totals.totalBorrowAssets === 0n &&
    totals.totalCollateralAssets === 0n &&
    // Shares as well as assets. Bad-debt socialisation can take every asset total to zero while
    // suppliers still hold shares: supply 100, borrow 100, collateral goes to zero, liquidate. The
    // position is worth nothing, which is the right mark -- but it exists, and a market that
    // vanishes from the observation because it was wiped out is a market whose holder cannot see
    // what happened to them.
    totals.totalSupplyShares === 0n &&
    totals.totalBorrowShares === 0n
  );
}

export const simpleLendingAbi = [
  {
    type: "function",
    name: "createMarket",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
  ...(
    [
      ["supply", "uint256"],
      ["withdraw", "uint256"],
      ["supplyCollateral", "uint256"],
      ["withdrawCollateral", "uint256"],
      ["borrow", "uint256"],
      ["repay", "uint256"],
    ] as const
  ).map(([name]) => ({
    type: "function" as const,
    name,
    stateMutability: "nonpayable" as const,
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
      { name: "assets", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  })),
  {
    type: "function",
    name: "repayAll",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "withdrawAll",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "liquidate",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
      { name: "borrower", type: "address" },
      { name: "seizedAssets", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  // `marketIds()` is deliberately not here: its cost grows with a length anyone can extend, and the
  // SDK pages through `marketCount` + `marketIdAt` instead (see readMarketIdsNewestFirst).
  {
    type: "function",
    name: "marketCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "marketIdAt",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "userMarketCount",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "userMarketIdAt",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "userMarketIdsFrom",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "start", type: "uint256" },
      { name: "limit", type: "uint256" },
    ],
    outputs: [
      { name: "ids", type: "bytes32[]" },
      { name: "total", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "market",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "totalSupplyAssets", type: "uint128" },
      { name: "totalSupplyShares", type: "uint128" },
      { name: "totalBorrowAssets", type: "uint128" },
      { name: "totalBorrowShares", type: "uint128" },
      { name: "lastUpdate", type: "uint128" },
      { name: "totalCollateralAssets", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "marketParams",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "loanToken", type: "address" },
      { name: "collateralToken", type: "address" },
      { name: "oracle", type: "address" },
      { name: "irm", type: "address" },
      { name: "lltv", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "position",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "supplyShares", type: "uint256" },
      { name: "borrowShares", type: "uint128" },
      { name: "collateral", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "expectedPosition",
    stateMutability: "view",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "supplyAssets", type: "uint256" },
      { name: "borrowAssets", type: "uint256" },
      { name: "collateral", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "isHealthy",
    stateMutability: "view",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
      { name: "user", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "liquidationIncentiveFactor",
    stateMutability: "pure",
    inputs: [{ name: "lltv", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "idOf",
    stateMutability: "pure",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "event",
    name: "CreateMarket",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "loanToken", type: "address", indexed: false },
      { name: "collateralToken", type: "address", indexed: false },
      { name: "oracle", type: "address", indexed: false },
      { name: "irm", type: "address", indexed: false },
      { name: "lltv", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

export const lendingOracleAbi = [
  {
    type: "function",
    name: "price",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const satisfies Abi;

export type MarketParams = {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
};

export type MarketTotals = {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  totalCollateralAssets: bigint;
};

export type LendingState = {
  singleton: Address | undefined;
  marketIds: `0x${string}`[];
  paramsById: Record<string, MarketParams>;
  totalsById: Record<string, MarketTotals>;
  priceById: Record<string, bigint>;
  oracleOwnerById: Record<string, Address>;
  // Markets that exist and are not in this state. Nonzero means somebody opened more markets than
  // one read carries, which is a fact an agent should be able to see rather than infer.
  dropped: number;
};

const EMPTY_STATE: LendingState = {
  singleton: undefined,
  marketIds: [],
  paramsById: {},
  totalsById: {},
  priceById: {},
  oracleOwnerById: {},
  dropped: 0,
};

// ---------------------------------------------------------------------------
// parse / validate
// ---------------------------------------------------------------------------

const LENDING_ACTION_TYPES = new Set([
  "createLendingMarket",
  "lendingSupply",
  "lendingWithdraw",
  "lendingSupplyCollateral",
  "lendingWithdrawCollateral",
  "lendingBorrow",
  "lendingRepay",
  "lendingLiquidate",
]);

function requireAddress(value: unknown, name: string): Address {
  if (typeof value !== "string" || !HEX_ADDRESS.test(value))
    throw new Error(`${name} must be a 20-byte hex address`);
  return value as Address;
}

function requireAmount(value: unknown, name: string, allowMax = false): string {
  if (allowMax && value === "max") return "max";
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value))
    throw new Error(
      `${name} must be a decimal integer string${allowMax ? ' or "max"' : ""}`,
    );
  return value;
}

function parse(obj: Record<string, unknown>): LeafAction | null {
  const type = obj.type;
  if (typeof type !== "string" || !LENDING_ACTION_TYPES.has(type)) return null;
  if (type === "createLendingMarket") {
    const lltv = requireAmount(obj.lltv, "lltv");
    if (BigInt(lltv) >= WAD)
      throw new Error("lltv must be below 1e18 (100%)");
    return {
      type: "createLendingMarket",
      loanToken: requireAddress(obj.loanToken, "loanToken"),
      collateralToken: requireAddress(obj.collateralToken, "collateralToken"),
      oracle: requireAddress(obj.oracle, "oracle"),
      // The zero address is a legal IRM: it means "no interest", which at a 12-minute epoch is
      // indistinguishable from every other rate anyway.
      irm:
        obj.irm === undefined || obj.irm === null
          ? ZERO_ADDRESS
          : requireAddress(obj.irm, "irm"),
      lltv,
      ...priorityFee(obj),
    } as LeafAction;
  }
  const marketId = obj.marketId;
  if (typeof marketId !== "string" || !HEX_32.test(marketId))
    throw new Error("marketId must be a 32-byte hex string");
  if (type === "lendingLiquidate") {
    return {
      type,
      marketId,
      borrower: requireAddress(obj.borrower, "borrower"),
      seizedAssets: requireAmount(obj.seizedAssets, "seizedAssets"),
      ...priorityFee(obj),
    } as LeafAction;
  }
  const allowMax = type === "lendingWithdraw" || type === "lendingRepay";
  return {
    type,
    marketId,
    amount: requireAmount(obj.amount, "amount", allowMax),
    ...priorityFee(obj),
  } as LeafAction;
}

function priorityFee(obj: Record<string, unknown>): {
  maxPriorityFeePerGasWei?: string;
} {
  if (obj.maxPriorityFeePerGasWei === undefined) return {};
  if (
    typeof obj.maxPriorityFeePerGasWei !== "string" ||
    !DECIMAL_INTEGER.test(obj.maxPriorityFeePerGasWei)
  )
    throw new Error("maxPriorityFeePerGasWei must be a decimal integer string");
  return { maxPriorityFeePerGasWei: obj.maxPriorityFeePerGasWei };
}

// The runtime's pre-submit check. It deliberately does **not** check whether the market is safe,
// whether the oracle has an owner, or whether the collateral is a token anyone else will ever buy.
// Those are the decisions the venue exists to make the agent take.
function validate(
  action: LeafAction,
  obs: AgentObservation,
  _balances: BalanceSnapshot,
): ValidationResult {
  const lending = obs.protocols.lending;
  if (!lending?.singleton)
    return { ok: false, reason: "lending venue is not deployed in this run" };
  if (action.type === "createLendingMarket") return { ok: true };
  const marketId = (action as { marketId?: string }).marketId;
  if (!marketId) return { ok: false, reason: "marketId is required" };
  // A market created this block is not in the observation yet (the read is one block behind, like
  // every other read here), so an unknown id is a warning shape, not a rejection: the transaction
  // reverts on chain if the market genuinely does not exist, and that is the agent's gas to lose.
  return { ok: true };
}

// ---------------------------------------------------------------------------
// state / observation
// ---------------------------------------------------------------------------

function paramsTuple(p: MarketParams) {
  return {
    loanToken: p.loanToken,
    collateralToken: p.collateralToken,
    oracle: p.oracle,
    irm: p.irm,
    lltv: p.lltv,
  };
}

type MulticallResult = { status: "success" | "failure"; result?: unknown };

async function multicall(
  publicClient: PublicClient,
  contracts: unknown[],
): Promise<MulticallResult[]> {
  if (contracts.length === 0) return [];
  return (await publicClient.multicall({
    contracts: contracts as never,
    multicallAddress: MULTICALL3,
    allowFailure: true,
  })) as MulticallResult[];
}

function decodeTotals(raw: unknown): MarketTotals | undefined {
  if (!Array.isArray(raw)) return undefined;
  const t = raw as bigint[];
  return {
    totalSupplyAssets: t[0] ?? 0n,
    totalSupplyShares: t[1] ?? 0n,
    totalBorrowAssets: t[2] ?? 0n,
    totalBorrowShares: t[3] ?? 0n,
    lastUpdate: t[4] ?? 0n,
    totalCollateralAssets: t[5] ?? 0n,
  };
}

function decodeParams(raw: unknown): MarketParams | undefined {
  if (!Array.isArray(raw) || raw.length < 5) return undefined;
  const [loanToken, collateralToken, oracle, irm, lltv] = raw as [
    Address,
    Address,
    Address,
    Address,
    bigint,
  ];
  return { loanToken, collateralToken, oracle, irm, lltv };
}

// The newest `limit` market ids, newest first, in pages of `marketIdAt`. Never `marketIds()`: its
// gas grows with a length that is somebody else's choice (`createMarket` is permissionless), and a
// read that stops answering past a few thousand markets takes every observation with it. The list is
// append-only, so an index is stable and `marketCount` and the pages need not share a block: an id
// appended between the two is simply not in this read.
export async function readMarketIdsNewestFirst(
  publicClient: PublicClient,
  singleton: Address,
  limit: number,
): Promise<{ count: number; ids: `0x${string}`[] }> {
  const count = Number(
    await publicClient.readContract({
      address: singleton,
      abi: simpleLendingAbi,
      functionName: "marketCount",
    }),
  );
  const take = Math.max(0, Math.min(count, limit));
  const indices: number[] = [];
  for (let i = count - 1; i >= count - take; i--) indices.push(i);
  const pages: number[][] = [];
  for (let p = 0; p < indices.length; p += LENDING_ID_PAGE_SIZE)
    pages.push(indices.slice(p, p + LENDING_ID_PAGE_SIZE));
  const results = await Promise.all(
    pages.map((page) =>
      multicall(
        publicClient,
        page.map((i) => ({
          address: singleton,
          abi: simpleLendingAbi,
          functionName: "marketIdAt",
          args: [BigInt(i)],
        })),
      ),
    ),
  );
  const ids: `0x${string}`[] = [];
  for (const r of results.flat())
    if (r.status === "success" && typeof r.result === "string")
      ids.push(r.result as `0x${string}`);
  return { count, ids };
}

// The markets `user` has ever entered (oldest first), from the contract's per-user index, and how
// many there are in all so a caller can tell a complete page from a cut one.
export async function readUserMarketIds(
  publicClient: PublicClient,
  singleton: Address,
  user: Address,
  limit: number,
): Promise<{ ids: `0x${string}`[]; total: number }> {
  const [ids, total] = (await publicClient.readContract({
    address: singleton,
    abi: simpleLendingAbi,
    functionName: "userMarketIdsFrom",
    args: [user, 0n, BigInt(limit)],
  })) as readonly [readonly `0x${string}`[], bigint];
  return { ids: [...ids], total: Number(total) };
}

async function readTotals(
  publicClient: PublicClient,
  singleton: Address,
  ids: readonly `0x${string}`[],
): Promise<Record<string, MarketTotals>> {
  const totalsById: Record<string, MarketTotals> = {};
  const results = await multicall(
    publicClient,
    ids.map((id) => ({
      address: singleton,
      abi: simpleLendingAbi,
      functionName: "market",
      args: [id],
    })),
  );
  ids.forEach((id, i) => {
    const t = decodeTotals(results[i]?.result);
    if (t) totalsById[id] = t;
  });
  return totalsById;
}

async function readParams(
  publicClient: PublicClient,
  singleton: Address,
  ids: readonly `0x${string}`[],
): Promise<Record<string, MarketParams>> {
  const paramsById: Record<string, MarketParams> = {};
  const results = await multicall(
    publicClient,
    ids.map((id) => ({
      address: singleton,
      abi: simpleLendingAbi,
      functionName: "marketParams",
      args: [id],
    })),
  );
  ids.forEach((id, i) => {
    const p = decodeParams(results[i]?.result);
    if (p) paramsById[id] = p;
  });
  return paramsById;
}

// Each market's parameters, plus its oracle's price and who can move it. Both oracle facts are read
// here rather than in the scorer, because both are things the *agent* needs and neither is allowed
// to write a mark.
async function readMarketDetails(
  publicClient: PublicClient,
  singleton: Address,
  ids: readonly `0x${string}`[],
): Promise<
  Pick<LendingState, "paramsById" | "priceById" | "oracleOwnerById">
> {
  const paramsById = await readParams(publicClient, singleton, ids);
  const oracles = [...new Set(Object.values(paramsById).map((p) => p.oracle))];
  const priceReads = await multicall(publicClient, [
    ...oracles.map((address) => ({
      address,
      abi: lendingOracleAbi,
      functionName: "price",
    })),
    ...oracles.map((address) => ({
      address,
      abi: ownerAbi,
      functionName: "owner",
    })),
  ]);
  const priceByOracle: Record<string, bigint> = {};
  const ownerByOracle: Record<string, Address> = {};
  oracles.forEach((address, i) => {
    const price = priceReads[i];
    if (price.status === "success" && typeof price.result === "bigint")
      priceByOracle[address.toLowerCase()] = price.result;
    const owner = priceReads[oracles.length + i];
    if (owner.status === "success" && typeof owner.result === "string")
      ownerByOracle[address.toLowerCase()] = owner.result as Address;
  });
  const priceById: Record<string, bigint> = {};
  const oracleOwnerById: Record<string, Address> = {};
  for (const [id, p] of Object.entries(paramsById)) {
    const price = priceByOracle[p.oracle.toLowerCase()];
    if (price !== undefined) priceById[id] = price;
    const owner = ownerByOracle[p.oracle.toLowerCase()];
    if (owner !== undefined) oracleOwnerById[id] = owner;
  }
  return { paramsById, priceById, oracleOwnerById };
}

export async function readLendingState(
  ctx: SimContext,
  // How many markets the result carries. The observation wants a readable handful; the end-of-run
  // valuation wants every market anybody is actually in, which is what `marketIsEmpty` bounds.
  limit: number = LENDING_OBSERVATION_LIMIT,
): Promise<LendingState> {
  const singleton = ctx.lending;
  if (!singleton) return EMPTY_STATE;
  const { publicClient } = ctx;
  let count: number;
  let scanned: `0x${string}`[];
  try {
    // Newest first, and never more than the scan ceiling: the count is the creator's choice, so the
    // cost of reading it must not be.
    ({ count, ids: scanned } = await readMarketIdsNewestFirst(
      publicClient,
      singleton,
      MARKET_SCAN_LIMIT,
    ));
  } catch {
    // A run whose singleton is not there yet reads as "no markets", not as a failed block.
    return { ...EMPTY_STATE, singleton };
  }
  const scanDropped = count - scanned.length;
  if (scanned.length === 0)
    return { ...EMPTY_STATE, singleton, marketIds: [], dropped: scanDropped };

  // Totals first, for every scanned id. It is one multicall regardless of the count, and it is what
  // decides which markets are worth a second read: an empty market holds nobody's position.
  const totalsById = await readTotals(publicClient, singleton, scanned);

  // Markets somebody is actually in come first; empty ones fill whatever room is left, because a
  // freshly created market is empty and still worth seeing before deciding to be its first lender.
  const used = scanned.filter((id) => !marketIsEmpty(totalsById[id]));
  const empty = scanned.filter((id) => marketIsEmpty(totalsById[id]));
  const selected = [...used, ...empty].slice(0, limit);
  const observationDropped = scanned.length - selected.length;

  const details = await readMarketDetails(publicClient, singleton, selected);
  return {
    singleton,
    marketIds: selected,
    totalsById,
    ...details,
    dropped: scanDropped + observationDropped,
  };
}

const ownerAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const satisfies Abi;

// Undefined when the run has no lending singleton, so `obs.protocols.lending` is *absent* rather
// than present-and-empty.
//
// It used to return the zero address, and every caller's guard is `if (!lending?.singleton)` --
// which the zero address passes, because it is a non-empty string. So "this run has no lending
// venue" read as "the venue is at 0x0", every agent walked past its own idle check, and the
// failure surfaced one step later as a build-time rejection nobody was looking at. Measured
// 2026-09-05: a 32-agent bench registered no lending markets at all for this reason, and the run
// looked exactly like one where nobody chose to create any.
export async function observeLending(
  ctx: SimContext,
  state: LendingState,
  agent: Address,
): Promise<LendingObservation | undefined> {
  const singleton = state.singleton;
  if (!singleton) return undefined;

  // The agent's own markets come from the contract's per-user index, so a position that the
  // newest-first window dropped (N newer markets, somebody else's choice) is still in front of the
  // agent that holds it. Read here and not in readState because the index is per address.
  let own: `0x${string}`[] = [];
  try {
    own = (
      await readUserMarketIds(ctx.publicClient, singleton, agent, USER_MARKET_LIMIT)
    ).ids;
  } catch {
    // A singleton from a build without the index still observes the window.
  }
  const missing = own.filter((id) => !state.paramsById[id]);
  let { paramsById, totalsById, priceById, oracleOwnerById } = state;
  if (missing.length > 0) {
    const [totals, details] = await Promise.all([
      readTotals(ctx.publicClient, singleton, missing),
      readMarketDetails(ctx.publicClient, singleton, missing),
    ]);
    paramsById = { ...paramsById, ...details.paramsById };
    totalsById = { ...totalsById, ...totals };
    priceById = { ...priceById, ...details.priceById };
    oracleOwnerById = { ...oracleOwnerById, ...details.oracleOwnerById };
  }
  const ownSet = new Set<string>(own);
  const ids = [
    ...own,
    ...state.marketIds.filter((id) => !ownSet.has(id)),
  ].filter((id) => paramsById[id]);
  // Own markets the window had dropped and this read restored.
  const restored = missing.filter((id) => paramsById[id]).length;
  const dropped = Math.max(0, state.dropped - restored);
  if (ids.length === 0) return { singleton, markets: [], dropped };

  const results = await multicall(
    ctx.publicClient,
    ids.flatMap((id) => [
      {
        address: singleton,
        abi: simpleLendingAbi,
        functionName: "expectedPosition",
        args: [paramsTuple(paramsById[id]), agent],
      },
      {
        address: singleton,
        abi: simpleLendingAbi,
        functionName: "isHealthy",
        args: [paramsTuple(paramsById[id]), agent],
      },
      {
        address: singleton,
        abi: simpleLendingAbi,
        functionName: "liquidationIncentiveFactor",
        args: [paramsById[id].lltv],
      },
    ]),
  );

  const markets: LendingPositionObservation[] = ids.map((id, i) => {
    const params = paramsById[id];
    const totals = totalsById[id];
    const pos = results[i * 3];
    const healthy = results[i * 3 + 1];
    const lif = results[i * 3 + 2];
    const p = pos.status === "success" && Array.isArray(pos.result)
      ? (pos.result as bigint[])
      : [0n, 0n, 0n];
    const owner = oracleOwnerById[id];
    return {
      marketId: id,
      loanToken: params.loanToken,
      collateralToken: params.collateralToken,
      oracle: params.oracle,
      ...(owner ? { oracleOwner: owner } : {}),
      irm: params.irm,
      lltv: params.lltv.toString(),
      liquidationIncentiveFactor:
        lif.status === "success" && typeof lif.result === "bigint"
          ? lif.result.toString()
          : "0",
      price: (priceById[id] ?? 0n).toString(),
      supplyAssets: (p[0] ?? 0n).toString(),
      borrowAssets: (p[1] ?? 0n).toString(),
      collateral: (p[2] ?? 0n).toString(),
      healthy:
        healthy.status === "success" && typeof healthy.result === "boolean"
          ? healthy.result
          : true,
      totalSupplyAssets: (totals?.totalSupplyAssets ?? 0n).toString(),
      totalBorrowAssets: (totals?.totalBorrowAssets ?? 0n).toString(),
    };
  });
  return { singleton, markets, dropped };
}

// ---------------------------------------------------------------------------
// buildTxs
// ---------------------------------------------------------------------------

// Approve exactly what this interaction spends, never more. A contract that drains through a
// standing `approve` is in scope under the rules, so the reference runtime does not hand one out
// (issue #40: "approvals are the victim's problem", and the runtime's own approvals must not be the
// hole). The observation still reports whatever allowances an agent granted for itself.
export function exactApproveTx(token: Address, spender: Address, amount: bigint): BuiltTx {
  return {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    }),
  };
}

async function paramsFor(
  ctx: SimContext,
  singleton: Address,
  marketId: string,
): Promise<MarketParams> {
  const raw = (await ctx.publicClient.readContract({
    address: singleton,
    abi: simpleLendingAbi,
    functionName: "marketParams",
    args: [marketId as `0x${string}`],
  })) as readonly [Address, Address, Address, Address, bigint];
  const params = {
    loanToken: raw[0],
    collateralToken: raw[1],
    oracle: raw[2],
    irm: raw[3],
    lltv: raw[4],
  };
  if (params.loanToken === ZERO_ADDRESS)
    throw new Error(`lending market ${marketId} does not exist`);
  return params;
}

export async function buildLendingTxs(
  ctx: SimContext,
  owner: Address,
  action: LeafAction,
): Promise<BuiltTx[]> {
  const singleton = ctx.lending;
  if (!singleton) throw new Error("lending venue is not deployed in this run");

  if (action.type === "createLendingMarket") {
    const a = action as CreateLendingMarketAction;
    return [
      {
        to: singleton,
        data: encodeFunctionData({
          abi: simpleLendingAbi,
          functionName: "createMarket",
          args: [
            {
              loanToken: a.loanToken as Address,
              collateralToken: a.collateralToken as Address,
              oracle: a.oracle as Address,
              irm: a.irm as Address,
              lltv: BigInt(a.lltv),
            },
          ],
        }),
      },
    ];
  }

  const marketId = (action as { marketId: string }).marketId;
  const params = await paramsFor(ctx, singleton, marketId);
  const tuple = paramsTuple(params);

  const call = (functionName: string, args: readonly unknown[]): BuiltTx => ({
    to: singleton,
    data: encodeFunctionData({
      abi: simpleLendingAbi,
      functionName: functionName as never,
      args: args as never,
    }),
  });

  switch (action.type) {
    case "lendingSupply": {
      const amount = BigInt((action as { amount: string }).amount);
      return [
        exactApproveTx(params.loanToken, singleton, amount),
        call("supply", [tuple, amount]),
      ];
    }
    case "lendingSupplyCollateral": {
      const amount = BigInt((action as { amount: string }).amount);
      return [
        exactApproveTx(params.collateralToken, singleton, amount),
        call("supplyCollateral", [tuple, amount]),
      ];
    }
    case "lendingWithdraw": {
      const raw = (action as { amount: string }).amount;
      if (raw === "max") return [call("withdrawAll", [tuple])];
      return [call("withdraw", [tuple, BigInt(raw)])];
    }
    case "lendingWithdrawCollateral":
      return [
        call("withdrawCollateral", [
          tuple,
          BigInt((action as { amount: string }).amount),
        ]),
      ];
    case "lendingBorrow":
      return [
        call("borrow", [tuple, BigInt((action as { amount: string }).amount)]),
      ];
    case "lendingRepay": {
      const raw = (action as { amount: string }).amount;
      if (raw !== "max") {
        const amount = BigInt(raw);
        if (amount === 0n) return [];
        return [
          exactApproveTx(params.loanToken, singleton, amount),
          call("repay", [tuple, amount]),
        ];
      }
      // "max" goes through repayAll, which computes the debt inside the transaction. Sending a
      // read-then-rounded figure to `repay` is what an exit deadline cannot afford: a block of
      // accrual between the read and the send, and the caller is a wei short with no second chance.
      // The approval still has to be sized from a read -- there is no way around that -- so it
      // carries a margin, and the contract only ever pulls what is actually owed.
      const debt = await currentDebt(ctx, singleton, params, owner);
      if (debt === 0n) return [];
      return [
        exactApproveTx(params.loanToken, singleton, debt),
        call("repayAll", [tuple]),
      ];
    }
    case "lendingLiquidate": {
      const a = action as { borrower: string; seizedAssets: string };
      const seized = BigInt(a.seizedAssets);
      // The repayment is priced by the market's oracle at execution time, and the liquidator does
      // not get to see that number first. Approving the whole loan-token balance would be the
      // convenient move and is exactly the hole this venue exists to punish, so the approval is
      // sized from the *observed* price with a margin, and a price that moved further than that
      // reverts instead of draining.
      const price = await oraclePrice(ctx, params.oracle);
      const lif = (await ctx.publicClient.readContract({
        address: singleton,
        abi: simpleLendingAbi,
        functionName: "liquidationIncentiveFactor",
        args: [params.lltv],
      })) as bigint;
      const repayEstimate =
        lif > 0n ? (seized * price * WAD) / (ORACLE_PRICE_SCALE * lif) : 0n;
      // +10%: enough for a block of oracle drift, not enough to be a standing grant.
      const approval = (repayEstimate * 11n) / 10n + 1n;
      return [
        exactApproveTx(params.loanToken, singleton, approval),
        call("liquidate", [tuple, a.borrower as Address, seized]),
      ];
    }
    default:
      throw new Error(`not a lending action: ${(action as { type: string }).type}`);
  }
}

async function oraclePrice(ctx: SimContext, oracle: Address): Promise<bigint> {
  try {
    return (await ctx.publicClient.readContract({
      address: oracle,
      abi: lendingOracleAbi,
      functionName: "price",
    })) as bigint;
  } catch {
    return 0n;
  }
}

async function currentDebt(
  ctx: SimContext,
  singleton: Address,
  params: MarketParams,
  owner: Address,
): Promise<bigint> {
  const result = (await ctx.publicClient.readContract({
    address: singleton,
    abi: simpleLendingAbi,
    functionName: "expectedPosition",
    args: [paramsTuple(params), owner],
  })) as readonly [bigint, bigint, bigint];
  // A block of accrual can land between the read and the transaction, and repaying one wei short
  // leaves the position open. Ornamental interest makes the margin tiny; round it up anyway.
  return (result[1] * 10_001n) / 10_000n + 1n;
}

// ---------------------------------------------------------------------------
// valuation (issue #40 axiom 3)
// ---------------------------------------------------------------------------

type MarketValuation = {
  id: string;
  params: MarketParams;
  totals: MarketTotals;
};

// Fraction of a market's supply that is actually backed, in 1e18 fixed point. The loan tokens still
// in the contract, plus the environment-priced collateral standing behind the debt — never the
// market's own oracle, which the creator may control.
export function backedFraction(
  totals: MarketTotals,
  collateralValueInLoanUnits: bigint,
): bigint {
  if (totals.totalSupplyAssets === 0n) return WAD;
  const idle =
    totals.totalSupplyAssets > totals.totalBorrowAssets
      ? totals.totalSupplyAssets - totals.totalBorrowAssets
      : 0n;
  const recoveredDebt =
    collateralValueInLoanUnits < totals.totalBorrowAssets
      ? collateralValueInLoanUnits
      : totals.totalBorrowAssets;
  const backed = idle + recoveredDebt;
  const fraction = (backed * WAD) / totals.totalSupplyAssets;
  return fraction > WAD ? WAD : fraction;
}

// The collateral pile in loan-token units, valued the environment's way, folded into the backed
// fraction. `undefined` collateral value means the collateral token is one the environment does not
// price — which is the honest answer for a token the market's creator minted, and the reason the
// drain reads as a transfer.
function marketBackedFraction(
  m: MarketValuation,
  fairByBase: Record<string, number>,
  stablePrices?: Parameters<typeof tokenAmountUsd>[3],
): bigint {
  const collateralUsd = tokenAmountUsd(
    m.params.collateralToken,
    m.totals.totalCollateralAssets,
    fairByBase,
    stablePrices,
  );
  const loanUnitUsd = tokenAmountUsd(
    m.params.loanToken,
    WAD,
    fairByBase,
    stablePrices,
  );
  // loan-token units per USD, derived from a 1e18 probe so decimals cancel.
  const collateralInLoanUnits =
    collateralUsd !== undefined && loanUnitUsd !== undefined && loanUnitUsd > 0
      ? BigInt(Math.floor((collateralUsd / loanUnitUsd) * 1e18))
      : 0n;
  return backedFraction(m.totals, collateralInLoanUnits);
}

// One agent's position in one market, under the rule above: the supply side pro-rata on what backs
// the market, the borrow side collateral minus debt floored at zero, every token at the
// environment's prices. Returns the USD value and what the marking left out, said out loud.
function positionValue(
  m: MarketValuation,
  fraction: bigint,
  position: readonly [bigint, bigint, bigint],
  fairByBase: Record<string, number>,
  stablePrices?: Parameters<typeof tokenAmountUsd>[3],
): {
  usd: number;
  unpriced: UnpricedHoldingDetail[];
  longs: StableUnits;
  shorts: StableUnits;
} {
  const [supplyAssets, borrowAssets, collateral] = position;
  let usd = 0;
  const unpriced: UnpricedHoldingDetail[] = [];
  // A market-priced stable among the legs was counted here at the mid. The scorer re-marks the
  // holder's whole amount at their own size, so the raw units travel with the value (#205).
  const longs: StableUnits = {};
  const shorts: StableUnits = {};

  // --- supply side: pro-rata on what actually backs the market ---
  if (supplyAssets > 0n) {
    const recoverable = (supplyAssets * fraction) / WAD;
    const value = tokenAmountUsd(
      m.params.loanToken,
      recoverable,
      fairByBase,
      stablePrices,
    );
    if (value === undefined) {
      unpriced.push({
        source: `lending-supply:${m.id.slice(0, 10)}`,
        token: m.params.loanToken,
        amountRaw: recoverable.toString(),
        reason: "unpriced",
      });
    } else {
      usd += value;
      addStableUnits(longs, m.params.loanToken, recoverable, stablePrices);
    }
    // What the marking took away, said out loud. A supply position that shrank because the
    // collateral behind it is worthless must not look like a trading loss.
    if (fraction < WAD) {
      unpriced.push({
        source: `lending-unbacked:${m.id.slice(0, 10)}`,
        token: m.params.loanToken,
        amountRaw: (supplyAssets - recoverable).toString(),
        reason: "unrealizable",
      });
    }
  }

  // --- borrow side: collateral minus debt, floored at zero ---
  if (collateral > 0n || borrowAssets > 0n) {
    const collateralValueUsd = tokenAmountUsd(
      m.params.collateralToken,
      collateral,
      fairByBase,
      stablePrices,
    );
    const debtUsd =
      tokenAmountUsd(
        m.params.loanToken,
        borrowAssets,
        fairByBase,
        stablePrices,
      ) ?? 0;
    // Floored, because a borrower whose collateral is worth less than the debt can drop the
    // collateral and walk away. The same rule the Liquity adapter applies below 100% ICR.
    const net = Math.max(0, (collateralValueUsd ?? 0) - debtUsd);
    usd += net;
    // Only a position the floor did not zero counted its legs at all.
    if (net > 0) {
      addStableUnits(longs, m.params.collateralToken, collateral, stablePrices);
      addStableUnits(shorts, m.params.loanToken, borrowAssets, stablePrices);
    }
    if (collateral > 0n && collateralValueUsd === undefined) {
      unpriced.push({
        source: `lending-collateral:${m.id.slice(0, 10)}`,
        token: m.params.collateralToken,
        amountRaw: collateral.toString(),
        reason: "unpriced",
      });
    }
  }
  return { usd, unpriced, longs, shorts };
}

function readFailed(source: string, read: string): UnpricedHoldingDetail {
  return { source, amountRaw: "", reason: "read-failed", read };
}

async function* lendingValuationRun(
  singleton: Address,
  ctx: ValuationContext,
): ValuationRun {
  const out: Record<string, AgentProtocolValue> = {};
  for (const a of ctx.agents)
    out[a.id] = { valueUsdc: 0, liquidatableValueUsdc: 0, unpriced: [] };
  if (ctx.agents.length === 0) return out;

  // Stage 1: which markets each agent has ever entered, from the contract's per-user index. One
  // read per agent whatever the market count, and the only list that bounds it is the agent's own.
  // Never the newest N of `marketIds()`: that cut was by a list anyone could extend, so N empty
  // markets opened after a victim's market pushed the victim's position out of the valuation, and
  // the zero that replaced it looked like a trading loss (issue #212).
  const indexResults = (yield ctx.agents.map((agent) => ({
    address: singleton,
    abi: simpleLendingAbi,
    functionName: "userMarketIdsFrom",
    args: [agent.address, 0n, BigInt(USER_MARKET_LIMIT)],
  })) as ValuationRead[]) as unknown[];

  const idsByAgent = new Map<string, `0x${string}`[]>();
  ctx.agents.forEach((agent, i) => {
    const raw = indexResults[i] as
      | readonly [readonly `0x${string}`[], bigint]
      | undefined;
    if (!raw || !Array.isArray(raw[0])) {
      // Unknown, not zero (issue #44): the agent may well hold positions here.
      out[agent.id].unpriced.push(
        readFailed("lending-markets", "SimpleLending.userMarketIdsFrom"),
      );
      idsByAgent.set(agent.id, []);
      return;
    }
    const ids = [...raw[0]];
    const total = Number(raw[1]);
    // Beyond the per-agent bound: the agent's own doing (nobody else writes its index), and
    // reported rather than silently left out of its value.
    if (total > ids.length)
      out[agent.id].unpriced.push(
        readFailed(
          "lending-unscanned",
          `SimpleLending.userMarketIdsFrom: ${ids.length} of ${total} markets read ` +
            `(USER_MARKET_LIMIT ${USER_MARKET_LIMIT}); positions in the rest are not in this value`,
        ),
      );
    idsByAgent.set(agent.id, ids);
  });
  const ids = [...new Set([...idsByAgent.values()].flat())];
  if (ids.length === 0) return out;

  // Stage 2: parameters and totals of every market anybody is in.
  const marketResults = (yield ids.flatMap((id) => [
    { address: singleton, abi: simpleLendingAbi, functionName: "marketParams", args: [id] },
    { address: singleton, abi: simpleLendingAbi, functionName: "market", args: [id] },
  ]) as ValuationRead[]) as unknown[];
  const markets = new Map<string, MarketValuation>();
  ids.forEach((id, i) => {
    const params = decodeParams(marketResults[i * 2]);
    const totals = decodeTotals(marketResults[i * 2 + 1]);
    if (params && totals) markets.set(id, { id, params, totals });
  });

  // Stage 3: each agent's position in each market it entered -- the pairs the index names, not
  // markets x agents. A market with nothing in it holds nobody's position (marketIsEmpty), so
  // those pairs are not read; a market that could not be read is reported for everyone in it.
  const pairs: Array<{ agent: ValuationAgent; m: MarketValuation }> = [];
  for (const agent of ctx.agents) {
    for (const id of idsByAgent.get(agent.id) ?? []) {
      const m = markets.get(id);
      if (!m) {
        out[agent.id].unpriced.push(
          readFailed(
            `lending-market:${id.slice(0, 10)}`,
            "SimpleLending.marketParams / market",
          ),
        );
        continue;
      }
      if (marketIsEmpty(m.totals)) continue;
      pairs.push({ agent, m });
    }
  }
  if (pairs.length === 0) return out;
  const positionResults = (yield pairs.map(({ agent, m }) => ({
    address: singleton,
    abi: simpleLendingAbi,
    functionName: "expectedPosition",
    args: [paramsTuple(m.params), agent.address],
  })) as ValuationRead[]) as unknown[];

  const fairByBase = ctx.fairByBase();
  const stablePrices = ctx.stablePrices();
  const fractionById = new Map<string, bigint>();
  pairs.forEach(({ agent, m }, i) => {
    const raw = positionResults[i] as readonly [bigint, bigint, bigint] | undefined;
    const target = out[agent.id];
    if (!raw) {
      target.unpriced.push(
        readFailed(
          `lending-position:${m.id.slice(0, 10)}`,
          "SimpleLending.expectedPosition",
        ),
      );
      return;
    }
    const [supplyAssets, borrowAssets, collateral] = raw;
    if (supplyAssets === 0n && borrowAssets === 0n && collateral === 0n) return;
    let fraction = fractionById.get(m.id);
    if (fraction === undefined) {
      fraction = marketBackedFraction(m, fairByBase, stablePrices);
      fractionById.set(m.id, fraction);
    }
    const { usd, unpriced, longs, shorts } = positionValue(
      m,
      fraction,
      raw,
      fairByBase,
      stablePrices,
    );
    target.valueUsdc += usd;
    target.liquidatableValueUsdc += usd;
    target.unpriced.push(...unpriced);
    if (Object.keys(longs).length > 0) {
      target.stableLongs ??= {};
      mergeStableUnits(target.stableLongs, longs);
    }
    if (Object.keys(shorts).length > 0) {
      target.stableShorts ??= {};
      mergeStableUnits(target.stableShorts, shorts);
    }
  });

  return out;
}

// One agent's value in this venue at the current block, for the end-of-run PnL path.
//
// Same rule as the historical valuation above, through the same `marketBackedFraction` /
// `positionValue`, and the same source of markets: the agent's own index, never a slice of the
// whole list. What differs is only the batching -- the staged generator exists to merge reads across
// agents and blocks, and this path has one agent and one block.
export async function liveLendingValueUsdc(
  ctx: SimContext,
  agent: Address,
  fairPrice: number,
): Promise<number> {
  const singleton = ctx.lending;
  if (!singleton) return 0;
  const fairByBase = ctx.fairPrices ?? { WETH: fairPrice };
  let ids: `0x${string}`[];
  try {
    ids = (await readUserMarketIds(ctx.publicClient, singleton, agent, USER_MARKET_LIMIT)).ids;
  } catch {
    return 0;
  }
  if (ids.length === 0) return 0;
  let markets: MarketValuation[];
  let positions: MulticallResult[];
  try {
    const [totalsById, paramsById] = await Promise.all([
      readTotals(ctx.publicClient, singleton, ids),
      readParams(ctx.publicClient, singleton, ids),
    ]);
    markets = ids
      .filter((id) => paramsById[id] && totalsById[id] && !marketIsEmpty(totalsById[id]))
      .map((id) => ({ id, params: paramsById[id], totals: totalsById[id] }));
    if (markets.length === 0) return 0;
    positions = await multicall(
      ctx.publicClient,
      markets.map((m) => ({
        address: singleton,
        abi: simpleLendingAbi,
        functionName: "expectedPosition",
        args: [paramsTuple(m.params), agent],
      })),
    );
  } catch {
    return 0;
  }

  let total = 0;
  markets.forEach((m, i) => {
    const raw = positions[i];
    if (raw.status !== "success" || !Array.isArray(raw.result)) return;
    const position = raw.result as unknown as readonly [bigint, bigint, bigint];
    total += positionValue(m, marketBackedFraction(m, fairByBase), position, fairByBase).usd;
  });
  return total;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const lendingAdapter: ProtocolAdapter = {
  id: "lending",
  parse,
  // Every call is an ordinary contract call, so a lending leg can ride in a bundle — which is what
  // makes "create the market and seed it in one block" possible for the creator, and what makes an
  // atomic borrow-and-exit possible for everyone else.
  bundleable: () => true,
  validate,

  async readState(ctx): Promise<LendingState> {
    return readLendingState(ctx);
  },

  async observe(ctx, state, agent): Promise<LendingObservation | undefined> {
    return observeLending(ctx, (state as LendingState) ?? EMPTY_STATE, agent);
  },

  async buildTxs(ctx, owner, action): Promise<BuiltTx[]> {
    return buildLendingTxs(ctx, owner, action);
  },

  async valueUsdc(ctx, agent, _state, fairPrice): Promise<number> {
    // The end-of-run PnL path values venues one agent at a time. Returning 0 here was wrong in the
    // way this whole issue is about: `netPnlUsdc` is a headline number, and a position sitting
    // inside the venue read as a total loss. Measured in a live run -- a lender with 7,500 USDC
    // supplied and a borrower with 2 WETH of collateral both showed the full amount as a trading
    // loss while the scored series (valueAtBlock) had them roughly flat.
    //
    // The rule is the same one valueAtBlock applies: recoverable, at the *environment's* prices.
    // The market's own oracle decides liquidations and never writes a mark.
    // The chain is read here rather than taken from the argument: the end-of-run path passes
    // `null` for every adapter (every other one reads the chain itself), and treating that as an
    // empty state is what produced the zero. The markets come from the agent's own index, so the
    // number agrees with the historical series instead of quietly omitting a position that sits
    // behind newer markets.
    return liveLendingValueUsdc(ctx, agent, fairPrice);
  },

  valueAtBlock(ctx) {
    const singleton = lendingSingleton();
    if (!singleton) {
      const empty: Record<string, AgentProtocolValue> = {};
      for (const a of ctx.agents)
        empty[a.id] = { valueUsdc: 0, liquidatableValueUsdc: 0, unpriced: [] };
      return (async function* () {
        return empty;
      })();
    }
    return lendingValuationRun(singleton, ctx);
  },

  async accountedTokens(): Promise<Address[]> {
    // Nothing: every token here is somebody else's, and a holding of one should stay visible as an
    // unaccounted one rather than being excused by this venue.
    return [];
  },

  // No standing approvals. Every interaction approves exactly what it spends (see exactApproveTx).
  async setupWallet(): Promise<BuiltTx[]> {
    return [];
  },
};

// The scorer's valuation context has no SimContext, so the singleton address reaches it through the
// same module-level channel the other per-run contracts use. Set once at startup by whoever knows
// it (the coordinator after deploy, the agent runtime from its env).
let SINGLETON: Address | undefined;

export function setLendingSingleton(address: Address | undefined): void {
  SINGLETON = address;
}

export function lendingSingleton(): Address | undefined {
  return SINGLETON;
}
