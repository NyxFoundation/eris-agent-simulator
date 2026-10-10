// GMX DataStore key derivations, and the funding/open-interest fields they unlock (issue #78).
//
// Two readers want the same numbers at the same block and must not disagree:
//   - the post-run market series (core/src/realtime/marketSeries.ts), which materializes GMX open
//     interest and the funding rate into market.json for the dashboard, and
//   - the agent-facing observation (sdk/src/protocols/gmx.ts `observe`), which is new here: the
//     value existed on chain and in the report, and no agent could see it.
// The derivations used to live privately in the reporter. `example -> sdk <- core` forbids the
// adapter importing core, so the sdk is the only place both readers can reach -- which is the
// reason this module exists rather than an export from either caller.
//
// Everything here is pure: keys in, keys out; raw reads in, observation fields out. The chain IO is
// the caller's, because the two callers batch differently (a blockNumber-pinned Multicall3 after
// the run, versus the agent's per-block batch).
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

// Keys.sol derivations (gmx-synthetics contracts/data/Keys.sol).
function hashString(s: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }], [s]));
}

const OPEN_INTEREST = hashString("OPEN_INTEREST");
const SAVED_FUNDING_FACTOR_PER_SECOND = hashString(
  "SAVED_FUNDING_FACTOR_PER_SECOND",
);
const FUNDING_INCREASE_FACTOR_PER_SECOND = hashString(
  "FUNDING_INCREASE_FACTOR_PER_SECOND",
);
const FUNDING_FEE_AMOUNT_PER_SIZE = hashString("FUNDING_FEE_AMOUNT_PER_SIZE");
const POOL_AMOUNT = hashString("POOL_AMOUNT");
const RESERVE_FACTOR = hashString("RESERVE_FACTOR");
const OPEN_INTEREST_RESERVE_FACTOR = hashString("OPEN_INTEREST_RESERVE_FACTOR");
const MAX_OPEN_INTEREST = hashString("MAX_OPEN_INTEREST");

// Callback and receiver gas: how much of a participant's own code GMX runs inside the keeper's executeOrder
// (gmxKeeperRefusal in gmx.ts; core/src/realtime/gmxCallbacks.ts). Plain base keys, not per market.
/** Keys.MAX_CALLBACK_GAS_LIMIT: the cap createOrder checks an order's callbackGasLimit against. */
export const GMX_MAX_CALLBACK_GAS_LIMIT_KEY = hashString(
  "MAX_CALLBACK_GAS_LIMIT",
);
/** Keys.REFUND_EXECUTION_FEE_GAS_LIMIT: gas for the refundExecutionFee callback, independent of the order's. */
export const GMX_REFUND_EXECUTION_FEE_GAS_LIMIT_KEY = hashString(
  "REFUND_EXECUTION_FEE_GAS_LIMIT",
);
/** Keys.NATIVE_TOKEN_TRANSFER_GAS_LIMIT: gas for a native ETH send to a receiver (refunds, unwrapped outputs). */
export const GMX_NATIVE_TOKEN_TRANSFER_GAS_LIMIT_KEY = hashString(
  "NATIVE_TOKEN_TRANSFER_GAS_LIMIT",
);

/** Keys.openInterestKey: open interest in USD (30 decimals), per (market, collateral, side). */
export function gmxOpenInterestKey(
  market: Address,
  collateralToken: Address,
  isLong: boolean,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "bool" },
      ],
      [OPEN_INTEREST, market, collateralToken, isLong],
    ),
  );
}

/** Keys.savedFundingFactorPerSecondKey: int256, positive = longs pay shorts. */
export function gmxSavedFundingKey(market: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }],
      [SAVED_FUNDING_FACTOR_PER_SECOND, market],
    ),
  );
}

/**
 * Keys.fundingIncreaseFactorPerSecondKey: how fast adaptive funding ramps.
 *
 * Read only to tell two zeros apart. savedFundingFactorPerSecond is the *adaptive* funding path's
 * stored state, and MarketUtils returns early without ever writing it when this factor is 0 -- so
 * on a deploy without adaptive funding the saved rate reads 0 forever no matter how skewed the book
 * is. That was every local deploy before deployer/vendor/gmx-localhost.patch gained funding
 * parameters, and it is still true of any run replayed from a state dump baked before it.
 */
export function gmxFundingIncreaseFactorKey(market: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }],
      [FUNDING_INCREASE_FACTOR_PER_SECOND, market],
    ),
  );
}

/**
 * Keys.fundingFeeAmountPerSizeKey: the running per-size funding accumulator for the *paying* side.
 *
 * A position stores its own snapshot of this (Position.numbers.fundingFeeAmountPerSize); the
 * difference against the latest value is what it has accrued since it was last touched.
 */
export function gmxFundingFeeAmountPerSizeKey(
  market: Address,
  collateralToken: Address,
  isLong: boolean,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "bool" },
      ],
      [FUNDING_FEE_AMOUNT_PER_SIZE, market, collateralToken, isLong],
    ),
  );
}

// GMX carries USD at 30 decimals, and its factors at the same precision.
const USD_SCALE = 10n ** 30n;

function marketTokenKey(base: Hex, market: Address, token: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }],
      [base, market, token],
    ),
  );
}

function marketSideKey(base: Hex, market: Address, isLong: boolean): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "bool" }],
      [base, market, isLong],
    ),
  );
}

/** Keys.poolAmountKey: the market's balance of one of its two tokens (that token's decimals). */
export function gmxPoolAmountKey(market: Address, token: Address): Hex {
  return marketTokenKey(POOL_AMOUNT, market, token);
}

/** Keys.reserveFactorKey: the share of a side's pool its open positions may reserve (30 decimals). */
export function gmxReserveFactorKey(market: Address, isLong: boolean): Hex {
  return marketSideKey(RESERVE_FACTOR, market, isLong);
}

/** Keys.openInterestReserveFactorKey: the same share, checked on increases only (30 decimals). */
export function gmxOpenInterestReserveFactorKey(
  market: Address,
  isLong: boolean,
): Hex {
  return marketSideKey(OPEN_INTEREST_RESERVE_FACTOR, market, isLong);
}

/** Keys.maxOpenInterestKey: an absolute open-interest ceiling per side (USD, 30 decimals). */
export function gmxMaxOpenInterestKey(market: Address, isLong: boolean): Hex {
  return marketSideKey(MAX_OPEN_INTEREST, market, isLong);
}

/**
 * How much open interest one side of a market can carry at the current price, in USD (30 decimals).
 *
 * An increase is refused once the side's reserved USD would pass `pool value x reserve factor`
 * (MarketUtils.validateReserve) or `pool value x open-interest reserve factor`
 * (validateOpenInterestReserve), or once its open interest would pass MAX_OPEN_INTEREST. The pool
 * that backs longs is the long token's, the one that backs shorts the short token's. A long's
 * reserve is marked at the index price, which is why the long side's cap moves with the price.
 * `undefined` when any read is missing: a cap of 0 would read as "closed".
 */
export function gmxSideCapUsd(reads: {
  poolAmount?: bigint;
  tokenPriceUsd: number;
  tokenDecimals: number;
  reserveFactor?: bigint;
  openInterestReserveFactor?: bigint;
  maxOpenInterest?: bigint;
}): bigint | undefined {
  const {
    poolAmount,
    reserveFactor,
    openInterestReserveFactor,
    maxOpenInterest,
  } = reads;
  if (
    poolAmount === undefined ||
    reserveFactor === undefined ||
    openInterestReserveFactor === undefined ||
    maxOpenInterest === undefined ||
    !(reads.tokenPriceUsd > 0)
  )
    return undefined;
  const PRICE_SCALE = 1_000_000n;
  const poolUsd =
    (poolAmount *
      BigInt(Math.round(reads.tokenPriceUsd * Number(PRICE_SCALE))) *
      USD_SCALE) /
    (10n ** BigInt(reads.tokenDecimals) * PRICE_SCALE);
  const factor =
    reserveFactor < openInterestReserveFactor
      ? reserveFactor
      : openInterestReserveFactor;
  const byReserve = (poolUsd * factor) / USD_SCALE;
  return byReserve < maxOpenInterest ? byReserve : maxOpenInterest;
}

/** The DataStore getters both readers use. Kept here so neither has to redeclare them. */
export const gmxDataStoreReadAbi = [
  {
    type: "function",
    name: "getUint",
    stateMutability: "view",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getInt",
    stateMutability: "view",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [{ type: "int256" }],
  },
] as const;

/**
 * Raw DataStore reads for one market. `undefined` means the read failed, which is not the same as
 * a zero -- see gmxFundingFields.
 */
export type GmxFundingReads = {
  // OPEN_INTEREST for the four (side, collateral) cells, in this order:
  // [long/longToken, long/shortToken, short/longToken, short/shortToken].
  openInterest?: readonly (bigint | undefined)[];
  savedFundingFactorPerSecond?: bigint;
  fundingIncreaseFactorPerSecond?: bigint;
};

export type GmxFundingFields = {
  longOiUsd?: number;
  shortOiUsd?: number;
  // savedFundingFactorPerSecond expressed per hour, in bps of notional. Positive = longs pay shorts.
  fundingPerHourBps?: number;
  // Whether this deploy models funding at all (adaptive funding enabled for the market).
  fundingModeled?: boolean;
};

// GMX carries USD at 30 decimals.
const USD_1E30 = 1e30;
const SECONDS_PER_HOUR = 3600;

/**
 * Decode the reads into observation/report fields.
 *
 * Every field is *absent* when its read failed rather than 0: a zero funding rate is a measurement
 * ("the book is balanced") and must not be forgeable by a dropped read (issue #44's discipline).
 * fundingModeled carries the other half of that distinction — a real 0 from a deploy that models
 * funding means the skew is flat, and a 0 from one that does not means the venue has no funding.
 */
export function gmxFundingFields(reads: GmxFundingReads): GmxFundingFields {
  const out: GmxFundingFields = {};
  const oi = reads.openInterest;
  if (oi && oi.length === 4 && oi.every((v) => typeof v === "bigint")) {
    const [longA, longB, shortA, shortB] = oi as bigint[];
    out.longOiUsd = round2(Number(longA + longB) / USD_1E30);
    out.shortOiUsd = round2(Number(shortA + shortB) / USD_1E30);
  }
  if (typeof reads.savedFundingFactorPerSecond === "bigint")
    out.fundingPerHourBps = round6(
      (Number(reads.savedFundingFactorPerSecond) / USD_1E30) *
        SECONDS_PER_HOUR *
        10_000,
    );
  if (typeof reads.fundingIncreaseFactorPerSecond === "bigint")
    out.fundingModeled = reads.fundingIncreaseFactorPerSecond > 0n;
  return out;
}

// MarketUtils.getFundingAmount stores the per-size accumulators scaled by
// FLOAT_PRECISION * FLOAT_PRECISION_SQRT = 1e30 * 1e15.
const FUNDING_PER_SIZE_PRECISION = 10n ** 45n;

/**
 * What a position has accrued since its snapshot, in units of its collateral token.
 *
 * Positive = owed by the position. Only the crowded side accumulates here; the paid side's credit
 * goes to the claimable-funding accumulators, which are separate keys and are not read (a position
 * on the paid side therefore reads 0, not a negative). GMX rounds this up when it charges — a user
 * must not be able to dodge the fee by touching the position — and down when it credits; the
 * truncation here is immaterial because this is a report, not a charge.
 */
export function gmxFundingFeeAmount(
  latestPerSize: bigint,
  positionPerSize: bigint,
  sizeInUsd: bigint,
): bigint {
  if (latestPerSize <= positionPerSize) return 0n;
  return (
    (sizeInUsd * (latestPerSize - positionPerSize)) / FUNDING_PER_SIZE_PRECISION
  );
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
