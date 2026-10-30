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

// ---------------------------------------------------------------------------
// Leverage cap
//
// The official regimes gap the price by up to 32% (spike: 24-32% over a 2-3 block ramp, never
// recovered; crash 15-22%, lending-/cdp-incident 12-16%). A liquidation that GMX closes below zero is
// charged cross-margin in scoring (gmxInsolvency.ts), so the cap is not there to keep positions
// solvent -- a 5x position does go insolvent in a 32% spike, and a one-sided one keeps its on-chain
// limited liability. It is there for what cross-margin cannot charge: a hedged pair whose losing leg
// is liquidated *before the gap's last step* leaves the winning leg naked for the rest of it (measured
// spike#101 at 19.5x with cross-margin alone: P +42,767 against noop +6,799). A liquidation lands a
// block after the keeper sees it, so that needs the leg to be liquidatable after the ramp's first
// step of three: loss >= ~1/leverage - 1.1% at a first step of at most 10.7% (spike 32% / 3; crash
// 22% / 3 = 7.3%), i.e. leverage >= ~8.4x. On a 2-step ramp the liquidation lands at the full gap.
// MIN_COLLATERAL_FACTOR = 0.198 caps it at 1/0.198 = 5.05x. The margin to 8.4x rests on the gap
// shape (step size and ramp length): recalibrating crash / spike means re-deriving this. What is
// left at 5x is the one-sided limited liability: a 5x short through a 24-32% spike loses up to 12%
// of size beyond its collateral, ~3% of collateral per epoch in expectation over the 12 regimes
// (0 at <= 3x).
//
// Two checks, the keeper's first. GMX applies the factor inside executeOrder: an increase that would
// leave equity (collateral + PnL + impact - fees) or collateral under 19.8% of size fails, and GMX
// cancels the market order and refunds the collateral and the execution fee in the same
// transaction; a decrease that withdraws collateral below it has the withdrawal zeroed (or, with no
// size, is cancelled); a partial decrease that would leave the rest over the cap is cancelled. Both
// are judged at the execution price, and the minimum execution fee is 0 at a tip of 0, so an order
// sized just over the cap was a free stop order: a WETH-collateral long at ~1.03x the cap executed
// only if the price had risen ~3%, and was otherwise handed back at no cost, to be re-sent next
// block. So the keeper decides first (gmxLeverage.ts): it computes the position each order would
// leave at the prices it will execute at, and does not execute one above GMX_KEEPER_CAP_USE (98%)
// of the cap. A refused order is not refunded -- it stays in the OrderVault, counted as nothing,
// until its account cancels it after requestExpirationTime (300 s) -- so a miss costs a lockup
// instead of nothing. GMX's own check stays as the backstop. A full close always goes through.
// Config.setUint caps the factor at 5% (ConfigUtils.validateRange), so the environment writes the
// DataStore directly as CONTROLLER. Liquidation still triggers at
// MIN_COLLATERAL_FACTOR_FOR_LIQUIDATION (1%), unchanged.

/** The highest leverage GMX accepts here: size / equity, at the oracle (fair) price. */
export const GMX_MAX_LEVERAGE = 1 / 0.198;
/** Keys.MIN_COLLATERAL_FACTOR value the environment writes for every market (30 decimals). */
export const GMX_MIN_COLLATERAL_FACTOR = 198n * 10n ** 27n;

const MIN_COLLATERAL_FACTOR = hashString("MIN_COLLATERAL_FACTOR");

/** Keys.minCollateralFactorKey(market). */
export function gmxMinCollateralFactorKey(market: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }],
      [MIN_COLLATERAL_FACTOR, market],
    ),
  );
}

// The other inputs of GMX's cap check (PositionUtils.willPositionCollateralBeSufficient and
// isPositionLiquidatable), which the keeper reads before it executes an order (gmxLeverage.ts).
const MIN_COLLATERAL_FACTOR_FOR_OPEN_INTEREST_MULTIPLIER = hashString(
  "MIN_COLLATERAL_FACTOR_FOR_OPEN_INTEREST_MULTIPLIER",
);
const POSITION_FEE_FACTOR = hashString("POSITION_FEE_FACTOR");
const MAX_POSITION_IMPACT_FACTOR_FOR_LIQUIDATIONS = hashString(
  "MAX_POSITION_IMPACT_FACTOR_FOR_LIQUIDATIONS",
);
/** Keys.MAX_UI_FEE_FACTOR: the most a UI fee receiver can charge on top of the position fee (global). */
export const GMX_MAX_UI_FEE_FACTOR_KEY = hashString("MAX_UI_FEE_FACTOR");

/** Keys.minCollateralFactorForOpenInterestMultiplierKey: raises the factor with a side's OI (0 here). */
export function gmxMinCollateralFactorForOiMultiplierKey(
  market: Address,
  isLong: boolean,
): Hex {
  return marketSideKey(
    MIN_COLLATERAL_FACTOR_FOR_OPEN_INTEREST_MULTIPLIER,
    market,
    isLong,
  );
}

/** Keys.positionFeeFactorKey: the position fee, by whether the order improves the skew. */
export function gmxPositionFeeFactorKey(
  market: Address,
  balanceWasImproved: boolean,
): Hex {
  return marketSideKey(POSITION_FEE_FACTOR, market, balanceWasImproved);
}

/** Keys.maxPositionImpactFactorForLiquidationsKey: the negative impact the cap check may count. */
export function gmxMaxPositionImpactFactorForLiquidationsKey(
  market: Address,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }],
      [MAX_POSITION_IMPACT_FACTOR_FOR_LIQUIDATIONS, market],
    ),
  );
}

/** Position.getPositionKey: one position per (account, market, collateral token, side). */
export function gmxPositionKey(
  account: Address,
  market: Address,
  collateralToken: Address,
  isLong: boolean,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "bool" },
      ],
      [account, market, collateralToken, isLong],
    ),
  );
}

/** The leverage a MIN_COLLATERAL_FACTOR value allows, or undefined for 0 (no factor = no cap read). */
export function gmxMaxLeverageFromFactor(factor: bigint): number | undefined {
  if (factor <= 0n) return undefined;
  return Math.round((1e30 / Number(factor)) * 100) / 100;
}
