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
import { tokenAmountUsd, type UnpricedAmount } from "../valuation.js";
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

// A market with nothing in it cannot hold anybody's position -- supply, borrow and collateral are
// all zero, so every position in it is zero by construction. That is what makes dropping them exact
// rather than a heuristic, and it is what collapses a spam attack of N empty markets to no
// per-agent reads at all.
export function marketIsEmpty(totals: MarketTotals | undefined): boolean {
  if (!totals) return true;
  return (
    totals.totalSupplyAssets === 0n &&
    totals.totalBorrowAssets === 0n &&
    totals.totalCollateralAssets === 0n
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
  {
    type: "function",
    name: "marketIds",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32[]" }],
  },
  {
    type: "function",
    name: "marketCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
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

export async function readLendingState(
  ctx: SimContext,
  // How many markets the result carries. The observation wants a readable handful; the end-of-run
  // valuation wants every market anybody is actually in, which is what `marketIsEmpty` bounds.
  limit: number = LENDING_OBSERVATION_LIMIT,
): Promise<LendingState> {
  const singleton = ctx.lending;
  if (!singleton) return EMPTY_STATE;
  const { publicClient } = ctx;
  let ids: `0x${string}`[];
  try {
    ids = [
      ...((await publicClient.readContract({
        address: singleton,
        abi: simpleLendingAbi,
        functionName: "marketIds",
      })) as readonly `0x${string}`[]),
    ];
  } catch {
    // A run whose singleton is not there yet reads as "no markets", not as a failed block.
    return { ...EMPTY_STATE, singleton };
  }
  // Newest first, and never more than the scan ceiling: the count is the creator's choice, so the
  // cost of reading it must not be.
  const scanned = ids.slice(-MARKET_SCAN_LIMIT).reverse();
  const scanDropped = ids.length - scanned.length;
  if (scanned.length === 0)
    return { ...EMPTY_STATE, singleton, marketIds: [] };

  // Totals first, for every scanned id. It is one multicall regardless of the count, and it is what
  // decides which markets are worth a second read: an empty market holds nobody's position.
  const totalsById: Record<string, MarketTotals> = {};
  const totalsResults = (await publicClient.multicall({
    contracts: scanned.map((id) => ({
      address: singleton,
      abi: simpleLendingAbi,
      functionName: "market",
      args: [id],
    })) as never,
    multicallAddress: MULTICALL3,
    allowFailure: true,
  })) as Array<{ status: "success" | "failure"; result?: unknown }>;
  scanned.forEach((id, i) => {
    const m = totalsResults[i];
    if (m.status !== "success" || !Array.isArray(m.result)) return;
    const t = m.result as bigint[];
    totalsById[id] = {
      totalSupplyAssets: t[0] ?? 0n,
      totalSupplyShares: t[1] ?? 0n,
      totalBorrowAssets: t[2] ?? 0n,
      totalBorrowShares: t[3] ?? 0n,
      lastUpdate: t[4] ?? 0n,
      totalCollateralAssets: t[5] ?? 0n,
    };
  });

  // Markets somebody is actually in come first; empty ones fill whatever room is left, because a
  // freshly created market is empty and still worth seeing before deciding to be its first lender.
  const used = scanned.filter((id) => !marketIsEmpty(totalsById[id]));
  const empty = scanned.filter((id) => marketIsEmpty(totalsById[id]));
  const selected = [...used, ...empty].slice(0, limit);
  const observationDropped = scanned.length - selected.length;

  const results = (await publicClient.multicall({
    contracts: selected.map((id) => ({
      address: singleton,
      abi: simpleLendingAbi,
      functionName: "marketParams",
      args: [id],
    })) as never,
    multicallAddress: MULTICALL3,
    allowFailure: true,
  })) as Array<{ status: "success" | "failure"; result?: unknown }>;

  const paramsById: Record<string, MarketParams> = {};
  selected.forEach((id, i) => {
    const p = results[i];
    if (p.status !== "success" || !Array.isArray(p.result)) return;
    const [loanToken, collateralToken, oracle, irm, lltv] = p.result as [
      Address,
      Address,
      Address,
      Address,
      bigint,
    ];
    paramsById[id] = { loanToken, collateralToken, oracle, irm, lltv };
  });

  // The market's own price and who can move it. Both are read here rather than in the scorer,
  // because both are things the *agent* needs and neither is allowed to write a mark.
  const oracles = [...new Set(Object.values(paramsById).map((p) => p.oracle))];
  const priceReads = (await publicClient.multicall({
    contracts: [
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
    ] as never,
    multicallAddress: MULTICALL3,
    allowFailure: true,
  })) as Array<{ status: "success" | "failure"; result?: unknown }>;

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

  return {
    singleton,
    marketIds: selected,
    paramsById,
    totalsById,
    priceById,
    oracleOwnerById,
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

export async function observeLending(
  ctx: SimContext,
  state: LendingState,
  agent: Address,
): Promise<LendingObservation> {
  const singleton = state.singleton;
  if (!singleton) return { singleton: ZERO_ADDRESS, markets: [], dropped: 0 };
  if (state.marketIds.length === 0)
    return { singleton, markets: [], dropped: state.dropped };
  const ids = state.marketIds.filter((id) => state.paramsById[id]);
  const results = (await ctx.publicClient.multicall({
    contracts: ids.flatMap((id) => [
      {
        address: singleton,
        abi: simpleLendingAbi,
        functionName: "expectedPosition",
        args: [paramsTuple(state.paramsById[id]), agent],
      },
      {
        address: singleton,
        abi: simpleLendingAbi,
        functionName: "isHealthy",
        args: [paramsTuple(state.paramsById[id]), agent],
      },
      {
        address: singleton,
        abi: simpleLendingAbi,
        functionName: "liquidationIncentiveFactor",
        args: [state.paramsById[id].lltv],
      },
    ]) as never,
    multicallAddress: MULTICALL3,
    allowFailure: true,
  })) as Array<{ status: "success" | "failure"; result?: unknown }>;

  const markets: LendingPositionObservation[] = ids.map((id, i) => {
    const params = state.paramsById[id];
    const totals = state.totalsById[id];
    const pos = results[i * 3];
    const healthy = results[i * 3 + 1];
    const lif = results[i * 3 + 2];
    const p = pos.status === "success" && Array.isArray(pos.result)
      ? (pos.result as bigint[])
      : [0n, 0n, 0n];
    const owner = state.oracleOwnerById[id];
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
      price: (state.priceById[id] ?? 0n).toString(),
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
  return { singleton, markets, dropped: state.dropped };
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

async function* lendingValuationRun(
  singleton: Address,
  ctx: ValuationContext,
): ValuationRun {
  const empty: Record<string, AgentProtocolValue> = {};
  for (const a of ctx.agents)
    empty[a.id] = { valueUsdc: 0, liquidatableValueUsdc: 0, unpriced: [] };

  // Stage 1: what markets exist at this cross-section.
  const idsResult = (yield [
    { address: singleton, abi: simpleLendingAbi, functionName: "marketIds" },
  ] as ValuationRead[]) as unknown[];
  const allIds = (idsResult[0] as readonly `0x${string}`[] | undefined) ?? [];
  // Bounded by something that is not the attacker's choice: `createMarket` is permissionless, so
  // one transaction into a batching contract can open hundreds, and the per-agent stage below is
  // markets x agents. Newest first, because a position in a market nobody has touched since block 0
  // would have to have been opened before it.
  const ids = allIds.slice(-MARKET_SCAN_LIMIT);
  if (ids.length === 0) return empty;

  // Stage 2: each market's parameters and totals.
  const marketResults = (yield ids.flatMap((id) => [
    { address: singleton, abi: simpleLendingAbi, functionName: "marketParams", args: [id] },
    { address: singleton, abi: simpleLendingAbi, functionName: "market", args: [id] },
  ]) as ValuationRead[]) as unknown[];

  const markets: MarketValuation[] = [];
  ids.forEach((id, i) => {
    const p = marketResults[i * 2] as
      | readonly [Address, Address, Address, Address, bigint]
      | undefined;
    const m = marketResults[i * 2 + 1] as readonly bigint[] | undefined;
    if (!p || !m) return;
    markets.push({
      id,
      params: {
        loanToken: p[0],
        collateralToken: p[1],
        oracle: p[2],
        irm: p[3],
        lltv: p[4],
      },
      totals: {
        totalSupplyAssets: m[0] ?? 0n,
        totalSupplyShares: m[1] ?? 0n,
        totalBorrowAssets: m[2] ?? 0n,
        totalBorrowShares: m[3] ?? 0n,
        lastUpdate: m[4] ?? 0n,
        totalCollateralAssets: m[5] ?? 0n,
      },
    });
  });
  // A market with nothing in it holds nobody's position -- supply, borrow and collateral are all
  // zero, so every position in it is zero by construction. Dropping them is exact rather than a
  // heuristic, and it is what stops a spam attack from turning the per-agent stage into
  // markets x agents reads for markets nobody is in.
  const inhabited = markets.filter((m) => !marketIsEmpty(m.totals));
  if (inhabited.length === 0) return empty;

  // Stage 3: every agent's position in every market anybody is in.
  const positionResults = (yield inhabited.flatMap((m) =>
    ctx.agents.map((agent) => ({
      address: singleton,
      abi: simpleLendingAbi,
      functionName: "expectedPosition",
      args: [paramsTuple(m.params), agent.address],
    })),
  ) as ValuationRead[]) as unknown[];

  const fairByBase = ctx.fairByBase();
  const stablePrices = ctx.stablePrices();
  const out: Record<string, AgentProtocolValue> = {};
  for (const a of ctx.agents)
    out[a.id] = { valueUsdc: 0, liquidatableValueUsdc: 0, unpriced: [] };

  inhabited.forEach((m, mi) => {
    // The collateral pile, in loan-token units, valued the environment's way. `undefined` means the
    // collateral token is one the environment does not price — which is the honest answer for a
    // token the market's creator minted, and the reason the drain reads as a transfer.
    const collateralUsd = tokenAmountUsd(
      m.params.collateralToken,
      m.totals.totalCollateralAssets,
      fairByBase,
      stablePrices,
    );
    const loanUnitUsd = tokenAmountUsd(
      m.params.loanToken,
      10n ** 18n,
      fairByBase,
      stablePrices,
    );
    // loan-token units per USD, derived from a 1e18 probe so decimals cancel.
    const collateralInLoanUnits =
      collateralUsd !== undefined && loanUnitUsd !== undefined && loanUnitUsd > 0
        ? BigInt(Math.floor((collateralUsd / loanUnitUsd) * 1e18))
        : 0n;
    const fraction = backedFraction(m.totals, collateralInLoanUnits);

    ctx.agents.forEach((agent, ai) => {
      const raw = positionResults[mi * ctx.agents.length + ai] as
        | readonly [bigint, bigint, bigint]
        | undefined;
      if (!raw) return;
      const [supplyAssets, borrowAssets, collateral] = raw;
      if (supplyAssets === 0n && borrowAssets === 0n && collateral === 0n) return;
      const target = out[agent.id];
      const unpriced: UnpricedHoldingDetail[] = [];

      // --- supply side: pro-rata on what actually backs the market ---
      if (supplyAssets > 0n) {
        const recoverable = (supplyAssets * fraction) / WAD;
        const usd = tokenAmountUsd(
          m.params.loanToken,
          recoverable,
          fairByBase,
          stablePrices,
        );
        if (usd === undefined) {
          unpriced.push({
            source: `lending-supply:${m.id.slice(0, 10)}`,
            token: m.params.loanToken,
            amountRaw: recoverable.toString(),
            reason: "unpriced",
          });
        } else {
          target.valueUsdc += usd;
          target.liquidatableValueUsdc += usd;
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
        const collateralValueUsd =
          tokenAmountUsd(
            m.params.collateralToken,
            collateral,
            fairByBase,
            stablePrices,
          ) ?? 0;
        const debtUsd =
          tokenAmountUsd(
            m.params.loanToken,
            borrowAssets,
            fairByBase,
            stablePrices,
          ) ?? 0;
        // Floored, because a borrower whose collateral is worth less than the debt can drop the
        // collateral and walk away. The same rule the Liquity adapter applies below 100% ICR.
        const net = Math.max(0, collateralValueUsd - debtUsd);
        target.valueUsdc += net;
        target.liquidatableValueUsdc += net;
        if (
          collateral > 0n &&
          tokenAmountUsd(
            m.params.collateralToken,
            collateral,
            fairByBase,
            stablePrices,
          ) === undefined
        ) {
          unpriced.push({
            source: `lending-collateral:${m.id.slice(0, 10)}`,
            token: m.params.collateralToken,
            amountRaw: collateral.toString(),
            reason: "unpriced",
          });
        }
      }
      target.unpriced.push(...unpriced);
    });
  });

  return out;
}

// One agent's value in this venue at the current block, for the end-of-run PnL path.
//
// Same rule as the historical valuation above and deliberately a separate implementation of it: the
// staged generator exists to batch reads across agents and blocks, and this path has one agent and
// one block. What must not differ is the *rule*, so both go through `backedFraction` and both price
// tokens with the environment's prices rather than with the market's oracle.
export async function liveLendingValueUsdc(
  ctx: SimContext,
  agent: Address,
  state: LendingState,
  fairPrice: number,
): Promise<number> {
  const singleton = state.singleton;
  if (!singleton || state.marketIds.length === 0) return 0;
  const ids = state.marketIds.filter((id) => state.paramsById[id]);
  if (ids.length === 0) return 0;
  const fairByBase = ctx.fairPrices ?? { WETH: fairPrice };
  let positions: Array<{ status: string; result?: unknown }>;
  try {
    positions = (await ctx.publicClient.multicall({
      contracts: ids.map((id) => ({
        address: singleton,
        abi: simpleLendingAbi,
        functionName: "expectedPosition",
        args: [paramsTuple(state.paramsById[id]), agent],
      })) as never,
      multicallAddress: MULTICALL3,
      allowFailure: true,
    })) as Array<{ status: string; result?: unknown }>;
  } catch {
    return 0;
  }

  let total = 0;
  ids.forEach((id, i) => {
    const raw = positions[i];
    if (raw.status !== "success" || !Array.isArray(raw.result)) return;
    const [supplyAssets, borrowAssets, collateral] = raw.result as bigint[];
    const params = state.paramsById[id];
    const totals = state.totalsById[id];
    if (!totals) return;

    const collateralUsd = tokenAmountUsd(
      params.collateralToken,
      totals.totalCollateralAssets,
      fairByBase,
    );
    const loanUnitUsd = tokenAmountUsd(params.loanToken, WAD, fairByBase);
    const collateralInLoanUnits =
      collateralUsd !== undefined && loanUnitUsd !== undefined && loanUnitUsd > 0
        ? BigInt(Math.floor((collateralUsd / loanUnitUsd) * 1e18))
        : 0n;
    const fraction = backedFraction(totals, collateralInLoanUnits);

    if (supplyAssets > 0n) {
      total +=
        tokenAmountUsd(
          params.loanToken,
          (supplyAssets * fraction) / WAD,
          fairByBase,
        ) ?? 0;
    }
    if (collateral > 0n || borrowAssets > 0n) {
      const collateralValue =
        tokenAmountUsd(params.collateralToken, collateral, fairByBase) ?? 0;
      const debt = tokenAmountUsd(params.loanToken, borrowAssets, fairByBase) ?? 0;
      total += Math.max(0, collateralValue - debt);
    }
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

  async observe(ctx, state, agent): Promise<LendingObservation> {
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
    // The state is read here rather than taken from the argument: the end-of-run path passes
    // `null` for every adapter (every other one reads the chain itself), and treating that as an
    // empty state is what produced the zero. Read up to the scan ceiling rather than the
    // observation's handful, so the number agrees with the historical series instead of quietly
    // omitting a position that sits in an older market.
    if (!ctx.lending) return 0;
    const state = await readLendingState(ctx, MARKET_SCAN_LIMIT);
    return liveLendingValueUsdc(ctx, agent, state, fairPrice);
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
