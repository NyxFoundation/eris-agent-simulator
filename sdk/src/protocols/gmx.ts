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
import { erc20Abi } from "../abis.js";
import { GMX, GMX_MARKETS, TOKENS, stableBalanceOf } from "../constants.js";
import {
  marketFor,
  marketsFor,
  tokenInfo,
  tokenInfoByAddress,
} from "../markets.js";
import { baseFairPrice } from "./marketHelpers.js";
import {
  gmxDataStoreReadAbi,
  gmxFundingFeeAmount,
  gmxFundingFeeAmountPerSizeKey,
  gmxFundingFields,
  gmxFundingIncreaseFactorKey,
  gmxMaxOpenInterestKey,
  gmxOpenInterestKey,
  gmxOpenInterestReserveFactorKey,
  gmxPoolAmountKey,
  gmxReserveFactorKey,
  gmxSavedFundingKey,
  gmxSideCapUsd,
  type GmxFundingFields,
} from "./gmxKeys.js";
import {
  accountAddress,
  increaseTime,
  isExternalChain,
  mine,
  sendAndMine,
  sendAsPrivileged,
  sendNoMine,
  setStorageAt,
  bigintToStorageWord,
} from "../chain.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  GmxMarketObservation,
  GmxObservation,
  GmxPositionObservation,
  LeafAction,
  TokenSymbol,
} from "../types.js";
import type {
  AgentProtocolValue,
  BuiltTx,
  ProtocolAdapter,
  SimContext,
  UnpricedHoldingDetail,
  ValidationResult,
} from "./types.js";
import { deployContract } from "./deploy.js";

const DECIMAL_INTEGER = /^[0-9]+$/;
export const EXECUTION_FEE = 30_000_000_000_000_000n; // 0.03 ETH
// The gas limit the keeper declares on `executeOrder` (issue #216 (2)). Measured from the `gasUsed`
// column of blocks.csv for every keeper transaction in 35 local runs (2026-09-06..27, WETH and WBTC
// markets, 49,498 executions): min 1.15M / p50 2.38M / p99 2.60M / max 2.79M. GMX refuses to execute
// unless the declared gas covers its own estimate (`increaseOrderGasLimit`: 0 in the hardhat profile,
// 3.9M in the general one) plus `minAdditionalGasForExecution` (1M), and forwards declared minus
// `minHandleExecutionErrorGasToForward` (1M) to the fill; 6M satisfies both profiles and leaves the
// fill 1.8x the largest one measured. It used to be 15M: two keeper orders then declared the whole
// 30M block (`run.blockGasLimit`) ahead of every participant, the keeper's fee sitting above the
// participant cap. Whether anvil admits by declared limit or by gas used was not measured.
export const GMX_KEEPER_EXECUTE_GAS = 6_000_000n;
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

// Order.Props as Reader.getOrder returns it (gmx-synthetics contracts/order/Order.sol). Only the
// addresses are read (gmxKeeperRefusal); the rest is declared so the tuple decodes.
const orderPropsComponents = [
  {
    name: "addresses",
    type: "tuple",
    components: [
      { name: "account", type: "address" },
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
      { name: "orderType", type: "uint8" },
      { name: "decreasePositionSwapType", type: "uint8" },
      { name: "sizeDeltaUsd", type: "uint256" },
      { name: "initialCollateralDeltaAmount", type: "uint256" },
      { name: "triggerPrice", type: "uint256" },
      { name: "acceptablePrice", type: "uint256" },
      { name: "executionFee", type: "uint256" },
      { name: "callbackGasLimit", type: "uint256" },
      { name: "minOutputAmount", type: "uint256" },
      { name: "updatedAtTime", type: "uint256" },
      { name: "validFromTime", type: "uint256" },
      { name: "srcChainId", type: "uint256" },
    ],
  },
  {
    name: "flags",
    type: "tuple",
    components: [
      { name: "isLong", type: "bool" },
      { name: "shouldUnwrapNativeToken", type: "bool" },
      { name: "isFrozen", type: "bool" },
      { name: "autoCancel", type: "bool" },
    ],
  },
  { name: "_dataList", type: "bytes32[]" },
] as const;

const readerGetOrderAbi = [
  {
    type: "function",
    name: "getOrder",
    stateMutability: "view",
    inputs: [
      { name: "dataStore", type: "address" },
      { name: "key", type: "bytes32" },
    ],
    outputs: [{ type: "tuple", components: orderPropsComponents }],
  },
] as const;

/** What the keeper needs to know about an order before it executes it. */
export type GmxKeeperOrder = {
  account: Address;
  callbackContract: Address;
  callbackGasLimit: bigint;
};

/** An order the keeper read and did not execute, and why. */
export type GmxKeeperRefusal = GmxKeeperOrder & { key: Hex; reason: string };

/**
 * Why the keeper must not execute this order, or null if it may.
 *
 * GMX calls an order's callbackContract inside executeOrder (afterOrderExecution /
 * afterOrderCancellation with the order's callbackGasLimit, refundExecutionFee with the DataStore's
 * own limit). The keeper's transaction is placed just under the oracle's, above every participant
 * (coordinator `keeperFee`), so a callback is the creator's code at the top of the next block: it
 * could take the previous block's AMM dislocation before anyone else, under the keeper's fee and gas
 * rather than the creator's (the fee cap, the per-agent gas budget and blocks.csv attribution all
 * read the transaction's sender), and -- the minimum execution fee being 0 on this deploy -- create
 * the next order from inside the callback and run again every block.
 *
 * Refused on the address alone, not on whether it has code: GMX checks for code at execution time,
 * so a CREATE2 address with nothing deployed yet is a callback the moment the creator deploys it.
 * The patched deploy (deployer/vendor/gmx-localhost.patch) also zeroes both callback gas limits, so
 * on a current deploy such an order cannot be created; this is the half that holds on a chain baked
 * before that (core/src/realtime/gmxCallbacks.ts reports which one a run is on).
 */
export function gmxKeeperRefusal(order: GmxKeeperOrder): string | null {
  if (order.callbackContract !== zeroAddress)
    return (
      `order sets callbackContract ${order.callbackContract} ` +
      `(callbackGasLimit ${order.callbackGasLimit}); the keeper does not run participant callbacks`
    );
  return null;
}

/**
 * The keys the keeper may execute, in order. Each order is read before it is executed; one that
 * cannot be read is not executed either (fail closed: it is usually an order already cancelled or
 * executed, which executeOrder would revert on anyway, and otherwise an order whose callback the
 * keeper cannot rule out).
 */
async function keeperExecutableKeys(
  ctx: SimContext,
  keys: readonly Hex[],
  onRefused?: (refusal: GmxKeeperRefusal) => void,
): Promise<Hex[]> {
  const report = (refusal: GmxKeeperRefusal): void => {
    if (onRefused) onRefused(refusal);
    else
      console.error(
        `gmx keeper refused order ${refusal.key}: ${refusal.reason}`,
      );
  };
  const reads = await Promise.all(
    keys.map(async (key) => {
      try {
        const order = await ctx.publicClient.readContract({
          address: GMX.Reader,
          abi: readerGetOrderAbi,
          functionName: "getOrder",
          args: [GMX.DataStore, key],
        });
        return { key, order };
      } catch (error) {
        return {
          key,
          error:
            error instanceof Error
              ? error.message.split("\n")[0]
              : String(error),
        };
      }
    }),
  );
  const out: Hex[] = [];
  for (const r of reads) {
    if (!("order" in r) || r.order === undefined) {
      report({
        key: r.key,
        account: zeroAddress,
        callbackContract: zeroAddress,
        callbackGasLimit: 0n,
        reason: `order could not be read: ${r.error}`,
      });
      continue;
    }
    const order: GmxKeeperOrder = {
      account: r.order.addresses.account,
      callbackContract: r.order.addresses.callbackContract,
      callbackGasLimit: r.order.numbers.callbackGasLimit,
    };
    // Reader.getOrder returns an empty struct for a key with no order (already executed or cancelled).
    if (order.account === zeroAddress) continue;
    const reason = gmxKeeperRefusal(order);
    if (reason) report({ key: r.key, ...order, reason });
    else out.push(r.key);
  }
  return out;
}

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

// Position enumeration for the liquidation keeper: every open position's key is in
// DataStore's POSITION_LIST set, whoever holds it.
const POSITION_LIST = hashString("POSITION_LIST");
const dataStoreSetAbi = [
  {
    type: "function",
    name: "getBytes32Count",
    stateMutability: "view",
    inputs: [{ name: "setKey", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getBytes32ValuesAt",
    stateMutability: "view",
    inputs: [
      { name: "setKey", type: "bytes32" },
      { name: "start", type: "uint256" },
      { name: "end", type: "uint256" },
    ],
    outputs: [{ type: "bytes32[]" }],
  },
] as const;

const liquidationHandlerAbi = [
  {
    type: "function",
    name: "executeLiquidation",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "market", type: "address" },
      { name: "collateralToken", type: "address" },
      { name: "isLong", type: "bool" },
      setPricesParamsComponent,
    ],
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
// GM (market token) valuation (issue #41). Market.Props / Price.Props / MarketPoolValueInfo.Props
// mirror gmx-synthetics; the reader prices a GM token in USD with 30 decimals.
const marketPropsComponents = [
  { name: "marketToken", type: "address" },
  { name: "indexToken", type: "address" },
  { name: "longToken", type: "address" },
  { name: "shortToken", type: "address" },
] as const;

const pricePropsComponents = [
  { name: "min", type: "uint256" },
  { name: "max", type: "uint256" },
] as const;

const marketPoolValueInfoComponents = [
  { name: "poolValue", type: "int256" },
  { name: "longPnl", type: "int256" },
  { name: "shortPnl", type: "int256" },
  { name: "netPnl", type: "int256" },
  { name: "longTokenAmount", type: "uint256" },
  { name: "shortTokenAmount", type: "uint256" },
  { name: "longTokenUsd", type: "uint256" },
  { name: "shortTokenUsd", type: "uint256" },
  { name: "totalBorrowingFees", type: "uint256" },
  { name: "borrowingFeePoolFactor", type: "uint256" },
  { name: "impactPoolAmount", type: "uint256" },
  { name: "lentImpactPoolAmount", type: "uint256" },
] as const;

// ReaderPositionUtils.PositionInfo, for what closing a position would realize. Mirrors
// gmx-synthetics (PositionPricingUtils.PositionFees, ReaderPricingUtils.ExecutionPriceResult); the
// field order is the ABI, the names are for reading.
const positionInfoComponents = [
  { name: "positionKey", type: "bytes32" },
  { name: "position", type: "tuple", components: positionPropsComponents },
  {
    name: "fees",
    type: "tuple",
    components: [
      {
        name: "referral",
        type: "tuple",
        components: [
          { name: "referralCode", type: "bytes32" },
          { name: "affiliate", type: "address" },
          { name: "trader", type: "address" },
          { name: "totalRebateFactor", type: "uint256" },
          { name: "affiliateRewardFactor", type: "uint256" },
          { name: "adjustedAffiliateRewardFactor", type: "uint256" },
          { name: "traderDiscountFactor", type: "uint256" },
          { name: "totalRebateAmount", type: "uint256" },
          { name: "traderDiscountAmount", type: "uint256" },
          { name: "affiliateRewardAmount", type: "uint256" },
        ],
      },
      {
        name: "pro",
        type: "tuple",
        components: [
          { name: "traderTier", type: "uint256" },
          { name: "traderDiscountFactor", type: "uint256" },
          { name: "traderDiscountAmount", type: "uint256" },
        ],
      },
      {
        name: "funding",
        type: "tuple",
        components: [
          { name: "fundingFeeAmount", type: "uint256" },
          { name: "claimableLongTokenAmount", type: "uint256" },
          { name: "claimableShortTokenAmount", type: "uint256" },
          { name: "latestFundingFeeAmountPerSize", type: "uint256" },
          { name: "latestLongTokenClaimableFundingAmountPerSize", type: "uint256" },
          { name: "latestShortTokenClaimableFundingAmountPerSize", type: "uint256" },
        ],
      },
      {
        name: "borrowing",
        type: "tuple",
        components: [
          { name: "borrowingFeeUsd", type: "uint256" },
          { name: "borrowingFeeAmount", type: "uint256" },
          { name: "borrowingFeeReceiverFactor", type: "uint256" },
          { name: "borrowingFeeAmountForFeeReceiver", type: "uint256" },
        ],
      },
      {
        name: "ui",
        type: "tuple",
        components: [
          { name: "uiFeeReceiver", type: "address" },
          { name: "uiFeeReceiverFactor", type: "uint256" },
          { name: "uiFeeAmount", type: "uint256" },
        ],
      },
      {
        name: "liquidation",
        type: "tuple",
        components: [
          { name: "liquidationFeeUsd", type: "uint256" },
          { name: "liquidationFeeAmount", type: "uint256" },
          { name: "liquidationFeeReceiverFactor", type: "uint256" },
          { name: "liquidationFeeAmountForFeeReceiver", type: "uint256" },
        ],
      },
      {
        name: "collateralTokenPrice",
        type: "tuple",
        components: pricePropsComponents,
      },
      { name: "positionFeeFactor", type: "uint256" },
      { name: "protocolFeeAmount", type: "uint256" },
      { name: "positionFeeReceiverFactor", type: "uint256" },
      { name: "feeReceiverAmount", type: "uint256" },
      { name: "feeAmountForPool", type: "uint256" },
      { name: "positionFeeAmountForPool", type: "uint256" },
      { name: "positionFeeAmount", type: "uint256" },
      { name: "totalCostAmountExcludingFunding", type: "uint256" },
      { name: "totalCostAmount", type: "uint256" },
      { name: "totalDiscountAmount", type: "uint256" },
    ],
  },
  {
    name: "executionPriceResult",
    type: "tuple",
    components: [
      { name: "priceImpactUsd", type: "int256" },
      { name: "executionPrice", type: "uint256" },
      { name: "balanceWasImproved", type: "bool" },
      { name: "proportionalPendingImpactUsd", type: "int256" },
      { name: "totalImpactUsd", type: "int256" },
      { name: "priceImpactDiffUsd", type: "uint256" },
    ],
  },
  { name: "basePnlUsd", type: "int256" },
  { name: "uncappedBasePnlUsd", type: "int256" },
  { name: "pnlAfterPriceImpactUsd", type: "int256" },
] as const;

const marketPricesComponents = [
  { name: "indexTokenPrice", type: "tuple", components: pricePropsComponents },
  { name: "longTokenPrice", type: "tuple", components: pricePropsComponents },
  { name: "shortTokenPrice", type: "tuple", components: pricePropsComponents },
] as const;

// Keys.MAX_PNL_FACTOR_FOR_WITHDRAWALS. Withdrawals (not deposits) is the right cap for marking a
// holding: it is the factor an exit would actually be subject to.
const MAX_PNL_FACTOR_FOR_WITHDRAWALS = hashString(
  "MAX_PNL_FACTOR_FOR_WITHDRAWALS",
);

const readerAbi = [
  {
    type: "function",
    name: "getMarket",
    stateMutability: "view",
    inputs: [
      { name: "dataStore", type: "address" },
      { name: "key", type: "address" },
    ],
    outputs: [{ type: "tuple", components: marketPropsComponents }],
  },
  {
    type: "function",
    name: "getMarketTokenPrice",
    stateMutability: "view",
    inputs: [
      { name: "dataStore", type: "address" },
      { name: "market", type: "tuple", components: marketPropsComponents },
      {
        name: "indexTokenPrice",
        type: "tuple",
        components: pricePropsComponents,
      },
      {
        name: "longTokenPrice",
        type: "tuple",
        components: pricePropsComponents,
      },
      {
        name: "shortTokenPrice",
        type: "tuple",
        components: pricePropsComponents,
      },
      { name: "pnlFactorType", type: "bytes32" },
      { name: "maximize", type: "bool" },
    ],
    outputs: [
      { type: "int256" },
      { type: "tuple", components: marketPoolValueInfoComponents },
    ],
  },
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
  {
    type: "function",
    name: "getPosition",
    stateMutability: "view",
    inputs: [
      { name: "dataStore", type: "address" },
      { name: "key", type: "bytes32" },
    ],
    outputs: [{ type: "tuple", components: positionPropsComponents }],
  },
  {
    type: "function",
    name: "isPositionLiquidatable",
    stateMutability: "view",
    inputs: [
      { name: "dataStore", type: "address" },
      { name: "referralStorage", type: "address" },
      { name: "positionKey", type: "bytes32" },
      { name: "market", type: "tuple", components: marketPropsComponents },
      { name: "prices", type: "tuple", components: marketPricesComponents },
      { name: "shouldValidateMinCollateralUsd", type: "bool" },
      { name: "forLiquidation", type: "bool" },
    ],
    outputs: [
      { type: "bool" },
      { type: "string" },
      {
        type: "tuple",
        components: [
          { name: "remainingCollateralUsd", type: "int256" },
          { name: "minCollateralUsd", type: "int256" },
          { name: "minCollateralUsdForLeverage", type: "int256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getAccountPositionInfoList",
    stateMutability: "view",
    inputs: [
      { name: "dataStore", type: "address" },
      { name: "referralStorage", type: "address" },
      { name: "account", type: "address" },
      { name: "markets", type: "address[]" },
      {
        name: "marketPrices",
        type: "tuple[]",
        components: marketPricesComponents,
      },
      { name: "uiFeeReceiver", type: "address" },
      { name: "start", type: "uint256" },
      { name: "end", type: "uint256" },
    ],
    outputs: [{ type: "tuple[]", components: positionInfoComponents }],
  },
] as const;

type Position = {
  addresses: { account: Address; market: Address; collateralToken: Address };
  numbers: {
    sizeInUsd: bigint;
    sizeInTokens: bigint;
    collateralAmount: bigint;
    // The position's snapshot of the market's funding accumulator. Decoded by the ABI all along;
    // named here since issue #78, because the difference against the market's current value is
    // what the position has accrued.
    fundingFeeAmountPerSize: bigint;
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

// ---------------------------------------------------------------------------
// Collateral and oracle tokens per market
//
// Every GMX market this environment deploys or forks is [base-base-USDC]: the index and long token
// are the market's base and the short token is USDC (ETH/USD = [WETH-WETH-USDC], BTC/USD =
// [WBTC-WBTC-USDC]). setupGlobal reads the markets from chain and refuses to start on one that is
// not, because both rules below are derived from that shape.
//
// Collateral: GMX takes either of a market's pool tokens. The adapter used to map every symbol
// that was not "WETH" to USDC, so WBTC collateral was impossible and WETH collateral on the BTC
// market produced an order GMX could not fill.

/** The collateral a gmx market accepts: its long token (= its base) or USDC. */
export function gmxAllowedCollateral(base: TokenSymbol): TokenSymbol[] {
  return base === "USDC" ? ["USDC"] : [base, "USDC"];
}

/** Why `collateral` cannot be posted on the `base` market, or undefined when it can. */
export function gmxCollateralRejection(
  base: TokenSymbol,
  collateral: TokenSymbol,
): string | undefined {
  const allowed = gmxAllowedCollateral(base);
  if (allowed.includes(collateral)) return undefined;
  return (
    `collateral ${collateral} is not accepted on the gmx ${base}/USD market: ` +
    `it takes ${allowed.join(" or ")} (the market's long token or USDC)`
  );
}

function gmxCollateral(base: TokenSymbol, symbol: TokenSymbol): Address {
  // Enforced again here, not only in validate: the environment's own flow submits without going
  // through the agent runtime's validation, and a wrong token here is an order GMX cannot fill,
  // whose collateral and execution fee then sit in the OrderVault.
  const rejection = gmxCollateralRejection(base, symbol);
  if (rejection) throw new Error(rejection);
  return tokenInfo(symbol).address;
}

type GmxMarketTokens = Pick<
  MarketProps,
  "indexToken" | "longToken" | "shortToken"
>;

/**
 * Every token the keeper has to price for an order on any of these markets: each market's index,
 * long and short token, deduplicated, in market order (WETH, USDC, WBTC on the local deploy).
 *
 * GMX reads the primary price of all three while executing an order, and a token missing from the
 * keeper's oracle params is `EmptyPrimaryPrice(token)`: the whole executeOrder reverts (it does not
 * cancel), the keeper only scans new logs so it never retries, and the collateral plus the 0.03 ETH
 * execution fee stay in the OrderVault. The keeper used to pass WETH and USDC only, which is exactly
 * that failure for every BTC/USD order. A swap-only market has a zero index token, skipped here.
 */
export function gmxOracleTokens(
  markets: readonly GmxMarketTokens[],
): Address[] {
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const m of markets) {
    for (const token of [m.indexToken, m.longToken, m.shortToken]) {
      const key = token.toLowerCase();
      if (token === zeroAddress || seen.has(key)) continue;
      seen.add(key);
      out.push(token);
    }
  }
  return out;
}

/**
 * Why a configured market does not have the [base-base-USDC] shape the collateral rule and the
 * oracle prices assume, one line per market. Empty when every market fits.
 */
export function gmxMarketLayoutProblems(
  layouts: ReadonlyArray<{
    base: TokenSymbol;
    market: Address;
    props: GmxMarketTokens;
  }>,
): string[] {
  const problems: string[] = [];
  const usdc = TOKENS.USDC.address.toLowerCase();
  for (const { base, market, props } of layouts) {
    const baseToken = TOKENS[base]?.address.toLowerCase();
    if (props.longToken === zeroAddress && props.shortToken === zeroAddress) {
      problems.push(`${base} (${market}): not a market on this deployment`);
      continue;
    }
    if (
      !baseToken ||
      props.indexToken.toLowerCase() !== baseToken ||
      props.longToken.toLowerCase() !== baseToken ||
      props.shortToken.toLowerCase() !== usdc
    )
      problems.push(
        `${base} (${market}): expected [${base}-${base}-USDC], found ` +
          `index=${props.indexToken} long=${props.longToken} short=${props.shortToken}`,
      );
  }
  return problems;
}

/** The oracle params the keeper passes to executeOrder: one mock-provider entry per oracle token. */
export function gmxKeeperOracleParams(ctx: Pick<SimContext, "gmx">): {
  tokens: Address[];
  providers: Address[];
  data: Hex[];
} {
  const provider = ctx.gmx.mockProvider;
  if (!provider) throw new Error("gmx: the mock oracle provider is not set up");
  const tokens = [
    ...(ctx.gmx.oracleTokens ?? [TOKENS.WETH.address, TOKENS.USDC.address]),
  ];
  return {
    tokens,
    providers: tokens.map(() => provider),
    data: tokens.map(() => "0x" as Hex),
  };
}

// USD per whole unit of a position's collateral token, with its decimals. USDC is the numéraire; a
// base is marked by `basePrice`. Undefined when the registry cannot place the token or the base has
// no price -- the callers report that rather than value it at a guess (every non-WETH collateral
// used to be read at USDC's scale, $1e-6 per raw unit, which put 0.05 WBTC at $5 instead of $3,000).
function collateralUnit(
  token: Address,
  basePrice: (symbol: TokenSymbol) => number | undefined,
): { usd: number; decimals: number } | undefined {
  const info = tokenInfoByAddress(token);
  if (!info) return undefined;
  if (info.kind === "stable") return { usd: 1, decimals: info.decimals };
  const usd = basePrice(info.symbol);
  if (usd === undefined || !Number.isFinite(usd)) return undefined;
  return { usd, decimals: info.decimals };
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
  base: TokenSymbol,
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
  const collateralToken = gmxCollateral(base, a.collateral);
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
      // USDC and WBTC alike: an ERC-20 pulled through the Router, which setupWallet approves.
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
  // Which symbol is right depends on the market, so that is validate's call (gmxCollateralRejection).
  if (typeof obj.collateral !== "string" || obj.collateral.length === 0)
    throw new Error(
      "collateral must be a token symbol: the market's long token (WETH on ETH/USD, WBTC on BTC/USD) or USDC",
    );
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
    base?: TokenSymbol;
    collateral: TokenSymbol;
    sizeDeltaUsd: string;
    collateralAmount?: string;
    collateralDeltaAmount?: string;
  };
  // A decrease names its position by (market, collateral, side), so the same rule applies to it.
  const rejection = gmxCollateralRejection(a.base ?? "WETH", a.collateral);
  if (rejection) return { ok: false, reason: rejection };
  const sizeDeltaUsd = BigInt(a.sizeDeltaUsd);
  if (sizeDeltaUsd <= 0n)
    return { ok: false, reason: "sizeDeltaUsd must be positive" };
  // No configured size cap. What bounds the position is the collateral behind it and GMX's own
  // reserve/open-interest configuration, which the venue enforces on chain.
  if (a.type === "gmxIncrease") {
    const collateralAmount = BigInt(a.collateralAmount ?? "0");
    if (collateralAmount <= 0n)
      return { ok: false, reason: "collateralAmount must be positive" };
    if (a.collateral === "USDC") {
      if (collateralAmount > stableBalanceOf(balances, TOKENS.USDC.address))
        return { ok: false, reason: "collateralAmount exceeds balance" };
    } else if (a.collateral === "WETH") {
      // WETH collateral is sent by wrapping native ETH via sendWnt, so check collateral + execution fee against the ETH balance
      if (collateralAmount + EXECUTION_FEE > balances.ethWei)
        return {
          ok: false,
          reason: "collateralAmount + execution fee exceeds ETH balance",
        };
    } else if (collateralAmount > (balances.bases?.[a.collateral] ?? 0n)) {
      // Another base (WBTC on its own market) is an ERC-20 sent from the wallet.
      return {
        ok: false,
        reason: `collateralAmount exceeds ${a.collateral} balance`,
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

// USD valuation of a position (collateral + PnL). markPrice is the index base's price; basePrice
// marks a base-token collateral (WETH, WBTC) and USDC collateral is $1. On the default fork (WETH
// market, WETH collateral, 1e18) this is the prior formula, (collateralAmount/1e18)*markPrice + PnL.
// Undefined when the collateral token cannot be priced.
function positionValueUsd(
  p: Position,
  markPrice: number,
  base: TokenSymbol,
  basePrice: (symbol: TokenSymbol) => number | undefined,
): number | undefined {
  if (p.numbers.sizeInUsd === 0n) return 0;
  const unit = collateralUnit(p.addresses.collateralToken, basePrice);
  if (!unit) return undefined;
  const collateralUsd =
    (Number(p.numbers.collateralAmount) / 10 ** unit.decimals) * unit.usd;
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
  // The collateral's registry symbol (WETH / WBTC / USDC). Anything else was reported as "USDC".
  const collateral: TokenSymbol =
    tokenInfoByAddress(p.addresses.collateralToken)?.symbol ??
    p.addresses.collateralToken;
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
// Funding / open interest (issue #78)
//
// GMX charges the crowded side and pays the thin one, and it publishes both the rate and the skew
// that sets it in the DataStore. Until now none of that reached an agent: GmxObservation carried
// the mark and the agent's own position, so a strategy hedging on this venue had to price its carry
// at a constant. The keys are derived in the sdk (gmxKeys.ts) and read here at the same block as
// the rest of the observation, so the agent and the post-run market series see one number.
//
// On magnitude, so nobody builds a carry trade on this: funding runs on EVM time, which is not
// warped. At the deployed factor a whole 360-block epoch accrues ~0.14bps of notional on a fully
// one-sided book and ~0.02bps at a realistic skew, against the 30bps a spot leg pays the pool. It
// is a cost term and a skew signal, not income.

// Market.Props is immutable for a deployment, so the long/short token lookup is resolved once per
// process — the same treatment aave gives its reserve token addresses. Only successes are cached:
// a market that has not resolved yet costs one read per block, and caching the miss instead would
// silently drop funding for the rest of a run that merely observed a block too early.
const marketPropsCache = new Map<string, MarketProps>();

async function resolveMarketProps(
  publicClient: PublicClient,
  markets: readonly Address[],
): Promise<Map<string, MarketProps>> {
  const missing = markets.filter(
    (m) => !marketPropsCache.has(m.toLowerCase()) && m !== zeroAddress,
  );
  if (missing.length > 0) {
    const results = (await publicClient.multicall({
      contracts: missing.map((market) => ({
        address: GMX.Reader,
        abi: readerAbi,
        functionName: "getMarket",
        args: [GMX.DataStore, market],
      })) as never,
      allowFailure: true,
    })) as Array<{ status: "success" | "failure"; result?: unknown }>;
    missing.forEach((market, i) => {
      const r = results[i];
      if (r?.status === "success")
        marketPropsCache.set(market.toLowerCase(), r.result as MarketProps);
    });
  }
  const out = new Map<string, MarketProps>();
  for (const market of markets) {
    const props = marketPropsCache.get(market.toLowerCase());
    if (props) out.set(market.toLowerCase(), props);
  }
  return out;
}

/**
 * Open interest, funding rate and whether this deploy models funding at all, per market.
 *
 * Reads never throw out of here. The observation is what an agent trades on every block, and a
 * transport hiccup on a reporting field must not take the mark and the position down with it — the
 * fields are simply absent, which is exactly what they mean (issue #44: a zero is a measurement).
 */
async function readMarketFunding(
  publicClient: PublicClient,
  markets: readonly Address[],
): Promise<Map<string, GmxFundingFields>> {
  const out = new Map<string, GmxFundingFields>();
  let props: Map<string, MarketProps>;
  try {
    props = await resolveMarketProps(publicClient, markets);
  } catch {
    return out;
  }
  const layout: Array<{ market: Address; props: MarketProps }> = [];
  for (const market of markets) {
    const p = props.get(market.toLowerCase());
    if (p) layout.push({ market, props: p });
  }
  if (layout.length === 0) return out;
  // Six reads per market, in this order: the four open-interest cells, the saved funding factor,
  // and the increase factor that says whether the saved one is even written.
  const contracts = layout.flatMap(({ props: p }) => [
    ...[
      gmxOpenInterestKey(p.marketToken, p.longToken, true),
      gmxOpenInterestKey(p.marketToken, p.shortToken, true),
      gmxOpenInterestKey(p.marketToken, p.longToken, false),
      gmxOpenInterestKey(p.marketToken, p.shortToken, false),
    ].map((key) => ({
      address: GMX.DataStore,
      abi: gmxDataStoreReadAbi,
      functionName: "getUint",
      args: [key],
    })),
    {
      address: GMX.DataStore,
      abi: gmxDataStoreReadAbi,
      functionName: "getInt",
      args: [gmxSavedFundingKey(p.marketToken)],
    },
    {
      address: GMX.DataStore,
      abi: gmxDataStoreReadAbi,
      functionName: "getUint",
      args: [gmxFundingIncreaseFactorKey(p.marketToken)],
    },
  ]);
  let results: Array<{ status: "success" | "failure"; result?: unknown }>;
  try {
    results = (await publicClient.multicall({
      contracts: contracts as never,
      allowFailure: true,
    })) as Array<{ status: "success" | "failure"; result?: unknown }>;
  } catch {
    return out;
  }
  const value = (i: number): bigint | undefined => {
    const r = results[i];
    return r?.status === "success" && typeof r.result === "bigint"
      ? r.result
      : undefined;
  };
  layout.forEach(({ market }, i) => {
    const at = i * 6;
    const saved = value(at + 4);
    const increase = value(at + 5);
    out.set(
      market.toLowerCase(),
      gmxFundingFields({
        openInterest: [value(at), value(at + 1), value(at + 2), value(at + 3)],
        ...(saved !== undefined ? { savedFundingFactorPerSecond: saved } : {}),
        ...(increase !== undefined
          ? { fundingIncreaseFactorPerSecond: increase }
          : {}),
      }),
    );
  });
  return out;
}

/**
 * What each of the agent's open positions has accrued in funding, in USD, keyed by market.
 *
 * A second stage because the key needs the position's own (collateral, side) — but only when there
 * is a position at all, so an agent holding no perp pays nothing for this.
 */
async function readPositionFundingOwed(
  publicClient: PublicClient,
  positions: readonly Position[],
  basePrice: (symbol: TokenSymbol) => number | undefined,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const open = positions.filter((p) => p.numbers.sizeInUsd > 0n);
  if (open.length === 0) return out;
  let results: Array<{ status: "success" | "failure"; result?: unknown }>;
  try {
    results = (await publicClient.multicall({
      contracts: open.map((p) => ({
        address: GMX.DataStore,
        abi: gmxDataStoreReadAbi,
        functionName: "getUint",
        args: [
          gmxFundingFeeAmountPerSizeKey(
            p.addresses.market,
            p.addresses.collateralToken,
            p.flags.isLong,
          ),
        ],
      })) as never,
      allowFailure: true,
    })) as Array<{ status: "success" | "failure"; result?: unknown }>;
  } catch {
    return out;
  }
  open.forEach((p, i) => {
    const r = results[i];
    if (r?.status !== "success" || typeof r.result !== "bigint") return;
    const amount = gmxFundingFeeAmount(
      r.result,
      p.numbers.fundingFeeAmountPerSize ?? 0n,
      p.numbers.sizeInUsd,
    );
    // The fee is denominated in the position's collateral token.
    const unit = collateralUnit(p.addresses.collateralToken, basePrice);
    if (!unit) return;
    const usd = (Number(amount) / 10 ** unit.decimals) * unit.usd;
    out.set(p.addresses.market.toLowerCase(), usd);
  });
  return out;
}

// What Reader.getAccountPositionInfoList returns per position, narrowed to what the exit value reads.
type PositionInfo = {
  position: Position;
  fees: {
    funding: {
      claimableLongTokenAmount: bigint;
      claimableShortTokenAmount: bigint;
    };
    totalCostAmount: bigint;
  };
  executionPriceResult: { totalImpactUsd: bigint };
  basePnlUsd: bigint;
};

/**
 * What closing the whole position at this block would leave the account, in USD.
 *
 * valueUsdc's collateral + PnL is the position's face, and it was the realizable value as long as the
 * deploy charged nothing to close. It now does (deployer/vendor/gmx-localhost.patch carries
 * arbitrum's position fees), and the opening fee is already out of the collateral -- so a face mark
 * charged a position that was closed both fees and one held through the bell only one. The reader
 * prices the full decrease the way DecreasePositionUtils would:
 *
 *   collateral + basePnl (capped by maxPnlFactorForTraders, as on exit)
 *   + totalImpact (the closing impact plus the impact deferred at open, capped by the max factor)
 *   - totalCost (position fee + pending borrowing + pending funding, in collateral token)
 *   + funding the position is owed (claimable in the market's long and short token)
 *
 * Undefined when the collateral or a claimable token cannot be priced.
 */
function positionExitValueUsd(
  info: PositionInfo,
  fairByBase: Record<string, number>,
  market: MarketProps | undefined,
): number | undefined {
  const p = info.position;
  if (p.numbers.sizeInUsd === 0n) return 0;
  const unit = collateralUnit(
    p.addresses.collateralToken,
    (symbol) => fairByBase[symbol],
  );
  if (!unit) return undefined;
  const collateral = p.numbers.collateralAmount - info.fees.totalCostAmount;
  let value =
    (Number(collateral) / 10 ** unit.decimals) * unit.usd +
    Number(info.basePnlUsd) / FLOAT_PRECISION_NUM +
    Number(info.executionPriceResult.totalImpactUsd) / FLOAT_PRECISION_NUM;
  const claimable: Array<[Address | undefined, bigint]> = [
    [market?.longToken, info.fees.funding.claimableLongTokenAmount],
    [market?.shortToken, info.fees.funding.claimableShortTokenAmount],
  ];
  for (const [token, amount] of claimable) {
    if (amount === 0n) continue;
    if (!token) return undefined;
    const u = collateralUnit(token, (symbol) => fairByBase[symbol]);
    if (!u) return undefined;
    value += (Number(amount) / 10 ** u.decimals) * u.usd;
  }
  return value;
}

/** One side of an account's WETH-collateral position in the ETH/USD market. */
export type GmxSideExposure = { sizeUsd: bigint; collateralWei: bigint };

/**
 * The background flow's own ETH/USD book against what the market can carry (the flow's OI target).
 *
 * The flow opened perps and never closed them, so over a practice day its positions grew until
 * both sides sat at the reserve cap and every agent's increase on either side was refused. The
 * flow reads this to close instead of open once its side passes a share of the cap. USD at 30
 * decimals; `undefined` when a read fails, which the flow treats as "no target" (the old flow)
 * rather than as a full or an empty book.
 */
export type GmxFlowExposure = {
  long: GmxSideExposure;
  short: GmxSideExposure;
  longCapUsd: bigint;
  shortCapUsd: bigint;
};

export async function readGmxFlowExposure(
  ctx: SimContext,
  account: Address,
  fairPrice: number,
): Promise<GmxFlowExposure | undefined> {
  const market = resolveGmxMarket(ctx, "WETH");
  let props: MarketProps | undefined;
  try {
    props = (await resolveMarketProps(ctx.publicClient, [market])).get(
      market.toLowerCase(),
    );
  } catch {
    return undefined;
  }
  if (!props) return undefined;
  const getUint = (key: Hex) => ({
    address: GMX.DataStore,
    abi: gmxDataStoreReadAbi,
    functionName: "getUint",
    args: [key],
  });
  const m = props.marketToken;
  let results: Array<{ status: "success" | "failure"; result?: unknown }>;
  try {
    results = (await ctx.publicClient.multicall({
      contracts: [
        gmxAccountPositionsCall(account),
        getUint(gmxPoolAmountKey(m, props.longToken)),
        getUint(gmxPoolAmountKey(m, props.shortToken)),
        ...[true, false].flatMap((isLong) => [
          getUint(gmxReserveFactorKey(m, isLong)),
          getUint(gmxOpenInterestReserveFactorKey(m, isLong)),
          getUint(gmxMaxOpenInterestKey(m, isLong)),
        ]),
      ] as never,
      allowFailure: true,
    })) as Array<{ status: "success" | "failure"; result?: unknown }>;
  } catch {
    return undefined;
  }
  const uint = (i: number): bigint | undefined => {
    const r = results[i];
    return r?.status === "success" && typeof r.result === "bigint"
      ? r.result
      : undefined;
  };
  if (results[0]?.status !== "success") return undefined;
  const positions = results[0].result as readonly Position[];
  const side = (isLong: boolean): GmxSideExposure => {
    const out: GmxSideExposure = { sizeUsd: 0n, collateralWei: 0n };
    for (const p of positions) {
      if (
        p.addresses.market.toLowerCase() !== market.toLowerCase() ||
        p.addresses.collateralToken.toLowerCase() !==
          props.longToken.toLowerCase() ||
        p.flags.isLong !== isLong
      )
        continue;
      out.sizeUsd += p.numbers.sizeInUsd;
      out.collateralWei += p.numbers.collateralAmount;
    }
    return out;
  };
  const longToken = tokenInfoByAddress(props.longToken);
  const shortToken = tokenInfoByAddress(props.shortToken);
  if (!longToken || !shortToken) return undefined;
  const longCapUsd = gmxSideCapUsd({
    poolAmount: uint(1),
    tokenPriceUsd: fairPrice,
    tokenDecimals: longToken.decimals,
    reserveFactor: uint(3),
    openInterestReserveFactor: uint(4),
    maxOpenInterest: uint(5),
  });
  const shortCapUsd = gmxSideCapUsd({
    poolAmount: uint(2),
    tokenPriceUsd: 1,
    tokenDecimals: shortToken.decimals,
    reserveFactor: uint(6),
    openInterestReserveFactor: uint(7),
    maxOpenInterest: uint(8),
  });
  if (longCapUsd === undefined || shortCapUsd === undefined) return undefined;
  return { long: side(true), short: side(false), longCapUsd, shortCapUsd };
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
  return (
    positionValueUsd(pos, markPrice, "WETH", (symbol) =>
      symbol === "WETH" ? markPrice : undefined,
    ) ?? 0
  );
}

// Sum an account's perp positions across every configured gmx market, each at its own base's fair
// price. The scorer used to value the WETH market alone -- a constraint of the old reconstruct, which
// could pass a single price -- so a WBTC/USD perp scored zero. Positions in a market the run does not
// configure, or whose base has no fair price, are reported rather than dropped.
function perpValueUsd(
  positions: readonly Position[] | undefined,
  fairByBase: Record<string, number>,
): { valueUsdc: number; unpriced: UnpricedHoldingDetail[] } {
  const unpriced: UnpricedHoldingDetail[] = [];
  if (!positions || positions.length === 0) return { valueUsdc: 0, unpriced };
  const baseByMarket = new Map<string, TokenSymbol>();
  for (const m of marketsFor("gmx")) {
    if (m.gmx) baseByMarket.set(m.gmx.market.toLowerCase(), m.base);
  }
  let valueUsdc = 0;
  for (const position of positions) {
    if (position.numbers.sizeInUsd === 0n) continue;
    const market = position.addresses.market;
    const base = baseByMarket.get(market.toLowerCase());
    const markPrice = base === undefined ? undefined : fairByBase[base];
    if (base === undefined || markPrice === undefined) {
      unpriced.push({
        token: market,
        amountRaw: position.numbers.sizeInUsd.toString(),
        source: "gmx-position",
      });
      continue;
    }
    const value = positionValueUsd(
      position,
      markPrice,
      base,
      (symbol) => fairByBase[symbol],
    );
    if (value === undefined) {
      // The collateral token has no price (WBTC collateral on a run that did not price WBTC).
      unpriced.push({
        token: position.addresses.collateralToken,
        amountRaw: position.numbers.collateralAmount.toString(),
        source: "gmx-position",
      });
      continue;
    }
    valueUsdc += value;
  }
  return { valueUsdc, unpriced };
}

type MarketProps = {
  marketToken: Address;
  indexToken: Address;
  longToken: Address;
  shortToken: Address;
};

// The GM token of every configured gmx market (in gmx-synthetics the market key is its market token).
function gmxMarketTokens(): Address[] {
  const out: Address[] = [];
  for (const m of marketsFor("gmx")) {
    const market = m.gmx?.market;
    if (!market || market === zeroAddress) continue;
    if (!out.includes(market)) out.push(market);
  }
  return out;
}

// Price.Props for a token, from the token registry. Undefined for a token we cannot price, which
// leaves the whole market unpriced rather than marked at a guess.
function gmxTokenPrice(
  token: Address,
  fairByBase: Record<string, number>,
): { min: bigint; max: bigint } | undefined {
  const info = tokenInfoByAddress(token);
  if (!info) return undefined;
  const usd = info.kind === "stable" ? 1 : fairByBase[info.symbol];
  if (usd === undefined) return undefined;
  const price = toGmxPrice(usd, info.decimals);
  return { min: price, max: price };
}

// ---------------------------------------------------------------------------
// Liquidation keeper
//
// GMX liquidates nobody by itself: LiquidationHandler.executeLiquidation is a keeper call, and the
// environment's keeper only ever executed orders. So no position was ever liquidated -- a 20x
// contrarian bet through a crash survived to the bell however far it went under, and was scored at
// its (unfloored) value there. Real keepers watch every position; this one checks every open
// position each block against the price the order keeper hands executeOrder (the run's fair price
// through the mock provider), the same check LiquidationUtils makes on chain.
// ---------------------------------------------------------------------------

// Order fills per block (issue #225). The keeper's fee sits above the participants' cap, so under
// `--order fees` its fills go first; without a bound, every order created in the scanned range was
// sent into one block. What fills a block is gas *used*, not declared -- measured 2026-10-08 on
// anvil 1.7.1: seven transactions each declaring 6,000,000 all landed in one 30,000,000 block -- and
// an executeOrder uses up to 2.79M (PR #221, 49,498 fills). Five fills are under half the block,
// leaving the oracle update and the participants their room. The rest wait, in arrival order, and
// are re-read on the next pass, so an order cancelled meanwhile is dropped rather than filled late.
export const MAX_ORDER_FILLS_PER_BLOCK = 5;
const deferredOrderKeys: Hex[] = [];
/** Test seam: the deferral queue is module state. */
export function resetKeeperOrderQueue(): void {
  deferredOrderKeys.length = 0;
}

// Liquidations per block. Each declares GMX_KEEPER_EXECUTE_GAS like an order fill; the cap keeps a
// cascade from declaring the whole block ahead of the participants. The rest go next block.
const MAX_LIQUIDATIONS_PER_BLOCK = 2;
// A liquidation sent at block B lands at B+1 at the earliest, and the next pass may run before it
// does. Not re-sending a key for this many blocks keeps the keeper from paying for a duplicate
// that would only revert.
const LIQUIDATION_RESEND_BLOCKS = 3n;
const liquidationSentAt = new Map<string, bigint>();

type LiquidatablePosition = {
  key: Hex;
  account: Address;
  market: Address;
  collateralToken: Address;
  isLong: boolean;
  reason: string;
};

/**
 * Every open position GMX would liquidate at the given prices, any account's: participants' and
 * the background flow's alike, as a real keeper would. Read-only; a failed read means no
 * liquidation this pass, never a guess.
 */
export async function gmxLiquidatablePositions(
  publicClient: PublicClient,
  fairByBase: Record<string, number>,
): Promise<LiquidatablePosition[]> {
  const count = (await publicClient.readContract({
    address: GMX.DataStore,
    abi: dataStoreSetAbi,
    functionName: "getBytes32Count",
    args: [POSITION_LIST],
  })) as bigint;
  if (count === 0n) return [];
  const keys = (await publicClient.readContract({
    address: GMX.DataStore,
    abi: dataStoreSetAbi,
    functionName: "getBytes32ValuesAt",
    args: [POSITION_LIST, 0n, count],
  })) as readonly Hex[];

  const positions = (await publicClient.multicall({
    contracts: keys.map((key) => ({
      address: GMX.Reader,
      abi: readerAbi,
      functionName: "getPosition",
      args: [GMX.DataStore, key],
    })) as never,
    allowFailure: true,
  })) as Array<{ status: "success" | "failure"; result?: unknown }>;

  const open: Array<{ key: Hex; position: Position }> = [];
  positions.forEach((r, i) => {
    if (r.status !== "success") return;
    const position = r.result as Position;
    if (position.numbers.sizeInUsd > 0n) open.push({ key: keys[i], position });
  });
  if (open.length === 0) return [];

  const props = await resolveMarketProps(publicClient, [
    ...new Set(open.map((o) => o.position.addresses.market)),
  ]);
  const checks: Array<{ key: Hex; position: Position }> = [];
  const contracts: unknown[] = [];
  for (const o of open) {
    const market = props.get(o.position.addresses.market.toLowerCase());
    if (!market) continue;
    const index = gmxTokenPrice(market.indexToken, fairByBase);
    const long = gmxTokenPrice(market.longToken, fairByBase);
    const short = gmxTokenPrice(market.shortToken, fairByBase);
    if (!index || !long || !short) continue;
    checks.push(o);
    contracts.push({
      address: GMX.Reader,
      abi: readerAbi,
      functionName: "isPositionLiquidatable",
      args: [
        GMX.DataStore,
        zeroAddress,
        o.key,
        market,
        { indexTokenPrice: index, longTokenPrice: long, shortTokenPrice: short },
        true,
        true,
      ],
    });
  }
  if (checks.length === 0) return [];
  const verdicts = (await publicClient.multicall({
    contracts: contracts as never,
    allowFailure: true,
  })) as Array<{ status: "success" | "failure"; result?: unknown }>;

  const out: LiquidatablePosition[] = [];
  verdicts.forEach((r, i) => {
    if (r.status !== "success") return;
    const [liquidatable, reason] = r.result as readonly [boolean, string];
    if (!liquidatable) return;
    const { key, position } = checks[i];
    out.push({
      key,
      account: position.addresses.account,
      market: position.addresses.market,
      collateralToken: position.addresses.collateralToken,
      isLong: position.flags.isLong,
      reason,
    });
  });
  return out;
}

async function liquidatePositions(
  ctx: SimContext,
  keeper: ReturnType<typeof privateKeyToAccount>,
  oracleParams: ReturnType<typeof gmxKeeperOracleParams>,
  opts: {
    noMine?: boolean;
    fee: bigint;
    executeGas: bigint;
    block: bigint;
  },
): Promise<void> {
  const fairByBase = { ...(ctx.fairPrices ?? {}) };
  let found: LiquidatablePosition[];
  try {
    found = await gmxLiquidatablePositions(ctx.publicClient, fairByBase);
  } catch (error) {
    console.error(
      `gmx liquidation scan failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  let sent = 0;
  for (const p of found) {
    if (sent >= MAX_LIQUIDATIONS_PER_BLOCK) break;
    const last = liquidationSentAt.get(p.key);
    if (last !== undefined && opts.block - last < LIQUIDATION_RESEND_BLOCKS)
      continue;
    const data = encodeFunctionData({
      abi: liquidationHandlerAbi,
      functionName: "executeLiquidation",
      args: [p.account, p.market, p.collateralToken, p.isLong, oracleParams],
    });
    try {
      if (opts.noMine) {
        const block = await ctx.publicClient.getBlock();
        await ctx.walletClient.sendTransaction({
          account: keeper,
          chain: ctx.chain,
          to: GMX.LiquidationHandler,
          data,
          gas: opts.executeGas,
          maxFeePerGas: (block.baseFeePerGas ?? 0n) + opts.fee,
          maxPriorityFeePerGas: opts.fee,
        });
      } else {
        const block = await ctx.publicClient.getBlock();
        const hash = await ctx.walletClient.sendTransaction({
          account: keeper,
          chain: ctx.chain,
          to: GMX.LiquidationHandler,
          data,
          gas: opts.executeGas,
          maxFeePerGas: (block.baseFeePerGas ?? 0n) + 1_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        });
        if (!isExternalChain()) await mine(ctx.publicClient);
        await ctx.publicClient.waitForTransactionReceipt({ hash });
      }
      liquidationSentAt.set(p.key, opts.block);
      sent += 1;
      console.error(
        `gmx liquidation sent: account=${p.account} market=${p.market} isLong=${p.isLong} reason=${p.reason}`,
      );
    } catch (error) {
      console.error(
        `gmx liquidation failed: account=${p.account} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
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
    const entries = gmxMarketEntries(ctx);
    // The venue state (skew, funding rate) rides the same block and the same batch as the
    // positions: an agent comparing its own position against the book must not be told about the
    // two at different blocks.
    const [positions, funding] = await Promise.all([
      getAccountPositions(ctx.publicClient, agent),
      readMarketFunding(
        ctx.publicClient,
        entries.map((e) => e.market),
      ),
    ]);
    const owed = await readPositionFundingOwed(
      ctx.publicClient,
      positions,
      (symbol) => baseFairPrice(ctx, symbol, fairPrice),
    );

    const positionObs = (
      pos: Position,
      market: Address,
      price: number,
      base: TokenSymbol,
    ): GmxPositionObservation => {
      const fundingOwedUsd = owed.get(market.toLowerCase());
      return {
        ...gmxPositionObservation(pos, price, base),
        ...(fundingOwedUsd !== undefined ? { fundingOwedUsd } : {}),
      };
    };

    // Keep the WETH (ETH/USD) market at the top level as before (byte-compatible).
    const wethMarketAddr = resolveGmxMarket(ctx, "WETH");
    const wethPos = positionForMarket(positions, wethMarketAddr);
    const obs: GmxObservation = {
      marketPriceUsd: fairPrice,
      ...(wethPos
        ? {
            position: positionObs(wethPos, wethMarketAddr, fairPrice, "WETH"),
          }
        : {}),
      ...(funding.get(wethMarketAddr.toLowerCase()) ?? {}),
    };

    // Add non-WETH index markets (WBTC etc.) to markets. Empty on the default fork.
    const extra: Record<string, GmxMarketObservation> = {};
    for (const { base, market } of entries) {
      if (base === "WETH") continue;
      const price = baseFairPrice(ctx, base, fairPrice);
      const pos = positionForMarket(positions, market);
      const key = marketFor("gmx", base)?.key ?? `${base}/USDC`;
      extra[key] = {
        marketPriceUsd: price,
        ...(pos ? { position: positionObs(pos, market, price, base) } : {}),
        ...(funding.get(market.toLowerCase()) ?? {}),
      };
    }
    if (Object.keys(extra).length > 0) obs.markets = extra;
    return obs;
  },

  async buildTxs(ctx, owner, action): Promise<BuiltTx[]> {
    const base = (action as { base?: TokenSymbol }).base ?? "WETH";
    return [buildOrderTx(owner, resolveGmxMarket(ctx, base), base, action)];
  },

  // The keeper fills orders created during the competition block
  async afterMine(
    ctx: SimContext,
    opts?: {
      noMine?: boolean;
      priorityFeeWei?: bigint;
      // Declared gas limit per executeOrder; GMX_KEEPER_EXECUTE_GAS unless a caller measured otherwise.
      executeGas?: bigint;
      blockNumber?: bigint;
      fromBlock?: bigint;
      toBlock?: bigint;
      // Told about every order the keeper read and did not execute (gmxKeeperRefusal), or could not read.
      onOrderRefused?: (refusal: GmxKeeperRefusal) => void;
      // Told when more orders were executable than MAX_ORDER_FILLS_PER_BLOCK: how many went now,
      // how many wait for the next pass (issue #225).
      onOrdersDeferred?: (report: { sent: number; deferred: number }) => void;
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
    const created = logs
      .filter(
        (l) =>
          (l.topics[1]?.toLowerCase() ?? "") ===
            ORDER_CREATED_HASH.toLowerCase() && l.topics[2],
      )
      .map((l) => l.topics[2] as Hex);
    // Orders deferred by an earlier pass go first (arrival order), then this range's.
    const keys = [...new Set([...deferredOrderKeys.splice(0), ...created])];
    if (keys.length === 0) return;
    const readable = await keeperExecutableKeys(
      ctx,
      keys,
      opts?.onOrderRefused,
    );
    const executable = readable.slice(0, MAX_ORDER_FILLS_PER_BLOCK);
    const deferred = readable.slice(MAX_ORDER_FILLS_PER_BLOCK);
    if (deferred.length > 0) {
      deferredOrderKeys.push(...deferred);
      opts?.onOrdersDeferred?.({ sent: executable.length, deferred: deferred.length });
    }
    if (executable.length === 0) return;

    const keeper = privateKeyToAccount(ctx.keeperPk);
    // Every token any configured market needs, not just the order's own: GMX reverts the whole
    // execute on a missing price rather than cancelling, and nothing retries it (gmxOracleTokens).
    const oracleParams = gmxKeeperOracleParams(ctx);
    const fee = opts?.priorityFeeWei ?? 1_000_000_000n;
    const executeGas = opts?.executeGas ?? GMX_KEEPER_EXECUTE_GAS;
    for (const key of executable) {
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
            gas: executeGas,
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
          gas: executeGas,
          maxFeePerGas: baseFee + 1_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        });
        // The keeper runs inside the block loop, so on a dev node it mines its own block; on an
        // external chain the sequencer already is (issue #33 (2)).
        if (!isExternalChain()) await mine(ctx.publicClient);
        await ctx.publicClient.waitForTransactionReceipt({ hash });
      } catch (error) {
        // Skip fill failures (acceptablePrice etc.). GMX auto-cancels/refunds them.
        // Log to stderr so a persistent all-failures state (e.g. misconfigured oracle) is noticeable.
        console.error(
          `gmx keeper executeOrder failed: key=${key} ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!opts?.noMine && !isExternalChain()) await mine(ctx.publicClient);
      }
    }

    await liquidatePositions(ctx, keeper, oracleParams, {
      noMine: opts?.noMine,
      fee,
      executeGas,
      block: toBlock,
    });
  },

  async valueUsdc(ctx, agent, _state, fairPrice): Promise<number> {
    const positions = await getAccountPositions(ctx.publicClient, agent);
    const price = (symbol: TokenSymbol): number =>
      baseFairPrice(ctx, symbol, fairPrice);
    // Sum every open position across all gmx markets, each at its base's fair price. Every one, not
    // the first per market: a market holds a separate position per (collateral, side), so a
    // WBTC-collateral and a USDC-collateral BTC long are two positions.
    // On the default fork (single WETH market) this is the prior formula (markPrice=wethPrice=fairPrice).
    const baseByMarket = new Map(
      gmxMarketEntries(ctx).map((e) => [e.market.toLowerCase(), e.base]),
    );
    let total = 0;
    for (const pos of positions) {
      if (pos.numbers.sizeInUsd === 0n) continue;
      const base = baseByMarket.get(pos.addresses.market.toLowerCase());
      if (base === undefined) continue;
      total += positionValueUsd(pos, price(base), base, price) ?? 0;
    }
    return total;
  },

  // Perp positions plus GM (market token) liquidity holdings (issue #41). Stage 1 reads positions,
  // market definitions and GM balances together; stage 2 prices the GM tokens and only runs when
  // somebody actually holds one.
  async *valueAtBlock(ctx) {
    const markets = gmxMarketTokens();
    const stage1 = yield [
      ...ctx.agents.map((a) => gmxAccountPositionsCall(a.address)),
      ...markets.map((marketToken) => ({
        address: GMX.Reader,
        abi: readerAbi,
        functionName: "getMarket",
        args: [GMX.DataStore, marketToken],
      })),
      ...ctx.agents.flatMap((a) =>
        markets.map((marketToken) => ({
          address: marketToken,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [a.address],
        })),
      ),
    ];
    const marketBase = ctx.agents.length;
    const balanceBase = marketBase + markets.length;
    const fairByBase = ctx.fairByBase();

    // undefined = the balance read failed, which is not the same as holding none (issue #44).
    const gmBalance = (
      agentIndex: number,
      marketIndex: number,
    ): bigint | undefined => {
      const raw =
        stage1[balanceBase + agentIndex * markets.length + marketIndex];
      return typeof raw === "bigint" ? raw : undefined;
    };
    const anyHolder = ctx.agents.some((_, a) =>
      markets.some((_m, i) => (gmBalance(a, i) ?? 0n) > 0n),
    );

    // Price.Props for each market's index/long/short token, by market index. Absent means the
    // market could not be priced; both the GM mark and the position exit read need it.
    const pricesByMarket = markets.map((_marketToken, i) => {
      const props = stage1[marketBase + i] as MarketProps | undefined;
      if (!props) return undefined;
      const index = gmxTokenPrice(props.indexToken, fairByBase);
      const long = gmxTokenPrice(props.longToken, fairByBase);
      const short = gmxTokenPrice(props.shortToken, fairByBase);
      if (!index || !long || !short) return undefined;
      return { props, index, long, short };
    });

    const reads: Array<{
      address: Address;
      abi: unknown;
      functionName: string;
      args: readonly unknown[];
    }> = [];

    // USD per whole GM token, by market index. Absent means the market could not be priced.
    const gmUsd: Array<number | undefined> = markets.map(() => undefined);
    const gmLayout: Array<{ marketIndex: number; read: number }> = [];
    if (anyHolder) {
      pricesByMarket.forEach((m, i) => {
        if (!m) return;
        gmLayout.push({ marketIndex: i, read: reads.length });
        reads.push({
          address: GMX.Reader,
          abi: readerAbi,
          functionName: "getMarketTokenPrice",
          args: [
            GMX.DataStore,
            m.props,
            m.index,
            m.long,
            m.short,
            MAX_PNL_FACTOR_FOR_WITHDRAWALS,
            // Mark at the minimum price: this is what an exit would realize.
            false,
          ],
        });
      });
    }

    // What closing each open position would realize, for every agent holding one. The reader
    // reverts on a position in a market it was not given a price for, so an agent with any such
    // position is not read: perpValueUsd already reports that position, and the rest stay at face.
    const pricedMarkets: Address[] = [];
    const pricedMarketPrices: unknown[] = [];
    pricesByMarket.forEach((m, i) => {
      if (!m) return;
      pricedMarkets.push(markets[i]);
      pricedMarketPrices.push({
        indexTokenPrice: m.index,
        longTokenPrice: m.long,
        shortTokenPrice: m.short,
      });
    });
    const exitRead = new Map<number, number>(); // agent index -> read index
    ctx.agents.forEach((agent, a) => {
      const positions = stage1[a] as readonly Position[] | undefined;
      const open = positions?.filter((p) => p.numbers.sizeInUsd > 0n) ?? [];
      if (open.length === 0) return;
      const priced = new Set(pricedMarkets.map((m) => m.toLowerCase()));
      if (!open.every((p) => priced.has(p.addresses.market.toLowerCase())))
        return;
      exitRead.set(a, reads.length);
      reads.push({
        address: GMX.Reader,
        abi: readerAbi,
        functionName: "getAccountPositionInfoList",
        args: [
          GMX.DataStore,
          // No referral storage: a referral discount only lowers the fee, so this never overstates.
          zeroAddress,
          agent.address,
          pricedMarkets,
          pricedMarketPrices,
          zeroAddress,
          0n,
          50n,
        ],
      });
    });

    const stage2 = reads.length > 0 ? ((yield reads as never) as unknown[]) : [];
    for (const { marketIndex, read } of gmLayout) {
      const result = stage2[read] as readonly [bigint, unknown] | undefined;
      if (!result) continue;
      // int256 USD per GM token with 30 decimals. A non-positive price means the pool is
      // underwater; the holding is worth nothing rather than negative.
      gmUsd[marketIndex] = Math.max(0, Number(result[0]) / 1e30);
    }
    const marketProps = new Map(
      pricesByMarket.flatMap((m) =>
        m ? [[m.props.marketToken.toLowerCase(), m.props] as const] : [],
      ),
    );

    const out: Record<string, AgentProtocolValue> = {};
    ctx.agents.forEach((agent, a) => {
      const positions = stage1[a] as readonly Position[] | undefined;
      const perp = perpValueUsd(positions, fairByBase);
      // The face mark (collateral + PnL) stays valueUsdc; the score reads the exit value.
      let valueUsdc = perp.valueUsdc;
      let liquidatableValueUsdc = perp.valueUsdc;
      const unpriced: UnpricedHoldingDetail[] = [...perp.unpriced];
      const read = exitRead.get(a);
      if (read !== undefined) {
        const infos = stage2[read] as readonly PositionInfo[] | undefined;
        if (infos) {
          liquidatableValueUsdc = 0;
          for (const info of infos) {
            const market = info.position.addresses.market.toLowerCase();
            // A position perpValueUsd could not price is already reported there.
            const exit = positionExitValueUsd(
              info,
              fairByBase,
              marketProps.get(market),
            );
            liquidatableValueUsdc += exit ?? 0;
          }
        } else {
          // Marked at face rather than dropped: the position exists and its face is known, only
          // the cost of leaving it is not.
          unpriced.push({
            source: "gmx-position",
            amountRaw: "",
            reason: "read-failed",
            read: "GmxReader.getAccountPositionInfoList (exit value; marked at face)",
          });
        }
      }
      // An account with no perps decodes to an empty array, so undefined means the read failed.
      // Both value at zero, which is why the two have to be told apart (issue #44).
      if (!positions)
        unpriced.push({
          source: "gmx-position",
          amountRaw: "",
          reason: "read-failed",
          read: "GmxReader.getAccountPositions",
        });
      markets.forEach((marketToken, i) => {
        const balance = gmBalance(a, i);
        if (balance === undefined) {
          unpriced.push({
            token: marketToken,
            amountRaw: "",
            source: "gmx-gm",
            reason: "read-failed",
            read: "ERC20.balanceOf",
          });
          return;
        }
        if (balance <= 0n) return;
        const usdPerToken = gmUsd[i];
        if (usdPerToken === undefined) {
          unpriced.push({
            token: marketToken,
            amountRaw: balance.toString(),
            source: "gmx-gm",
          });
          return;
        }
        // GM tokens are 18-decimal ERC-20s.
        const gm = (Number(balance) / 1e18) * usdPerToken;
        valueUsdc += gm;
        liquidatableValueUsdc += gm;
      });
      out[agent.id] = {
        valueUsdc,
        liquidatableValueUsdc,
        unpriced,
      };
    });
    return out;
  },

  async accountedTokens(): Promise<Address[]> {
    return gmxMarketTokens();
  },

  async setupWallet(): Promise<BuiltTx[]> {
    // Approve the Router for every ERC-20 collateral: USDC, and each non-WETH market's long token
    // (WBTC). WETH collateral needs none -- it is sent natively via sendWnt.
    const tokens: Address[] = [TOKENS.USDC.address];
    for (const m of marketsFor("gmx")) {
      if (m.base === "WETH" || !m.gmx) continue;
      const token = tokenInfo(m.base).address;
      if (!tokens.some((t) => t.toLowerCase() === token.toLowerCase()))
        tokens.push(token);
    }
    return tokens.map((token) => ({
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [GMX.Router, maxUint256],
      }),
    }));
  },

  async setupGlobal(ctx: SimContext): Promise<void> {
    const admin = accountAddress(ctx.adminPk);
    const keeper = accountAddress(ctx.keeperPk);

    // The markets' tokens, from chain: they decide what the keeper must price and what collateral
    // each market takes, so a market of another shape is refused here rather than discovered as
    // orders that never fill.
    const layouts: Array<{
      base: TokenSymbol;
      market: Address;
      props: MarketProps;
    }> = [];
    for (const { base, market } of gmxMarketEntries(ctx)) {
      const props = (await ctx.publicClient.readContract({
        address: GMX.Reader,
        abi: readerAbi,
        functionName: "getMarket",
        args: [GMX.DataStore, market],
      })) as MarketProps;
      layouts.push({ base, market, props });
    }
    const layoutProblems = gmxMarketLayoutProblems(layouts);
    if (layoutProblems.length > 0)
      throw new Error(
        "gmx: a configured market does not have the [base-base-USDC] shape the adapter prices and " +
          `takes collateral for:\n  ${layoutProblems.join("\n  ")}`,
      );
    const oracleTokens = gmxOracleTokens(layouts.map((l) => l.props));

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
      await sendAsPrivileged(
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
        "granting the environment a GMX role",
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
    // Every token the keeper passes, WBTC included: GMX checks each price against the provider
    // registered for that token, and WBTC's was left on the deploy's own provider.
    for (const token of oracleTokens) {
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
    ctx.gmx.oracleTokens = oracleTokens;
    ctx.oracle.gmxProvider = mock;
    ctx.updateGmxOracle = async (c, fairPrice, opts) => {
      // ADR 0011 §1: under economicGas the price is a storage write, like PriceFeed and Aave. The
      // keeper's executeOrder reads the provider when it runs, so a price already in storage is the
      // price every order of the next block fills at, wherever the keeper lands in that block.
      if (opts?.storage) {
        for (const token of c.gmx.oracleTokens ?? oracleTokens) {
          const price = gmxOraclePrice(c, token, fairPrice);
          if (price === null) continue;
          const [minSlot, maxSlot, setSlot] = gmxOraclePriceSlots(token);
          await setStorageAt(c.publicClient, mock, minSlot, bigintToStorageWord(price));
          await setStorageAt(c.publicClient, mock, maxSlot, bigintToStorageWord(price));
          await setStorageAt(c.publicClient, mock, setSlot, bigintToStorageWord(1n));
        }
        return;
      }
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
      // Exactly the tokens the keeper passes (WETH, USDC, then WBTC on the local deploy), so a
      // token the keeper names always has a price: the mock reverts on one that was never set. The
      // layout check in setup guarantees each is USDC ($1, the numéraire) or a market's base.
      for (const token of c.gmx.oracleTokens ?? oracleTokens) {
        const price = gmxOraclePrice(c, token, fairPrice);
        if (price === null) continue;
        await send({
          to: mock,
          data: encodeFunctionData({
            abi: mockOracleProviderAbi,
            functionName: "setPrice",
            args: [token, price, price],
          }),
        });
      }
    };
  },
};

// The price the environment publishes for one oracle token: USDC is the numéraire, every other
// token is its base's fair price. Exactly the tokens the keeper passes (WETH, USDC, then WBTC on the
// local deploy), so a token the keeper names always has a price: the mock reverts on one that was
// never set. The layout check in setup guarantees each is USDC ($1) or a market's base, so the null
// (an address the registry does not know) is unreachable after it.
function gmxOraclePrice(
  ctx: SimContext,
  token: Address,
  fairPrice: number,
): bigint | null {
  const info = tokenInfoByAddress(token);
  if (!info) return null;
  const usd =
    info.kind === "stable"
      ? 1
      : info.symbol === "WETH"
        ? fairPrice
        : baseFairPrice(ctx, info.symbol, fairPrice);
  return toGmxPrice(usd, info.decimals);
}

// Storage of contracts/MockOracleProvider.sol: `owner` is immutable (no slot), so
// `mapping(address => Price) prices` is slot 0, and `Price {uint256 min; uint256 max; bool set}`
// takes three consecutive slots from keccak256(abi.encode(token, 0)). `forge inspect
// MockOracleProvider storageLayout` pins slot 0; test/gmxOracleStorage.test.ts pins the rest
// against a deployed mock.
export function gmxOraclePriceSlots(token: Address): [Hex, Hex, Hex] {
  const base = BigInt(
    keccak256(encodeAbiParameters(parseAbiParameters("address, uint256"), [token, 0n])),
  );
  return [base, base + 1n, base + 2n].map(
    (slot) => `0x${slot.toString(16).padStart(64, "0")}` as Hex,
  ) as [Hex, Hex, Hex];
}
