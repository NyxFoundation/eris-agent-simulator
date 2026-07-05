import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  maxUint256,
  parseAbiParameters,
  toBytes,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GMX, GMX_MARKETS, TOKENS, stableBalanceOf } from "../constants.js";
import { marketFor, marketsFor, tokenInfo } from "../markets.js";
import { baseFairPrice } from "./marketHelpers.js";
import {
  accountAddress,
  increaseTime,
  mine,
  sendAndMine,
  sendAsImpersonated,
  sendNoMine,
} from "../chain.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  GmxObservation,
  GmxPositionObservation,
  LeafAction,
  TokenSymbol,
} from "../types.js";
import type {
  BuiltTx,
  ProtocolAdapter,
  SimContext,
  ValidationResult,
} from "./types.js";
import { deployContract } from "./deploy.js";

const DECIMAL_INTEGER = /^[0-9]+$/;
export const EXECUTION_FEE = 30_000_000_000_000_000n; // 0.03 ETH
const ORDER_TYPE = { MarketIncrease: 2, MarketDecrease: 4 } as const;
const DECREASE_SWAP_NO_SWAP = 0;
const FLOAT_PRECISION = 10n ** 30n;

// ---- Roles/keys (keccak256(abi.encode(string))) ----
function hashString(s: string): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("string"), [s]));
}
const ROLES = {
  ROLE_ADMIN: hashString("ROLE_ADMIN"),
  CONTROLLER: hashString("CONTROLLER"),
  CONFIG_KEEPER: hashString("CONFIG_KEEPER"),
  ORDER_KEEPER: hashString("ORDER_KEEPER"),
  LIQUIDATION_KEEPER: hashString("LIQUIDATION_KEEPER"),
  ADL_KEEPER: hashString("ADL_KEEPER"),
} as const;
const IS_ORACLE_PROVIDER_ENABLED = hashString("IS_ORACLE_PROVIDER_ENABLED");
const ORACLE_PROVIDER_FOR_TOKEN = hashString("ORACLE_PROVIDER_FOR_TOKEN");
const MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR = hashString(
  "MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR",
);
function isOracleProviderEnabledKey(provider: Address): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, address"), [
      IS_ORACLE_PROVIDER_ENABLED,
      provider,
    ]),
  );
}
function oracleProviderForTokenKey(oracle: Address, token: Address): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, address, address"), [
      ORACLE_PROVIDER_FOR_TOKEN,
      oracle,
      token,
    ]),
  );
}

// GMX price = usd * 10^(30 - tokenDecimals)
export function toGmxPrice(usd: number, tokenDecimals: number): bigint {
  const P = 1_000_000n;
  const usdScaled = BigInt(Math.round(usd * Number(P)));
  return (usdScaled * 10n ** BigInt(30 - tokenDecimals)) / P;
}

// ---- ABIs (from reference bot/src/abis.ts) ----
const roleStoreAbi = [
  {
    type: "function",
    name: "grantRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "roleKey", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "roleKey", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "getRoleMembers",
    stateMutability: "view",
    inputs: [
      { name: "roleKey", type: "bytes32" },
      { name: "start", type: "uint256" },
      { name: "end", type: "uint256" },
    ],
    outputs: [{ type: "address[]" }],
  },
] as const;

const dataStoreAbi = [
  {
    type: "function",
    name: "setBool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "bytes32" },
      { name: "value", type: "bool" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "setAddress",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "bytes32" },
      { name: "value", type: "address" },
    ],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "setUint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "bytes32" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const mockOracleProviderAbi = [
  {
    type: "function",
    name: "setPrice",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "min", type: "uint256" },
      { name: "max", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const createOrderParamsComponents = [
  {
    name: "addresses",
    type: "tuple",
    components: [
      { name: "receiver", type: "address" },
      { name: "cancellationReceiver", type: "address" },
      { name: "callbackContract", type: "address" },
      { name: "uiFeeReceiver", type: "address" },
      { name: "market", type: "address" },
      { name: "initialCollateralToken", type: "address" },
      { name: "swapPath", type: "address[]" },
    ],
  },
  {
    name: "numbers",
    type: "tuple",
    components: [
      { name: "sizeDeltaUsd", type: "uint256" },
      { name: "initialCollateralDeltaAmount", type: "uint256" },
      { name: "triggerPrice", type: "uint256" },
      { name: "acceptablePrice", type: "uint256" },
      { name: "executionFee", type: "uint256" },
      { name: "callbackGasLimit", type: "uint256" },
      { name: "minOutputAmount", type: "uint256" },
      { name: "validFromTime", type: "uint256" },
    ],
  },
  { name: "orderType", type: "uint8" },
  { name: "decreasePositionSwapType", type: "uint8" },
  { name: "isLong", type: "bool" },
  { name: "shouldUnwrapNativeToken", type: "bool" },
  { name: "autoCancel", type: "bool" },
  { name: "referralCode", type: "bytes32" },
  { name: "dataList", type: "bytes32[]" },
] as const;

const exchangeRouterAbi = [
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
  {
    type: "function",
    name: "sendWnt",
    stateMutability: "payable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sendTokens",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "createOrder",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: createOrderParamsComponents,
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const setPricesParamsComponent = {
  name: "oracleParams",
  type: "tuple",
  components: [
    { name: "tokens", type: "address[]" },
    { name: "providers", type: "address[]" },
    { name: "data", type: "bytes[]" },
  ],
} as const;
const orderHandlerAbi = [
  {
    type: "function",
    name: "executeOrder",
    stateMutability: "nonpayable",
    inputs: [{ name: "key", type: "bytes32" }, setPricesParamsComponent],
    outputs: [],
  },
] as const;

const positionPropsComponents = [
  {
    name: "addresses",
    type: "tuple",
    components: [
      { name: "account", type: "address" },
      { name: "market", type: "address" },
      { name: "collateralToken", type: "address" },
    ],
  },
  {
    name: "numbers",
    type: "tuple",
    components: [
      { name: "sizeInUsd", type: "uint256" },
      { name: "sizeInTokens", type: "uint256" },
      { name: "collateralAmount", type: "uint256" },
      { name: "pendingImpactAmount", type: "int256" },
      { name: "borrowingFactor", type: "uint256" },
      { name: "fundingFeeAmountPerSize", type: "uint256" },
      { name: "longTokenClaimableFundingAmountPerSize", type: "uint256" },
      { name: "shortTokenClaimableFundingAmountPerSize", type: "uint256" },
      { name: "increasedAtTime", type: "uint256" },
      { name: "decreasedAtTime", type: "uint256" },
    ],
  },
  {
    name: "flags",
    type: "tuple",
    components: [{ name: "isLong", type: "bool" }],
  },
] as const;
const readerAbi = [
  {
    type: "function",
    name: "getAccountPositions",
    stateMutability: "view",
    inputs: [
      { name: "dataStore", type: "address" },
      { name: "account", type: "address" },
      { name: "start", type: "uint256" },
      { name: "end", type: "uint256" },
    ],
    outputs: [{ type: "tuple[]", components: positionPropsComponents }],
  },
] as const;

type Position = {
  addresses: { account: Address; market: Address; collateralToken: Address };
  numbers: {
    sizeInUsd: bigint;
    sizeInTokens: bigint;
    collateralAmount: bigint;
  };
  flags: { isLong: boolean };
};

const ORDER_CREATED_HASH = keccak256(toBytes("OrderCreated"));
const ORDER_CANCELLED_HASH = keccak256(toBytes("OrderCancelled"));
// For root-cause investigation (debug): identify the GMX events in the keeper executeOrder receipt by name.
const GMX_DEBUG_EVENT_HASHES: Record<string, string> = {
  OrderExecuted: keccak256(toBytes("OrderExecuted")),
  OrderCancelled: keccak256(toBytes("OrderCancelled")),
  OrderFrozen: keccak256(toBytes("OrderFrozen")),
  PositionIncrease: keccak256(toBytes("PositionIncrease")),
  PositionDecrease: keccak256(toBytes("PositionDecrease")),
};

function gmxCollateral(symbol: TokenSymbol): Address {
  return symbol === "WETH" ? TOKENS.WETH.address : TOKENS.USDC.address;
}

// Resolve the index market address from the action's base (default WETH).
// On the default fork (ctx.gmx.markets unset, single WETH market) this always returns ctx.gmx.market
// and is byte-identical to prior behavior. WBTC etc. resolve from ctx.gmx.markets / MARKET_LEGS.
function resolveGmxMarket(ctx: SimContext, base: TokenSymbol): Address {
  if (base === "WETH") return ctx.gmx.markets?.WETH ?? ctx.gmx.market;
  return (
    ctx.gmx.markets?.[base] ??
    marketFor("gmx", base)?.gmx?.market ??
    ctx.gmx.market
  );
}

// Enumerate (base, market address) for all gmx markets. Single WETH entry on the default fork.
// Prefer ctx.gmx.markets if set (base -> market); otherwise derive from MARKET_LEGS.
function gmxMarketEntries(
  ctx: SimContext,
): Array<{ base: TokenSymbol; market: Address }> {
  if (ctx.gmx.markets && Object.keys(ctx.gmx.markets).length > 0) {
    return Object.entries(ctx.gmx.markets).map(([base, market]) => ({
      base,
      market,
    }));
  }
  const entries = marketsFor("gmx")
    .filter((m) => m.gmx)
    .map((m) => ({ base: m.base, market: m.gmx!.market }));
  // For the WETH market, treat ctx.gmx.market (the address finalized by setupGlobal) as the source of truth to preserve compatibility.
  return entries.map((e) =>
    e.base === "WETH" ? { base: e.base, market: ctx.gmx.market } : e,
  );
}

function looseAcceptablePrice(isLong: boolean, isIncrease: boolean): bigint {
  // long increase / short decrease: max, to satisfy price <= acceptable
  // short increase / long decrease: 0, to satisfy price >= acceptable
  const wantMax = (isLong && isIncrease) || (!isLong && !isIncrease);
  return wantMax ? maxUint256 : 0n;
}

// Extract an ASCII-readable reason string from GMX EventEmitter eventData (hex) (for debugging).
// The OrderCancelled reason rides in eventData as an ASCII string (e.g. "OrderNotFulfillableAtAcceptablePrice"),
// so picking up readable fragments of 6+ chars reveals the root cause.
function asciiReason(data: string): string {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  let s = "";
  for (let i = 0; i + 2 <= hex.length; i += 2) {
    const c = parseInt(hex.slice(i, i + 2), 16);
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : ".";
  }
  const words = s.split(/\.+/).filter((w) => w.length >= 6);
  return words.join(" | ") || "(no ascii reason)";
}

function buildCreateOrderParams(args: {
  owner: Address;
  market: Address;
  collateralToken: Address;
  sizeDeltaUsd: bigint;
  collateralDelta: bigint;
  acceptablePrice: bigint;
  orderType: number;
  isLong: boolean;
}) {
  return {
    addresses: {
      receiver: args.owner,
      cancellationReceiver: zeroAddress,
      callbackContract: zeroAddress,
      uiFeeReceiver: zeroAddress,
      market: args.market,
      initialCollateralToken: args.collateralToken,
      swapPath: [] as Address[],
    },
    numbers: {
      sizeDeltaUsd: args.sizeDeltaUsd,
      initialCollateralDeltaAmount: args.collateralDelta,
      triggerPrice: 0n,
      acceptablePrice: args.acceptablePrice,
      executionFee: EXECUTION_FEE,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
      validFromTime: 0n,
    },
    orderType: args.orderType,
    decreasePositionSwapType: DECREASE_SWAP_NO_SWAP,
    isLong: args.isLong,
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: zeroHash,
    dataList: [] as Hex[],
  } as const;
}

function enc(
  functionName: "sendWnt" | "sendTokens" | "createOrder" | "multicall",
  args: readonly unknown[],
): Hex {
  return encodeFunctionData({
    abi: exchangeRouterAbi,
    functionName,
    args: args as never,
  });
}

function buildOrderTx(
  owner: Address,
  market: Address,
  action: LeafAction,
): BuiltTx {
  const isIncrease = action.type === "gmxIncrease";
  const a = action as {
    isLong: boolean;
    collateral: TokenSymbol;
    sizeDeltaUsd: string;
    acceptablePrice?: string;
    collateralAmount?: string;
    collateralDeltaAmount?: string;
  };
  const collateralToken = gmxCollateral(a.collateral);
  const sizeDeltaUsd = BigInt(a.sizeDeltaUsd);
  const acceptablePrice = a.acceptablePrice
    ? BigInt(a.acceptablePrice)
    : looseAcceptablePrice(a.isLong, isIncrease);

  if (isIncrease) {
    const collateralAmount = BigInt(a.collateralAmount ?? "0");
    const params = buildCreateOrderParams({
      owner,
      market,
      collateralToken,
      sizeDeltaUsd,
      collateralDelta: collateralAmount,
      acceptablePrice,
      orderType: ORDER_TYPE.MarketIncrease,
      isLong: a.isLong,
    });
    const calls: Hex[] = [];
    let value: bigint;
    if (a.collateral === "WETH") {
      const wnt = EXECUTION_FEE + collateralAmount;
      calls.push(enc("sendWnt", [GMX.OrderVault, wnt]));
      value = wnt;
    } else {
      calls.push(enc("sendWnt", [GMX.OrderVault, EXECUTION_FEE]));
      calls.push(
        enc("sendTokens", [collateralToken, GMX.OrderVault, collateralAmount]),
      );
      value = EXECUTION_FEE;
    }
    calls.push(enc("createOrder", [params]));
    return { to: GMX.ExchangeRouter, data: enc("multicall", [calls]), value };
  }

  // decrease
  const collateralDelta = BigInt(a.collateralDeltaAmount ?? "0");
  const params = buildCreateOrderParams({
    owner,
    market,
    collateralToken,
    sizeDeltaUsd,
    collateralDelta,
    acceptablePrice,
    orderType: ORDER_TYPE.MarketDecrease,
    isLong: a.isLong,
  });
  const calls: Hex[] = [
    enc("sendWnt", [GMX.OrderVault, EXECUTION_FEE]),
    enc("createOrder", [params]),
  ];
  return {
    to: GMX.ExchangeRouter,
    data: enc("multicall", [calls]),
    value: EXECUTION_FEE,
  };
}

function requireDecimalString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value))
    throw new Error(`${name} must be a decimal integer string`);
}

function parse(obj: Record<string, unknown>): LeafAction | null {
  if (obj.type !== "gmxIncrease" && obj.type !== "gmxDecrease") return null;
  if (typeof obj.isLong !== "boolean")
    throw new Error("isLong must be boolean");
  if (obj.collateral !== "WETH" && obj.collateral !== "USDC")
    throw new Error("collateral must be WETH or USDC");
  requireDecimalString(obj.sizeDeltaUsd, "sizeDeltaUsd");
  // Base of the index market (default WETH = ETH/USD; ADR 0013). Non-WETH bases require a market.
  const base = typeof obj.base === "string" ? obj.base : "WETH";
  if (base !== "WETH" && !marketFor("gmx", base)?.gmx)
    throw new Error(`gmx: no market for base "${base}"`);
  const action = {
    type: obj.type,
    isLong: obj.isLong,
    collateral: obj.collateral,
    sizeDeltaUsd: obj.sizeDeltaUsd,
  } as Record<string, unknown>;
  if (base !== "WETH") action.base = base;
  if (obj.type === "gmxIncrease") {
    requireDecimalString(obj.collateralAmount, "collateralAmount");
    action.collateralAmount = obj.collateralAmount;
  } else {
    requireDecimalString(obj.collateralDeltaAmount, "collateralDeltaAmount");
    action.collateralDeltaAmount = obj.collateralDeltaAmount;
  }
  if (obj.acceptablePrice !== undefined) {
    requireDecimalString(obj.acceptablePrice, "acceptablePrice");
    action.acceptablePrice = obj.acceptablePrice;
  }
  if (obj.maxPriorityFeePerGasWei !== undefined) {
    requireDecimalString(
      obj.maxPriorityFeePerGasWei,
      "maxPriorityFeePerGasWei",
    );
    action.maxPriorityFeePerGasWei = obj.maxPriorityFeePerGasWei;
  }
  return action as unknown as LeafAction;
}

function validate(
  action: LeafAction,
  obs: AgentObservation,
  balances: BalanceSnapshot,
): ValidationResult {
  if (action.type !== "gmxIncrease" && action.type !== "gmxDecrease")
    return { ok: false, reason: "not a gmx action" };
  const a = action as {
    type: string;
    collateral: TokenSymbol;
    sizeDeltaUsd: string;
    collateralAmount?: string;
    collateralDeltaAmount?: string;
  };
  const sizeDeltaUsd = BigInt(a.sizeDeltaUsd);
  if (sizeDeltaUsd <= 0n)
    return { ok: false, reason: "sizeDeltaUsd must be positive" };
  if (sizeDeltaUsd > BigInt(obs.limits.maxGmxSizeUsd))
    return { ok: false, reason: "sizeDeltaUsd exceeds configured max" };
  if (a.type === "gmxIncrease") {
    const collateralAmount = BigInt(a.collateralAmount ?? "0");
    if (collateralAmount <= 0n)
      return { ok: false, reason: "collateralAmount must be positive" };
    if (a.collateral === "USDC") {
      if (collateralAmount > stableBalanceOf(balances, TOKENS.USDC.address))
        return { ok: false, reason: "collateralAmount exceeds balance" };
    } else {
      // WETH collateral is sent by wrapping native ETH via sendWnt, so check collateral + execution fee against the ETH balance
      if (collateralAmount + EXECUTION_FEE > balances.ethWei)
        return {
          ok: false,
          reason: "collateralAmount + execution fee exceeds ETH balance",
        };
    }
  }
  return { ok: true };
}

// Read all of the account's positions in one call (source data for scanning markets).
async function getAccountPositions(
  publicClient: PublicClient,
  account: Address,
): Promise<Position[]> {
  return (await publicClient.readContract({
    address: GMX.Reader,
    abi: readerAbi,
    functionName: "getAccountPositions",
    args: [GMX.DataStore, account, 0n, 50n],
  })) as unknown as Position[];
}

// Pick out the "open" position for the given market address (sizeInUsd>0).
// sizeInUsd===0 is treated as effectively no position and returns undefined (matches prior observe/value behavior).
function positionForMarket(
  positions: readonly Position[],
  market: Address,
): Position | undefined {
  const p = positions.find(
    (q) => q.addresses.market.toLowerCase() === market.toLowerCase(),
  );
  return p && p.numbers.sizeInUsd !== 0n ? p : undefined;
}

// The base's index token decimals (the scale of sizeInTokens). Default WETH=18 matches prior behavior.
function baseDecimals(base: TokenSymbol): number {
  return tokenInfo(base).decimals;
}

function positionPnlUsd(
  p: Position,
  markPrice: number,
  base: TokenSymbol = "WETH",
): number {
  if (p.numbers.sizeInTokens === 0n) return 0;
  const sizeTokens = Number(p.numbers.sizeInTokens) / 10 ** baseDecimals(base);
  const entryPrice =
    Number(p.numbers.sizeInUsd) / FLOAT_PRECISION_NUM / sizeTokens;
  const diff = markPrice - entryPrice;
  return (p.flags.isLong ? diff : -diff) * sizeTokens;
}
const FLOAT_PRECISION_NUM = 1e30;

// USD valuation of a position (collateral + PnL). markPrice is the index base's price; wethPrice is the
// WETH price used to value WETH collateral (equal to markPrice on the WETH market). Collateral is valued
// at the WETH price if WETH, or $1 if USDC. On the default fork (WETH market, WETH collateral, 1e18) this
// is byte-identical to the prior formula (since markPrice===wethPrice, it matches (collateralAmount/1e18)*markPrice).
function positionValueUsd(
  p: Position,
  markPrice: number,
  base: TokenSymbol,
  wethPrice: number,
): number {
  if (p.numbers.sizeInUsd === 0n) return 0;
  const collateralUsd =
    p.addresses.collateralToken.toLowerCase() ===
    TOKENS.WETH.address.toLowerCase()
      ? (Number(p.numbers.collateralAmount) / 1e18) * wethPrice
      : Number(p.numbers.collateralAmount) / 1e6;
  return collateralUsd + positionPnlUsd(p, markPrice, base);
}

// Position -> GmxPositionObservation. entryPrice / pnl are generalized over base decimals.
// Byte-identical to the prior formula for the default WETH (18 decimals).
function gmxPositionObservation(
  p: Position,
  markPrice: number,
  base: TokenSymbol,
): GmxPositionObservation {
  const sizeTokens = Number(p.numbers.sizeInTokens) / 10 ** baseDecimals(base);
  const entryPrice =
    sizeTokens > 0
      ? Number(p.numbers.sizeInUsd) / FLOAT_PRECISION_NUM / sizeTokens
      : 0;
  const collateral: TokenSymbol =
    p.addresses.collateralToken.toLowerCase() ===
    TOKENS.WETH.address.toLowerCase()
      ? "WETH"
      : "USDC";
  return {
    isLong: p.flags.isLong,
    sizeUsd: p.numbers.sizeInUsd.toString(),
    sizeInTokens: p.numbers.sizeInTokens.toString(),
    collateral,
    collateralAmount: p.numbers.collateralAmount.toString(),
    entryPriceUsd: entryPrice,
    pnlUsd: positionPnlUsd(p, markPrice, base),
  };
}

// ---------------------------------------------------------------------------
// Historical-block reconstruction (ADR 0006 §4): the read descriptor used by the blockNumber-pinned
// multicall, plus a pure function that derives position value from its result using the same formula as valueUsdc.
// ---------------------------------------------------------------------------

export function gmxAccountPositionsCall(account: Address) {
  return {
    address: GMX.Reader,
    abi: readerAbi,
    functionName: "getAccountPositions",
    args: [GMX.DataStore, account, 0n, 50n],
  } as const;
}

// Backward-compatible signature (imported by reconstruct). Values only the WETH (ETH/USD) market at markPrice.
// Markets like WBTC are out of scope for now since reconstruct can only pass the WETH price (handled in a later Phase).
export function gmxEthUsdPositionValueUsd(
  positions: readonly Position[] | undefined,
  markPrice: number,
): number {
  const pos = positions
    ? positionForMarket(positions, GMX_MARKETS.ETH_USD)
    : undefined;
  if (!pos) return 0;
  return positionValueUsd(pos, markPrice, "WETH", markPrice);
}

export const gmxAdapter: ProtocolAdapter = {
  id: "gmx",
  stableToken: TOKENS.USDC.address,
  parse,
  bundleable: () => false, // standalone only, since it needs keeper execution
  validate,

  async readState() {
    return {};
  },

  async observe(ctx, _state, agent, fairPrice): Promise<GmxObservation> {
    const positions = await getAccountPositions(ctx.publicClient, agent);
    // Keep the WETH (ETH/USD) market at the top level as before (byte-compatible).
    const wethMarketAddr = resolveGmxMarket(ctx, "WETH");
    const wethPos = positionForMarket(positions, wethMarketAddr);
    const obs: GmxObservation = {
      marketPriceUsd: fairPrice,
      ...(wethPos
        ? { position: gmxPositionObservation(wethPos, fairPrice, "WETH") }
        : {}),
    };

    // Add non-WETH index markets (WBTC etc.) to markets. Empty on the default fork.
    const extra: Record<
      string,
      { marketPriceUsd: number; position?: GmxPositionObservation }
    > = {};
    for (const { base, market } of gmxMarketEntries(ctx)) {
      if (base === "WETH") continue;
      const price = baseFairPrice(ctx, base, fairPrice);
      const pos = positionForMarket(positions, market);
      const key = marketFor("gmx", base)?.key ?? `${base}/USDC`;
      extra[key] = {
        marketPriceUsd: price,
        ...(pos ? { position: gmxPositionObservation(pos, price, base) } : {}),
      };
    }
    if (Object.keys(extra).length > 0) obs.markets = extra;
    return obs;
  },

  async buildTxs(ctx, owner, action): Promise<BuiltTx[]> {
    const base = (action as { base?: TokenSymbol }).base ?? "WETH";
    return [buildOrderTx(owner, resolveGmxMarket(ctx, base), action)];
  },

  // The keeper fills orders created during the competition block
  async afterMine(
    ctx: SimContext,
    opts?: {
      noMine?: boolean;
      priorityFeeWei?: bigint;
      blockNumber?: bigint;
      fromBlock?: bigint;
      toBlock?: bigint;
    },
  ): Promise<void> {
    if (!ctx.gmx.mockProvider) return;
    // With a range, scan it all in one getLogs (RPC is 1/N versus calling per block for the realtime
    // catch-up). A single blockNumber keeps the old-form compatibility.
    const toBlock =
      opts?.toBlock ??
      opts?.blockNumber ??
      (await ctx.publicClient.getBlockNumber());
    const fromBlock = opts?.fromBlock ?? opts?.blockNumber ?? toBlock;
    const logs = await ctx.publicClient.getLogs({
      address: GMX.EventEmitter,
      fromBlock,
      toBlock,
    });
    const keys = logs
      .filter(
        (l) =>
          (l.topics[1]?.toLowerCase() ?? "") ===
            ORDER_CREATED_HASH.toLowerCase() && l.topics[2],
      )
      .map((l) => l.topics[2] as Hex);
    if (keys.length === 0) return;

    const keeper = privateKeyToAccount(ctx.keeperPk);
    const oracleParams = {
      tokens: [TOKENS.WETH.address, TOKENS.USDC.address],
      providers: [ctx.gmx.mockProvider, ctx.gmx.mockProvider],
      data: ["0x", "0x"] as Hex[],
    };
    const fee = opts?.priorityFeeWei ?? 1_000_000_000n;
    for (const key of keys) {
      try {
        if (opts?.noMine) {
          // realtime: neither mine nor increaseTime. Just place it in the next block
          // (time is advanced in real time by interval mining).
          const block = await ctx.publicClient.getBlock();
          const baseFee = block.baseFeePerGas ?? 0n;
          const dbgHash = await ctx.walletClient.sendTransaction({
            account: keeper,
            chain: ctx.chain,
            to: GMX.OrderHandler,
            data: encodeFunctionData({
              abi: orderHandlerAbi,
              functionName: "executeOrder",
              args: [key, oracleParams],
            }),
            gas: 15_000_000n,
            maxFeePerGas: baseFee + fee,
            maxPriorityFeePerGas: fee,
          });
          // Root-cause investigation (ERIS_GMX_KEEPER_DEBUG=1): wait for the receipt and write the OrderCancelled reason to stderr.
          // env-gated, so it does not affect normal runs (the blocking receipt wait is debug-only too).
          if (process.env.ERIS_GMX_KEEPER_DEBUG === "1") {
            try {
              const rcpt = await ctx.publicClient.waitForTransactionReceipt({
                hash: dbgHash,
                timeout: 10_000,
              });
              const gmxEvents = rcpt.logs
                .filter(
                  (l) =>
                    l.address.toLowerCase() === GMX.EventEmitter.toLowerCase(),
                )
                .map((l) => {
                  const h = l.topics[1]?.toLowerCase() ?? "";
                  for (const [name, hash] of Object.entries(
                    GMX_DEBUG_EVENT_HASHES,
                  ))
                    if (h === hash.toLowerCase()) return name;
                  return null;
                })
                .filter((x): x is string => x !== null);
              const cancel = rcpt.logs.find(
                (l) =>
                  l.address.toLowerCase() === GMX.EventEmitter.toLowerCase() &&
                  (l.topics[1]?.toLowerCase() ?? "") ===
                    ORDER_CANCELLED_HASH.toLowerCase(),
              );
              process.stderr.write(
                `[gmx-keeper-debug] key=${key.slice(0, 12)} status=${rcpt.status} events=[${gmxEvents.join(",") || "none"}]${cancel ? " reason=" + asciiReason(cancel.data) : ""}\n`,
              );
            } catch (e) {
              process.stderr.write(
                `[gmx-keeper-debug] receipt: ${e instanceof Error ? e.message : String(e)}\n`,
              );
            }
          }
          continue;
        }
        await increaseTime(ctx.publicClient, 2);
        const block = await ctx.publicClient.getBlock();
        const baseFee = block.baseFeePerGas ?? 0n;
        const hash = await ctx.walletClient.sendTransaction({
          account: keeper,
          chain: ctx.chain,
          to: GMX.OrderHandler,
          data: encodeFunctionData({
            abi: orderHandlerAbi,
            functionName: "executeOrder",
            args: [key, oracleParams],
          }),
          gas: 15_000_000n,
          maxFeePerGas: baseFee + 1_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        });
        await mine(ctx.publicClient);
        await ctx.publicClient.waitForTransactionReceipt({ hash });
      } catch (error) {
        // Skip fill failures (acceptablePrice etc.). GMX auto-cancels/refunds them.
        // Log to stderr so a persistent all-failures state (e.g. misconfigured oracle) is noticeable.
        console.error(
          `gmx keeper executeOrder failed: key=${key} ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!opts?.noMine) await mine(ctx.publicClient);
      }
    }
  },

  async valueUsdc(ctx, agent, _state, fairPrice): Promise<number> {
    const positions = await getAccountPositions(ctx.publicClient, agent);
    const wethPrice = baseFairPrice(ctx, "WETH", fairPrice);
    // Sum position values across all gmx markets, each at its base's fair price.
    // On the default fork (single WETH market) this is byte-identical to the prior formula (markPrice=wethPrice=fairPrice).
    let total = 0;
    for (const { base, market } of gmxMarketEntries(ctx)) {
      const pos = positionForMarket(positions, market);
      if (!pos) continue;
      const markPrice =
        base === "WETH" ? wethPrice : baseFairPrice(ctx, base, fairPrice);
      total += positionValueUsd(pos, markPrice, base, wethPrice);
    }
    return total;
  },

  async setupWallet(): Promise<BuiltTx[]> {
    // Approve the Router for USDC collateral (not needed for WETH collateral, which is sent natively via sendWnt)
    return [
      {
        to: TOKENS.USDC.address,
        data: encodeFunctionData({
          abi: [
            {
              type: "function",
              name: "approve",
              stateMutability: "nonpayable",
              inputs: [
                { name: "s", type: "address" },
                { name: "a", type: "uint256" },
              ],
              outputs: [{ type: "bool" }],
            },
          ] as const,
          functionName: "approve",
          args: [GMX.Router, maxUint256],
        }),
      },
    ];
  },

  async setupGlobal(ctx: SimContext): Promise<void> {
    const admin = accountAddress(ctx.adminPk);
    const keeper = accountAddress(ctx.keeperPk);
    const mock = await deployContract(ctx, "MockOracleProvider", []);

    // Get ROLE_ADMIN and grant roles
    const admins = (await ctx.publicClient.readContract({
      address: GMX.RoleStore,
      abi: roleStoreAbi,
      functionName: "getRoleMembers",
      args: [ROLES.ROLE_ADMIN, 0n, 10n],
    })) as readonly Address[];
    if (admins.length === 0) throw new Error("GMX ROLE_ADMIN holder not found");
    const roleAdmin = admins[0];
    const grants: Array<[Address, Hex]> = [
      [admin, ROLES.CONTROLLER],
      [admin, ROLES.CONFIG_KEEPER],
      [keeper, ROLES.ORDER_KEEPER],
      [keeper, ROLES.LIQUIDATION_KEEPER],
      [keeper, ROLES.ADL_KEEPER],
    ];
    for (const [account, roleKey] of grants) {
      const has = (await ctx.publicClient.readContract({
        address: GMX.RoleStore,
        abi: roleStoreAbi,
        functionName: "hasRole",
        args: [account, roleKey],
      })) as boolean;
      if (has) continue;
      await sendAsImpersonated(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        roleAdmin,
        {
          to: GMX.RoleStore,
          data: encodeFunctionData({
            abi: roleStoreAbi,
            functionName: "grantRole",
            args: [account, roleKey],
          }),
        },
      );
    }

    // DataStore: enable the mock provider + assign tokens + disable the deviation check (admin = CONTROLLER)
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: GMX.DataStore,
        data: encodeFunctionData({
          abi: dataStoreAbi,
          functionName: "setBool",
          args: [isOracleProviderEnabledKey(mock), true],
        }),
      },
    );
    for (const token of [TOKENS.WETH.address, TOKENS.USDC.address]) {
      await sendAndMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        ctx.adminPk,
        {
          to: GMX.DataStore,
          data: encodeFunctionData({
            abi: dataStoreAbi,
            functionName: "setAddress",
            args: [oracleProviderForTokenKey(GMX.Oracle, token), mock],
          }),
        },
      );
    }
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: GMX.DataStore,
        data: encodeFunctionData({
          abi: dataStoreAbi,
          functionName: "setUint",
          args: [MAX_ORACLE_REF_PRICE_DEVIATION_FACTOR, maxUint256],
        }),
      },
    );

    ctx.gmx.mockProvider = mock;
    ctx.oracle.gmxProvider = mock;
    ctx.updateGmxOracle = async (c, fairPrice, opts) => {
      const send = (tx: { to: Address; data: Hex }): Promise<unknown> =>
        opts?.noMine
          ? sendNoMine(
              c.publicClient,
              c.walletClient,
              c.chain,
              c.adminPk,
              // Set gas explicitly to skip estimateGas (which waits on anvil's execution queue)
              { ...tx, gas: 300_000n },
              opts.priorityFeeWei ?? 1_000_000_000n,
            )
          : sendAndMine(c.publicClient, c.walletClient, c.chain, c.adminPk, tx);
      await send({
        to: mock,
        data: encodeFunctionData({
          abi: mockOracleProviderAbi,
          functionName: "setPrice",
          args: [
            TOKENS.WETH.address,
            toGmxPrice(fairPrice, 18),
            toGmxPrice(fairPrice, 18),
          ],
        }),
      });
      await send({
        to: mock,
        data: encodeFunctionData({
          abi: mockOracleProviderAbi,
          functionName: "setPrice",
          args: [TOKENS.USDC.address, toGmxPrice(1, 6), toGmxPrice(1, 6)],
        }),
      });
      // ADR 0013: also update the index token of additional bases (WBTC etc.). On the default fork,
      // ctx.gmx.markets is unset or WETH-only, so this loop is empty and byte-identical to before.
      // Price is ctx.fairPrices[base], falling back to fairPrice (WETH price) if absent.
      for (const { base } of gmxMarketEntries(c)) {
        if (base === "WETH") continue; // already updated above
        const info = tokenInfo(base);
        await send({
          to: mock,
          data: encodeFunctionData({
            abi: mockOracleProviderAbi,
            functionName: "setPrice",
            args: [
              info.address,
              toGmxPrice(baseFairPrice(c, base, fairPrice), info.decimals),
              toGmxPrice(baseFairPrice(c, base, fairPrice), info.decimals),
            ],
          }),
        });
      }
    };
  },
};
