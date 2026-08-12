// Liquity V1 as the CDP stablecoin venue, issuing eUSD (issue #39).
//
// The core is forked unmodified, so what this adapter exposes is Liquity's own game:
//
//   Troves          borrow eUSD against native ETH at a minimum 110% collateral ratio, paying a
//                   one-off borrowing fee that rises with use
//   redemption      anyone holding eUSD may exchange it for collateral at the oracle price, always
//                   starting from the riskiest Trove. When eUSD trades below $1 that is a clean
//                   cross-venue α: buy the discount, redeem at par, pay the redemption fee
//   Stability Pool  deposit eUSD to absorb liquidated debt and receive the collateral at a discount
//   Recovery Mode   below a system-wide 150% TCR every Trove under 150% becomes liquidatable at
//                   once, which is a reflexive crash rather than Aave's per-position health factor
//
// Two things about the venue shape the code here more than anything else.
//
// *Collateral is native ETH.* Liquity takes it as `msg.value` and pays it back the same way.
// Converting the system to WETH would touch every pool and every payout path, so the adapter absorbs
// it instead: every collateral amount in an action is denominated in WETH wei and `buildTxs` emits
// `WETH.withdraw` before the call. The scorer already prices loose native ETH, so this is not a
// valuation gap -- but it is a gas interaction, and the observation surfaces the remaining headroom.
//
// *eUSD is never worth $1 by assumption.* It is deliberately absent from the token registry, because
// registering it as a stable would have the scorer's spot sweep price it at par -- and a CDP
// stablecoin trading at 0.97 marked at 1.00 hands every holder phantom value, which is precisely
// what makes the redemption arb look profitable before it has been done. Everything here marks eUSD
// at what the eUSD/USDC pool would actually pay.
import {
  encodeFunctionData,
  formatUnits,
  maxUint256,
  type Address,
  type PublicClient,
} from "viem";
import {
  borrowerOperationsAbi,
  curveStableSwapNgAbi,
  erc20Abi,
  liquityRedemptionHelperAbi,
  sortedTrovesAbi,
  stabilityPoolAbi,
  troveManagerAbi,
  wethAbi,
} from "../abis.js";
import {
  LIQUITY,
  requireEusdMarket,
  requireLiquity,
  requireRedemptionHelper,
  TOKENS,
  type LiquityDeployment,
} from "../constants.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  LeafAction,
  LiquityAdjustTroveAction,
  LiquityCloseTroveAction,
  LiquityLiquidateAction,
  LiquityObservation,
  LiquityOpenTroveAction,
  LiquityProvideToSpAction,
  LiquityRedeemAction,
  LiquitySwapEusdAction,
  LiquityTroveObservation,
  LiquityWithdrawFromSpAction,
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
import { approveTx } from "./uniswap.js";

const DECIMAL_INTEGER = /^[0-9]+$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const WAD = 10n ** 18n;
const USDC_DECIMALS = 6;

// Probe size for the two-sided market quote: big enough to be a real trade against a 100k pool,
// small enough that it reports the pool's price rather than its own footprint.
const PROBE_EUSD_WEI = 1_000n * WAD;

// Slippage bound on the protocol's own fee curves when an action does not say. Both fees rise with
// use, so a tight bound reverts on exactly the busy blocks an agent most wants to act.
const DEFAULT_MAX_FEE_BPS = 500;
const DEFAULT_SLIPPAGE_BPS = 50;

// How much native ETH to suggest keeping back for gas. Collateral comes out of the same balance, so
// an agent that posts everything can no longer send the transaction that would close the position.
// A suggestion, not a rule: self-stranding is a legitimate way to lose (issue #39).
const SUGGESTED_GAS_RESERVE_WEI = WAD / 20n; // 0.05 ETH

// Troves read per block to establish the redemption order. The sorted list is unbounded by design,
// but a roster is not: past this the position walk is reported as unknown rather than turning one
// observation into hundreds of reads.
const MAX_TROVE_SCAN = 64;

// A ratio Liquity reports as "no debt" (uint256 max). Reported as this instead, because JSON has no
// infinity and a zero here would read as "totally undercollateralized" -- the opposite of the truth.
const NO_DEBT_RATIO = 1e6;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// One Trove, in the order a redemption walks the list (riskiest first).
export type LiquityTroveRow = {
  owner: Address;
  collWei: bigint;
  // Everything the system books, gas compensation and pending redistribution included.
  debtEusdWei: bigint;
  // What the owner would actually repay to close: debt minus the gas compensation.
  netDebtEusdWei: bigint;
  icr: number;
};

export type LiquityState = {
  deployment: LiquityDeployment;
  market: {
    pool: Address;
    eusdIndex: number;
    usdcIndex: number;
    stable: Address;
  } | null;
  // The collateral price the venue marks against. It is the run's fair price, which is also what the
  // oracle adapter serves from the environment's PriceFeed -- so the ratios computed here are the
  // ones the chain would compute in the same block.
  priceUsd: number;
  priceRaw: bigint;
  tcr: number;
  recoveryMode: boolean;
  mcr: number;
  ccr: number;
  minNetDebtEusdWei: bigint;
  gasCompensationEusdWei: bigint;
  troveCount: number;
  totalCollWei: bigint;
  totalDebtEusdWei: bigint;
  borrowingRateBps: number;
  redemptionRateBps: number;
  baseRateBps: number;
  spTotalDepositsEusdWei: bigint;
  // Ascending ICR: index 0 is the Trove a redemption reaches first.
  troves: LiquityTroveRow[];
  // False when the list is longer than MAX_TROVE_SCAN, i.e. `troves` is not the whole ordering.
  troveOrderKnown: boolean;
  // Executable prices in USDC per eUSD, fee and impact included at probe size.
  sellPriceUsdc: number;
  buyPriceUsdc: number;
  midPriceUsdc: number;
  marketQuoted: boolean;
  // (1 - mid) x 10000. Positive means eUSD is cheap, which is what redemption arb trades.
  discountBps: number;
  reserves?: { eusd: bigint; usdc: bigint };
};

function toFloat(wei: bigint): number {
  return Number(wei) / 1e18;
}

/// A Liquity 1e18-scaled ratio as a plain number, with its "no debt" sentinel mapped to something
/// finite. Everything in this venue -- MCR, CCR, ICR, TCR -- uses that scale.
export function ratioFrom(raw: bigint): number {
  if (raw > 10n ** 30n) return NO_DEBT_RATIO;
  return Number(raw) / 1e18;
}

/// A Liquity 1e18-scaled fee rate in bps (0.005e18 = 0.5% = 50bps).
export function rateBpsFrom(raw: bigint): number {
  return Number((raw * 10_000n * 1000n) / WAD) / 1000;
}

/// ICR = collateral value / debt, the same formula LiquityMath uses on chain.
export function icrOf(
  collWei: bigint,
  debtWei: bigint,
  priceUsd: number,
): number {
  if (debtWei <= 0n) return NO_DEBT_RATIO;
  return (toFloat(collWei) * priceUsd) / toFloat(debtWei);
}

/// The collateral price at which a Trove falls to MCR and becomes liquidatable. The number an agent
/// running a Trove has to watch, and the reason it is in the observation rather than left to be
/// re-derived from three other fields.
export function liquidationPriceUsd(
  collWei: bigint,
  debtWei: bigint,
  mcr: number,
): number {
  const coll = toFloat(collWei);
  if (coll <= 0) return 0;
  return (toFloat(debtWei) * mcr) / coll;
}

/// Discount of the market against the $1 the protocol redeems at, in bps. Positive means eUSD trades
/// below par, so buying and redeeming converts the gap into collateral.
export function discountBpsFrom(marketPriceUsdc: number): number {
  return (1 - marketPriceUsdc) * 10_000;
}

// USDC per eUSD from a raw quote pair.
function usdcPerEusd(eusdIn: bigint, usdcOut: bigint): number {
  if (eusdIn <= 0n) return 0;
  return (
    Number(formatUnits(usdcOut, USDC_DECIMALS)) /
    Number(formatUnits(eusdIn, 18))
  );
}

async function quote(
  publicClient: PublicClient,
  pool: Address,
  i: number,
  j: number,
  dx: bigint,
): Promise<bigint | undefined> {
  try {
    return (await publicClient.readContract({
      address: pool,
      abi: curveStableSwapNgAbi,
      functionName: "get_dy",
      args: [BigInt(i), BigInt(j), dx],
    })) as bigint;
  } catch {
    // A quote the pool refuses is "no market at this size", not a price of zero. Zero would read as
    // a 10000bps discount -- an infinite free arb -- which is the failure mode issue #38 hit first.
    return undefined;
  }
}

export async function getLiquityState(
  ctx: SimContext,
  fairPrice: number,
): Promise<LiquityState> {
  const deployment = requireLiquity();
  const { publicClient } = ctx;
  const priceRaw = BigInt(Math.round(fairPrice * 1e18));

  const [
    tcrRaw,
    recoveryMode,
    mcrRaw,
    ccrRaw,
    minNetDebt,
    gasCompensation,
    troveCountRaw,
    totalColl,
    totalDebt,
    borrowingRate,
    redemptionRate,
    baseRate,
    spTotal,
  ] = (await Promise.all([
    read(publicClient, deployment.troveManager, troveManagerAbi, "getTCR", [
      priceRaw,
    ]),
    read(
      publicClient,
      deployment.troveManager,
      troveManagerAbi,
      "checkRecoveryMode",
      [priceRaw],
    ),
    read(publicClient, deployment.troveManager, troveManagerAbi, "MCR"),
    read(publicClient, deployment.troveManager, troveManagerAbi, "CCR"),
    read(
      publicClient,
      deployment.troveManager,
      troveManagerAbi,
      "MIN_NET_DEBT",
    ),
    read(
      publicClient,
      deployment.troveManager,
      troveManagerAbi,
      "LUSD_GAS_COMPENSATION",
    ),
    read(
      publicClient,
      deployment.troveManager,
      troveManagerAbi,
      "getTroveOwnersCount",
    ),
    read(
      publicClient,
      deployment.troveManager,
      troveManagerAbi,
      "getEntireSystemColl",
    ),
    read(
      publicClient,
      deployment.troveManager,
      troveManagerAbi,
      "getEntireSystemDebt",
    ),
    read(
      publicClient,
      deployment.troveManager,
      troveManagerAbi,
      "getBorrowingRateWithDecay",
    ),
    read(
      publicClient,
      deployment.troveManager,
      troveManagerAbi,
      "getRedemptionRateWithDecay",
    ),
    read(publicClient, deployment.troveManager, troveManagerAbi, "baseRate"),
    read(
      publicClient,
      deployment.stabilityPool,
      stabilityPoolAbi,
      "getTotalLUSDDeposits",
    ),
  ])) as [
    bigint,
    boolean,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];

  const troveCount = Number(troveCountRaw);
  const { troves, orderKnown } = await readTroveOrder(
    publicClient,
    deployment,
    troveCount,
    gasCompensation,
    fairPrice,
  );
  const market = await readMarket(publicClient);

  return {
    deployment,
    market: market.market,
    priceUsd: fairPrice,
    priceRaw,
    tcr: ratioFrom(tcrRaw),
    recoveryMode,
    mcr: ratioFrom(mcrRaw),
    ccr: ratioFrom(ccrRaw),
    minNetDebtEusdWei: minNetDebt,
    gasCompensationEusdWei: gasCompensation,
    troveCount,
    totalCollWei: totalColl,
    totalDebtEusdWei: totalDebt,
    borrowingRateBps: rateBpsFrom(borrowingRate),
    redemptionRateBps: rateBpsFrom(redemptionRate),
    baseRateBps: rateBpsFrom(baseRate),
    spTotalDepositsEusdWei: spTotal,
    troves,
    troveOrderKnown: orderKnown,
    ...market.prices,
  };
}

/// Every Trove in the order a redemption walks them (riskiest first).
///
/// Read from the owners array rather than by walking SortedTroves, because the walk is a chain of
/// dependent calls -- one round trip per Trove -- while the array is two batched rounds however long
/// the list is. The ordering is then recomputed here from the same ICRs the chain sorts on.
async function readTroveOrder(
  publicClient: PublicClient,
  deployment: LiquityDeployment,
  troveCount: number,
  gasCompensation: bigint,
  priceUsd: number,
): Promise<{ troves: LiquityTroveRow[]; orderKnown: boolean }> {
  if (troveCount === 0) return { troves: [], orderKnown: true };
  const orderKnown = troveCount <= MAX_TROVE_SCAN;
  const scan = Math.min(troveCount, MAX_TROVE_SCAN);
  let owners: Address[];
  try {
    owners = (await Promise.all(
      Array.from({ length: scan }, (_, i) =>
        read(
          publicClient,
          deployment.troveManager,
          troveManagerAbi,
          "getTroveFromTroveOwnersArray",
          [BigInt(i)],
        ),
      ),
    )) as Address[];
  } catch {
    return { troves: [], orderKnown: false };
  }
  let rows: LiquityTroveRow[];
  try {
    const entries = (await Promise.all(
      owners.map((owner) =>
        read(
          publicClient,
          deployment.troveManager,
          troveManagerAbi,
          "getEntireDebtAndColl",
          [owner],
        ),
      ),
    )) as Array<readonly [bigint, bigint, bigint, bigint]>;
    rows = owners.map((owner, i) => {
      const [debt, coll] = entries[i];
      return {
        owner,
        collWei: coll,
        debtEusdWei: debt,
        netDebtEusdWei: debt > gasCompensation ? debt - gasCompensation : 0n,
        icr: icrOf(coll, debt, priceUsd),
      };
    });
  } catch {
    return { troves: [], orderKnown: false };
  }
  rows.sort((a, b) => a.icr - b.icr);
  return { troves: rows, orderKnown };
}

/// The eUSD/USDC market, probed from both sides.
///
/// One-sided quotes under-report the executable mid whenever the pool is imbalanced, and an agent
/// trading against that phantom spread bleeds the fee every round trip -- the root cause of the WBTC
/// all-agent bleed. Here it would be worse than a bleed: the one thing this venue must report
/// correctly is how far eUSD is from par.
async function readMarket(publicClient: PublicClient): Promise<{
  market: LiquityState["market"];
  prices: Pick<
    LiquityState,
    | "sellPriceUsdc"
    | "buyPriceUsdc"
    | "midPriceUsdc"
    | "marketQuoted"
    | "discountBps"
    | "reserves"
  >;
}> {
  const l = requireLiquity();
  if (
    !l.eusdUsdcPool ||
    l.eusdIndex === undefined ||
    l.usdcIndex === undefined
  ) {
    // A deploy without a curve factory has no market for the peg. Troves and the Stability Pool
    // still work, so this is a missing leg rather than a broken venue.
    return {
      market: null,
      prices: {
        sellPriceUsdc: 0,
        buyPriceUsdc: 0,
        midPriceUsdc: 1,
        marketQuoted: false,
        discountBps: 0,
      },
    };
  }
  const market = requireEusdMarket();
  const sellOut = await quote(
    publicClient,
    market.pool,
    market.eusdIndex,
    market.usdcIndex,
    PROBE_EUSD_WEI,
  );
  const sellPriceUsdc = sellOut ? usdcPerEusd(PROBE_EUSD_WEI, sellOut) : 0;
  let buyPriceUsdc = 0;
  if (sellOut && sellOut > 0n) {
    const buyOut = await quote(
      publicClient,
      market.pool,
      market.usdcIndex,
      market.eusdIndex,
      sellOut,
    );
    if (buyOut && buyOut > 0n) buyPriceUsdc = usdcPerEusd(buyOut, sellOut);
  }
  const midPriceUsdc =
    sellPriceUsdc > 0 && buyPriceUsdc > 0
      ? Math.sqrt(sellPriceUsdc * buyPriceUsdc)
      : sellPriceUsdc;
  const marketQuoted = midPriceUsdc > 0;

  let reserves: { eusd: bigint; usdc: bigint } | undefined;
  try {
    const [eusd, usdc] = (await Promise.all([
      read(publicClient, market.pool, curveStableSwapNgAbi, "balances", [
        BigInt(market.eusdIndex),
      ]),
      read(publicClient, market.pool, curveStableSwapNgAbi, "balances", [
        BigInt(market.usdcIndex),
      ]),
    ])) as [bigint, bigint];
    reserves = { eusd, usdc };
  } catch {
    reserves = undefined;
  }

  return {
    market,
    prices: {
      sellPriceUsdc,
      buyPriceUsdc,
      // A pool that did not quote has no price, which is not a price of zero: par is the anchor the
      // protocol itself enforces, so it is the least wrong thing to fall back to -- and marketQuoted
      // says the number is a fallback rather than an observation.
      midPriceUsdc: marketQuoted ? midPriceUsdc : 1,
      marketQuoted,
      discountBps: marketQuoted ? discountBpsFrom(midPriceUsdc) : 0,
      ...(reserves ? { reserves } : {}),
    },
  };
}

function read(
  publicClient: PublicClient,
  address: Address,
  // biome-ignore lint/suspicious/noExplicitAny: one helper over several contract ABIs
  abi: any,
  functionName: string,
  args?: readonly unknown[],
): Promise<unknown> {
  return publicClient.readContract({
    address,
    abi,
    functionName,
    ...(args ? { args } : {}),
  } as never);
}

// ---------------------------------------------------------------------------
// parse / validate
// ---------------------------------------------------------------------------

function requireDecimalString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value))
    throw new Error(`${name} must be a decimal integer string`);
}

function optionalDecimalString(
  value: unknown,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  requireDecimalString(value, name);
  return value;
}

function optionalBps(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 10_000
  )
    throw new Error(`${name} must be an integer between 1 and 10000`);
  return value;
}

function withPriorityFee<T extends { maxPriorityFeePerGasWei?: string }>(
  action: T,
  obj: Record<string, unknown>,
): T {
  if (obj.maxPriorityFeePerGasWei !== undefined) {
    requireDecimalString(
      obj.maxPriorityFeePerGasWei,
      "maxPriorityFeePerGasWei",
    );
    action.maxPriorityFeePerGasWei = obj.maxPriorityFeePerGasWei;
  }
  return action;
}

function parse(obj: Record<string, unknown>): LeafAction | null {
  switch (obj.type) {
    case "liquityOpenTrove": {
      requireDecimalString(obj.collateralWethWei, "collateralWethWei");
      requireDecimalString(obj.debtEusdWei, "debtEusdWei");
      const action: LiquityOpenTroveAction = {
        type: "liquityOpenTrove",
        collateralWethWei: obj.collateralWethWei,
        debtEusdWei: obj.debtEusdWei,
      };
      const maxFeeBps = optionalBps(obj.maxFeeBps, "maxFeeBps");
      if (maxFeeBps !== undefined) action.maxFeeBps = maxFeeBps;
      return withPriorityFee(action, obj);
    }
    case "liquityAdjustTrove": {
      const action: LiquityAdjustTroveAction = { type: "liquityAdjustTrove" };
      const add = optionalDecimalString(
        obj.addCollateralWethWei,
        "addCollateralWethWei",
      );
      const withdraw = optionalDecimalString(
        obj.withdrawCollateralWei,
        "withdrawCollateralWei",
      );
      const debtChange = optionalDecimalString(
        obj.debtChangeEusdWei,
        "debtChangeEusdWei",
      );
      if (add !== undefined) action.addCollateralWethWei = add;
      if (withdraw !== undefined) action.withdrawCollateralWei = withdraw;
      if (debtChange !== undefined) action.debtChangeEusdWei = debtChange;
      if (obj.isDebtIncrease !== undefined) {
        if (typeof obj.isDebtIncrease !== "boolean")
          throw new Error("isDebtIncrease must be a boolean");
        action.isDebtIncrease = obj.isDebtIncrease;
      }
      const maxFeeBps = optionalBps(obj.maxFeeBps, "maxFeeBps");
      if (maxFeeBps !== undefined) action.maxFeeBps = maxFeeBps;
      return withPriorityFee(action, obj);
    }
    case "liquityCloseTrove":
      return withPriorityFee<LiquityCloseTroveAction>(
        { type: "liquityCloseTrove" },
        obj,
      );
    case "liquityRedeem": {
      requireDecimalString(obj.amountEusdWei, "amountEusdWei");
      const action: LiquityRedeemAction = {
        type: "liquityRedeem",
        amountEusdWei: obj.amountEusdWei,
      };
      if (obj.maxIterations !== undefined) {
        if (
          typeof obj.maxIterations !== "number" ||
          !Number.isInteger(obj.maxIterations) ||
          obj.maxIterations < 0
        )
          throw new Error("maxIterations must be a non-negative integer");
        action.maxIterations = obj.maxIterations;
      }
      const maxFeeBps = optionalBps(obj.maxFeeBps, "maxFeeBps");
      if (maxFeeBps !== undefined) action.maxFeeBps = maxFeeBps;
      return withPriorityFee(action, obj);
    }
    case "liquityProvideToSP": {
      requireDecimalString(obj.amountEusdWei, "amountEusdWei");
      return withPriorityFee<LiquityProvideToSpAction>(
        { type: "liquityProvideToSP", amountEusdWei: obj.amountEusdWei },
        obj,
      );
    }
    case "liquityWithdrawFromSP": {
      if (obj.amountEusdWei !== "max")
        requireDecimalString(obj.amountEusdWei, "amountEusdWei");
      return withPriorityFee<LiquityWithdrawFromSpAction>(
        {
          type: "liquityWithdrawFromSP",
          amountEusdWei: obj.amountEusdWei as string,
        },
        obj,
      );
    }
    case "liquityLiquidate": {
      const action: LiquityLiquidateAction = { type: "liquityLiquidate" };
      if (obj.borrowers !== undefined) {
        if (
          !Array.isArray(obj.borrowers) ||
          obj.borrowers.some((b) => typeof b !== "string")
        )
          throw new Error("borrowers must be an array of addresses");
        action.borrowers = obj.borrowers as string[];
      }
      if (obj.maxTroves !== undefined) {
        if (
          typeof obj.maxTroves !== "number" ||
          !Number.isInteger(obj.maxTroves) ||
          obj.maxTroves <= 0
        )
          throw new Error("maxTroves must be a positive integer");
        action.maxTroves = obj.maxTroves;
      }
      return withPriorityFee(action, obj);
    }
    case "liquitySwapEusd": {
      if (obj.tokenIn !== "USDC" && obj.tokenIn !== "EUSD")
        throw new Error('liquitySwapEusd tokenIn must be "USDC" or "EUSD"');
      requireDecimalString(obj.amountIn, "amountIn");
      const action: LiquitySwapEusdAction = {
        type: "liquitySwapEusd",
        tokenIn: obj.tokenIn,
        amountIn: obj.amountIn,
      };
      if (obj.slippageBps !== undefined) {
        if (
          typeof obj.slippageBps !== "number" ||
          !Number.isInteger(obj.slippageBps) ||
          obj.slippageBps < 0 ||
          obj.slippageBps > 1000
        )
          throw new Error("slippageBps must be an integer between 0 and 1000");
        action.slippageBps = obj.slippageBps;
      }
      return withPriorityFee(action, obj);
    }
    default:
      return null;
  }
}

function validate(
  action: LeafAction,
  obs: AgentObservation,
  balances: BalanceSnapshot,
): ValidationResult {
  const liquity = obs.protocols.liquity;
  // The eUSD balance is not part of BalanceSnapshot -- the token is deliberately outside the
  // registry so nothing prices it at par -- so it comes from the observation, as the LST's does.
  const eusdBalance = liquity ? BigInt(liquity.eusdBalanceWei) : 0n;
  const wethBalance = balances.bases?.WETH ?? balances.wethWei;

  switch (action.type) {
    case "liquityOpenTrove": {
      if (!liquity)
        return { ok: false, reason: "no liquity observation available" };
      const coll = BigInt(action.collateralWethWei);
      const debt = BigInt(action.debtEusdWei);
      if (coll <= 0n)
        return { ok: false, reason: "collateralWethWei must be positive" };
      if (coll > wethBalance)
        return { ok: false, reason: "collateralWethWei exceeds WETH balance" };
      if (debt < BigInt(liquity.minNetDebtEusdWei))
        return {
          ok: false,
          reason: `debtEusdWei is below MIN_NET_DEBT (${liquity.minNetDebtEusdWei})`,
        };
      if (liquity.trove && liquity.trove.status === 1)
        return { ok: false, reason: "this wallet already has an active Trove" };
      // Recovery Mode forbids opening below CCR, and the resulting ratio is knowable here, so say so
      // now rather than paying gas to be told on chain.
      const icr =
        (Number(formatUnits(coll, 18)) * liquity.priceUsd) /
        Number(formatUnits(debt, 18));
      const floor = liquity.recoveryMode ? liquity.ccr : liquity.mcr;
      if (icr < floor)
        return {
          ok: false,
          reason: `resulting ICR ${icr.toFixed(3)} is below the ${liquity.recoveryMode ? "CCR (Recovery Mode)" : "MCR"} of ${floor}`,
        };
      return { ok: true };
    }
    case "liquityAdjustTrove": {
      if (!liquity?.trove || liquity.trove.status !== 1)
        return { ok: false, reason: "no active Trove to adjust" };
      const add = BigInt(action.addCollateralWethWei ?? "0");
      const withdraw = BigInt(action.withdrawCollateralWei ?? "0");
      const debtChange = BigInt(action.debtChangeEusdWei ?? "0");
      if (add > 0n && withdraw > 0n)
        return {
          ok: false,
          reason: "adjust cannot add and withdraw collateral at once",
        };
      if (add === 0n && withdraw === 0n && debtChange === 0n)
        return { ok: false, reason: "adjust must change something" };
      if (add > wethBalance)
        return {
          ok: false,
          reason: "addCollateralWethWei exceeds WETH balance",
        };
      if (debtChange > 0n && action.isDebtIncrease === undefined)
        return {
          ok: false,
          reason: "isDebtIncrease is required with a debt change",
        };
      if (
        debtChange > 0n &&
        action.isDebtIncrease === false &&
        debtChange > eusdBalance
      )
        return { ok: false, reason: "debtChangeEusdWei exceeds eUSD balance" };
      if (withdraw > BigInt(liquity.trove.collWei))
        return {
          ok: false,
          reason: "withdrawCollateralWei exceeds the Trove's collateral",
        };
      return { ok: true };
    }
    case "liquityCloseTrove": {
      if (!liquity?.trove || liquity.trove.status !== 1)
        return { ok: false, reason: "no active Trove to close" };
      if (eusdBalance < BigInt(liquity.trove.netDebtEusdWei))
        return {
          ok: false,
          reason: `closing needs ${liquity.trove.netDebtEusdWei} eUSD to repay, wallet holds ${eusdBalance}`,
        };
      return { ok: true };
    }
    case "liquityRedeem": {
      if (!liquity)
        return { ok: false, reason: "no liquity observation available" };
      const amount = BigInt(action.amountEusdWei);
      if (amount <= 0n)
        return { ok: false, reason: "amountEusdWei must be positive" };
      if (amount > eusdBalance)
        return { ok: false, reason: "amountEusdWei exceeds eUSD balance" };
      return { ok: true };
    }
    case "liquityProvideToSP": {
      const amount = BigInt(action.amountEusdWei);
      if (amount <= 0n)
        return { ok: false, reason: "amountEusdWei must be positive" };
      if (amount > eusdBalance)
        return { ok: false, reason: "amountEusdWei exceeds eUSD balance" };
      return { ok: true };
    }
    case "liquityWithdrawFromSP": {
      if (!liquity)
        return { ok: false, reason: "no liquity observation available" };
      if (action.amountEusdWei === "max") return { ok: true };
      const amount = BigInt(action.amountEusdWei);
      // Zero is legal and means "claim the ETH gain", so it is only pointless when there is nothing
      // deposited and nothing to claim.
      if (
        amount === 0n &&
        BigInt(liquity.spDepositEusdWei) === 0n &&
        BigInt(liquity.spEthGainWei) === 0n
      )
        return { ok: false, reason: "nothing deposited and no gain to claim" };
      if (amount > BigInt(liquity.spDepositEusdWei))
        return {
          ok: false,
          reason: "amountEusdWei exceeds the Stability Pool deposit",
        };
      return { ok: true };
    }
    case "liquityLiquidate": {
      if (!action.borrowers?.length && !action.maxTroves)
        return {
          ok: false,
          reason: "liquidate needs either borrowers or maxTroves",
        };
      return { ok: true };
    }
    case "liquitySwapEusd": {
      const amount = BigInt(action.amountIn);
      if (amount <= 0n)
        return { ok: false, reason: "amountIn must be positive" };
      if (action.tokenIn === "EUSD") {
        if (amount > eusdBalance)
          return { ok: false, reason: "amountIn exceeds eUSD balance" };
        return { ok: true };
      }
      if (amount > balances.usdcUnits)
        return { ok: false, reason: "amountIn exceeds USDC balance" };
      const maxUsdcIn = BigInt(obs.limits.maxUsdcInUnits);
      if (maxUsdcIn > 0n && amount > maxUsdcIn)
        return {
          ok: false,
          reason: "amountIn exceeds the configured per-round limit",
        };
      return { ok: true };
    }
    default:
      return { ok: false, reason: "not a liquity action" };
  }
}

// ---------------------------------------------------------------------------
// Observation (issue #39 phase 3)
// ---------------------------------------------------------------------------

async function observe(
  ctx: SimContext,
  state: LiquityState,
  agent: Address,
): Promise<LiquityObservation> {
  const { publicClient } = ctx;
  const d = state.deployment;
  const [
    entire,
    status,
    eusdBalance,
    spDeposit,
    spEthGain,
    spLqtyGain,
    ethBalance,
  ] = await Promise.all([
    read(
      publicClient,
      d.troveManager,
      troveManagerAbi,
      "getEntireDebtAndColl",
      [agent],
    ) as Promise<readonly [bigint, bigint, bigint, bigint]>,
    read(publicClient, d.troveManager, troveManagerAbi, "getTroveStatus", [
      agent,
    ]) as Promise<bigint>,
    read(publicClient, d.eusd, erc20Abi, "balanceOf", [
      agent,
    ]) as Promise<bigint>,
    read(
      publicClient,
      d.stabilityPool,
      stabilityPoolAbi,
      "getCompoundedLUSDDeposit",
      [agent],
    ) as Promise<bigint>,
    read(
      publicClient,
      d.stabilityPool,
      stabilityPoolAbi,
      "getDepositorETHGain",
      [agent],
    ) as Promise<bigint>,
    read(
      publicClient,
      d.stabilityPool,
      stabilityPoolAbi,
      "getDepositorLQTYGain",
      [agent],
    ) as Promise<bigint>,
    publicClient.getBalance({ address: agent }),
  ]);

  const [debt, coll] = entire;
  const trove: LiquityTroveObservation | undefined =
    Number(status) === 1
      ? buildTroveObservation(state, agent, coll, debt, Number(status))
      : undefined;

  const riskiest = state.troves[0];
  const spShareBps =
    state.spTotalDepositsEusdWei > 0n
      ? Number((spDeposit * 10_000n) / state.spTotalDepositsEusdWei)
      : 0;

  return {
    priceUsd: state.priceUsd,
    tcr: state.tcr,
    recoveryMode: state.recoveryMode,
    mcr: state.mcr,
    ccr: state.ccr,
    troveCount: state.troveCount,
    totalCollWei: state.totalCollWei.toString(),
    totalDebtEusdWei: state.totalDebtEusdWei.toString(),
    borrowingRateBps: state.borrowingRateBps,
    redemptionRateBps: state.redemptionRateBps,
    baseRateBps: state.baseRateBps,
    minNetDebtEusdWei: state.minNetDebtEusdWei.toString(),
    gasCompensationEusdWei: state.gasCompensationEusdWei.toString(),
    eusdBalanceWei: eusdBalance.toString(),
    marketPriceUsdc: state.midPriceUsdc,
    ...(state.sellPriceUsdc > 0
      ? { marketSellPriceUsdc: state.sellPriceUsdc }
      : {}),
    ...(state.buyPriceUsdc > 0
      ? { marketBuyPriceUsdc: state.buyPriceUsdc }
      : {}),
    marketQuoted: state.marketQuoted,
    discountBps: state.discountBps,
    // The number that actually decides whether to redeem: the dislocation net of the fee the
    // protocol charges for closing it. Reported rather than left to be re-derived, because getting
    // the sign wrong here is the difference between the venue's α and a guaranteed loss.
    redemptionEdgeBps: state.marketQuoted
      ? state.discountBps - state.redemptionRateBps
      : 0,
    ...(state.reserves
      ? {
          poolReserves: {
            eusd: state.reserves.eusd.toString(),
            usdc: state.reserves.usdc.toString(),
          },
        }
      : {}),
    ...(trove ? { trove } : {}),
    ...(riskiest
      ? {
          riskiestTrove: {
            owner: riskiest.owner,
            icr: riskiest.icr,
            netDebtEusdWei: riskiest.netDebtEusdWei.toString(),
          },
        }
      : {}),
    spDepositEusdWei: spDeposit.toString(),
    spEthGainWei: spEthGain.toString(),
    spLqtyGainWei: spLqtyGain.toString(),
    spTotalDepositsEusdWei: state.spTotalDepositsEusdWei.toString(),
    spShareBps,
    ethBalanceWei: ethBalance.toString(),
    suggestedGasReserveWei: SUGGESTED_GAS_RESERVE_WEI.toString(),
  };
}

/// Your Trove plus where it sits in the redemption queue.
///
/// The position is the part that has no equivalent on any other venue: redemptions always start at
/// the riskiest Trove, so what matters is not only your own ratio but how much debt sits ahead of
/// you. `redeemedAheadEusdWei` is the redemption volume the system absorbs before it reaches you.
function buildTroveObservation(
  state: LiquityState,
  agent: Address,
  collWei: bigint,
  debtWei: bigint,
  status: number,
): LiquityTroveObservation {
  const gas = state.gasCompensationEusdWei;
  const netDebt = debtWei > gas ? debtWei - gas : 0n;
  const index = state.troves.findIndex(
    (t) => t.owner.toLowerCase() === agent.toLowerCase(),
  );
  const positionKnown = state.troveOrderKnown && index >= 0;
  let ahead = 0n;
  if (positionKnown) {
    for (let i = 0; i < index; i++) ahead += state.troves[i].netDebtEusdWei;
  }
  return {
    status,
    collWei: collWei.toString(),
    debtEusdWei: debtWei.toString(),
    netDebtEusdWei: netDebt.toString(),
    icr: icrOf(collWei, debtWei, state.priceUsd),
    liquidationPriceUsd: liquidationPriceUsd(collWei, debtWei, state.mcr),
    positionFromRiskiest: positionKnown ? index : -1,
    redeemedAheadEusdWei: ahead.toString(),
    positionKnown,
  };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

function maxFeeWad(bps: number | undefined): bigint {
  return (BigInt(bps ?? DEFAULT_MAX_FEE_BPS) * WAD) / 10_000n;
}

function unwrapWeth(amount: bigint): BuiltTx {
  return {
    to: TOKENS.WETH.address,
    data: encodeFunctionData({
      abi: wethAbi,
      functionName: "withdraw",
      args: [amount],
    }),
  };
}

/// Where a Trove with these numbers belongs in the sorted list.
///
/// Liquity inserts by *nominal* ICR (collateral x 1e20 / debt, price-free), so the hint stays valid
/// for the block it is computed in. An unhinted insert walks the list on chain, which is the
/// difference between a routine transaction and one that runs out of gas.
async function insertHints(
  publicClient: PublicClient,
  sortedTroves: Address,
  collWei: bigint,
  debtWei: bigint,
): Promise<[Address, Address]> {
  if (debtWei <= 0n) return [ZERO_ADDRESS, ZERO_ADDRESS];
  const nicr = (collWei * 10n ** 20n) / debtWei;
  const [upper, lower] = (await read(
    publicClient,
    sortedTroves,
    sortedTrovesAbi,
    "findInsertPosition",
    [nicr, ZERO_ADDRESS, ZERO_ADDRESS],
  )) as [Address, Address];
  return [upper, lower];
}

async function buildTxs(
  ctx: SimContext,
  owner: Address,
  action: LeafAction,
  state: LiquityState | undefined,
): Promise<BuiltTx[]> {
  const d = requireLiquity();
  const { publicClient } = ctx;
  switch (action.type) {
    case "liquityOpenTrove": {
      const coll = BigInt(action.collateralWethWei);
      const debt = BigInt(action.debtEusdWei);
      // The Trove books the requested debt plus the borrowing fee plus the gas compensation, and it
      // is that composite number the list sorts on -- hinting off the requested debt alone puts the
      // insert in the wrong place and the transaction pays to walk from there.
      const [fee, composite] = (await Promise.all([
        read(
          publicClient,
          d.troveManager,
          troveManagerAbi,
          "getBorrowingFeeWithDecay",
          [debt],
        ),
        read(
          publicClient,
          d.borrowerOperations,
          borrowerOperationsAbi,
          "getCompositeDebt",
          [debt],
        ),
      ])) as [bigint, bigint];
      const [upper, lower] = await insertHints(
        publicClient,
        d.sortedTroves,
        coll,
        composite + fee,
      );
      return [
        unwrapWeth(coll),
        {
          to: d.borrowerOperations,
          data: encodeFunctionData({
            abi: borrowerOperationsAbi,
            functionName: "openTrove",
            args: [maxFeeWad(action.maxFeeBps), debt, upper, lower],
          }),
          value: coll,
        },
      ];
    }
    case "liquityAdjustTrove": {
      const add = BigInt(action.addCollateralWethWei ?? "0");
      const withdraw = BigInt(action.withdrawCollateralWei ?? "0");
      const debtChange = BigInt(action.debtChangeEusdWei ?? "0");
      const increase = action.isDebtIncrease === true;
      const [debt, coll] = (await read(
        publicClient,
        d.troveManager,
        troveManagerAbi,
        "getEntireDebtAndColl",
        [owner],
      )) as readonly [bigint, bigint, bigint, bigint];
      const fee =
        increase && debtChange > 0n
          ? ((await read(
              publicClient,
              d.troveManager,
              troveManagerAbi,
              "getBorrowingFeeWithDecay",
              [debtChange],
            )) as bigint)
          : 0n;
      const nextColl = coll + add - withdraw;
      const nextDebt = increase
        ? debt + debtChange + fee
        : debt > debtChange
          ? debt - debtChange
          : 0n;
      const [upper, lower] = await insertHints(
        publicClient,
        d.sortedTroves,
        nextColl,
        nextDebt,
      );
      const call: BuiltTx = {
        to: d.borrowerOperations,
        data: encodeFunctionData({
          abi: borrowerOperationsAbi,
          functionName: "adjustTrove",
          args: [
            maxFeeWad(action.maxFeeBps),
            withdraw,
            debtChange,
            increase,
            upper,
            lower,
          ],
        }),
        ...(add > 0n ? { value: add } : {}),
      };
      return add > 0n ? [unwrapWeth(add), call] : [call];
    }
    case "liquityCloseTrove":
      return [
        {
          to: d.borrowerOperations,
          data: encodeFunctionData({
            abi: borrowerOperationsAbi,
            functionName: "closeTrove",
          }),
        },
      ];
    case "liquityRedeem": {
      // Routed through the helper rather than built here, because the hints cannot be computed off
      // chain: Liquity checks a partial redemption against a nominal ICR derived from the price the
      // *transaction* fetches, and this environment writes a new price every block ahead of every
      // agent. Every redemption in the venue's first live run reverted with "Unable to redeem any
      // amount" for exactly that reason. The helper computes them after fetchPrice has cached the
      // price the redemption will use, so the two cannot disagree.
      const helper = requireRedemptionHelper();
      return [
        {
          to: helper,
          data: encodeFunctionData({
            abi: liquityRedemptionHelperAbi,
            functionName: "redeem",
            args: [
              BigInt(action.amountEusdWei),
              maxFeeWad(action.maxFeeBps),
              BigInt(action.maxIterations ?? 0),
            ],
          }),
        },
      ];
    }
    case "liquityProvideToSP":
      return [
        {
          to: d.stabilityPool,
          data: encodeFunctionData({
            abi: stabilityPoolAbi,
            functionName: "provideToSP",
            // No front-end tag: this deployment has no front ends, so the whole LQTY share (which
            // nothing values here anyway) stays with the depositor.
            args: [BigInt(action.amountEusdWei), ZERO_ADDRESS],
          }),
        },
      ];
    case "liquityWithdrawFromSP": {
      const amount =
        action.amountEusdWei === "max"
          ? maxUint256
          : BigInt(action.amountEusdWei);
      return [
        {
          to: d.stabilityPool,
          data: encodeFunctionData({
            abi: stabilityPoolAbi,
            functionName: "withdrawFromSP",
            // The pool clamps to the compounded deposit, so "max" is the contract's own idiom for
            // taking everything -- no read needed, and no race with a liquidation in between.
            args: [amount],
          }),
        },
      ];
    }
    case "liquityLiquidate": {
      if (action.borrowers?.length) {
        return [
          {
            to: d.troveManager,
            data: encodeFunctionData({
              abi: troveManagerAbi,
              functionName: "batchLiquidateTroves",
              args: [action.borrowers as Address[]],
            }),
          },
        ];
      }
      return [
        {
          to: d.troveManager,
          data: encodeFunctionData({
            abi: troveManagerAbi,
            functionName: "liquidateTroves",
            args: [BigInt(action.maxTroves ?? 1)],
          }),
        },
      ];
    }
    case "liquitySwapEusd": {
      const market = requireEusdMarket();
      const amountIn = BigInt(action.amountIn);
      const [i, j] =
        action.tokenIn === "EUSD"
          ? [market.eusdIndex, market.usdcIndex]
          : [market.usdcIndex, market.eusdIndex];
      const quoted = (await read(
        publicClient,
        market.pool,
        curveStableSwapNgAbi,
        "get_dy",
        [BigInt(i), BigInt(j), amountIn],
      )) as bigint;
      const slippageBps = action.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
      const minDy = (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
      return [
        {
          to: market.pool,
          data: encodeFunctionData({
            abi: curveStableSwapNgAbi,
            functionName: "exchange",
            args: [BigInt(i), BigInt(j), amountIn, minDy],
          }),
        },
      ];
    }
    default:
      throw new Error("liquity buildTxs: unexpected action");
  }
}

// ---------------------------------------------------------------------------
// Valuation (issue #39 phase 4)
// ---------------------------------------------------------------------------

// What an agent holds on this venue, before it is priced.
type LiquityHoldings = {
  collWei: bigint;
  debtEusdWei: bigint;
  netDebtEusdWei: bigint;
  spDepositEusdWei: bigint;
  spEthGainWei: bigint;
  eusdBalanceWei: bigint;
};

/// Price a Liquity position, given what eUSD is worth.
///
/// Two marks, because they genuinely differ here and the difference is the venue's point:
///   mark        every eUSD leg at the market's executable *mid*, i.e. what the position is worth
///   realizable  the long leg at what selling that size would fetch, and the debt at what buying it
///               back would cost -- the impact of actually unwinding, which a mid cannot show
///
/// A Trove's contribution never goes below zero. Below 100% ICR the owner can stop repaying and lose
/// only the collateral, which is a real property of a CDP rather than an accounting convenience; a
/// negative mark would charge them for a liability they can walk away from.
export function liquityPositionValue(input: {
  holdings: LiquityHoldings;
  fairPriceUsd: number;
  eusdPriceUsdc: number;
  // Own-size quotes, when the pool answered. Falling back to the mid understates nothing and
  // overstates nothing systematically -- it simply omits the impact.
  longExitUsdc?: number;
  debtBuybackUsdc?: number;
}): { valueUsdc: number; liquidatableValueUsdc: number } {
  const { holdings: h, fairPriceUsd, eusdPriceUsdc } = input;
  const longEusd = toFloat(h.eusdBalanceWei + h.spDepositEusdWei);
  const collUsd = toFloat(h.collWei) * fairPriceUsd;
  const gainUsd = toFloat(h.spEthGainWei) * fairPriceUsd;
  const netDebtEusd = toFloat(h.netDebtEusdWei);

  const troveMark = Math.max(0, collUsd - netDebtEusd * eusdPriceUsdc);
  const troveExit = Math.max(
    0,
    collUsd - (input.debtBuybackUsdc ?? netDebtEusd * eusdPriceUsdc),
  );
  return {
    valueUsdc: troveMark + gainUsd + longEusd * eusdPriceUsdc,
    liquidatableValueUsdc:
      troveExit + gainUsd + (input.longExitUsdc ?? longEusd * eusdPriceUsdc),
  };
}

function usdcFloat(units: bigint): number {
  return Number(formatUnits(units, USDC_DECIMALS));
}

/// Historical valuation (issue #41's staged reads).
///
/// Two stages, because the realizable mark depends on sizes the first stage returns:
///   0. the market's two-sided probe, the gas compensation, and every agent's Trove / Stability Pool
///      / eUSD position
///   1. for exactly the agents that hold eUSD or owe it: what their own size would sell for, and
///      what buying their debt back would cost
///
/// Takes the deployment explicitly rather than reading the module constant, so the marking rules can
/// be exercised without a deployed venue.
export async function* liquityValuationRun(
  deployment: LiquityDeployment,
  ctx: ValuationContext,
): ValuationRun {
  const hasMarket =
    Boolean(deployment.eusdUsdcPool) &&
    deployment.eusdIndex !== undefined &&
    deployment.usdcIndex !== undefined;
  const pool = deployment.eusdUsdcPool as Address;
  const eusdIndex = BigInt(deployment.eusdIndex ?? 0);
  const usdcIndex = BigInt(deployment.usdcIndex ?? 1);

  const stage0: ValuationRead[] = [
    {
      address: deployment.troveManager,
      abi: troveManagerAbi,
      functionName: "LUSD_GAS_COMPENSATION",
    },
    ...(hasMarket
      ? [
          {
            address: pool,
            abi: curveStableSwapNgAbi,
            functionName: "get_dy",
            args: [eusdIndex, usdcIndex, PROBE_EUSD_WEI],
          },
        ]
      : []),
    ...ctx.agents.flatMap((a) => [
      {
        address: deployment.troveManager,
        abi: troveManagerAbi,
        functionName: "getEntireDebtAndColl",
        args: [a.address],
      },
      {
        address: deployment.stabilityPool,
        abi: stabilityPoolAbi,
        functionName: "getCompoundedLUSDDeposit",
        args: [a.address],
      },
      {
        address: deployment.stabilityPool,
        abi: stabilityPoolAbi,
        functionName: "getDepositorETHGain",
        args: [a.address],
      },
      {
        address: deployment.eusd,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [a.address],
      },
    ]),
  ];
  const results = yield stage0;

  const gasCompensation =
    typeof results[0] === "bigint" ? (results[0] as bigint) : 0n;
  const probeOut =
    hasMarket && typeof results[1] === "bigint"
      ? (results[1] as bigint)
      : undefined;
  const perAgentBase = hasMarket ? 2 : 1;
  const holdings = ctx.agents.map((_agent, i) => {
    const base = perAgentBase + i * 4;
    const entire = results[base] as
      readonly [bigint, bigint, bigint, bigint] | undefined;
    const spDeposit = results[base + 1];
    const spGain = results[base + 2];
    const eusd = results[base + 3];
    if (
      !entire ||
      typeof spDeposit !== "bigint" ||
      typeof spGain !== "bigint" ||
      typeof eusd !== "bigint"
    )
      return undefined;
    const [debt, coll] = entire;
    return {
      collWei: coll,
      debtEusdWei: debt,
      netDebtEusdWei: debt > gasCompensation ? debt - gasCompensation : 0n,
      spDepositEusdWei: spDeposit,
      spEthGainWei: spGain,
      eusdBalanceWei: eusd,
    } satisfies LiquityHoldings;
  });

  // The mid, from the probe alone. Only the sell side is probed here: the second stage already costs
  // a round trip for the sizes that matter, and pairing it with a buy quote of the same notional
  // would double the reads on every block for a second decimal place.
  const probeMid = probeOut ? usdcPerEusd(PROBE_EUSD_WEI, probeOut) : undefined;

  // Own-size quotes, for exactly the agents whose position has a size worth quoting.
  const longTargets: number[] = [];
  const debtTargets: number[] = [];
  holdings.forEach((h, i) => {
    if (!h) return;
    if (h.eusdBalanceWei + h.spDepositEusdWei > 0n) longTargets.push(i);
    if (h.netDebtEusdWei > 0n) debtTargets.push(i);
  });
  let quotes: unknown[] = [];
  if (hasMarket && (longTargets.length > 0 || debtTargets.length > 0)) {
    quotes = yield [
      ...longTargets.map((i): ValuationRead => ({
        address: pool,
        abi: curveStableSwapNgAbi,
        functionName: "get_dy",
        args: [
          eusdIndex,
          usdcIndex,
          holdings[i]!.eusdBalanceWei + holdings[i]!.spDepositEusdWei,
        ],
      })),
      ...debtTargets.map((i): ValuationRead => ({
        address: pool,
        abi: curveStableSwapNgAbi,
        // What it costs to buy the debt back, which is not get_dy of anything: the size is fixed on
        // the *output* side. Marking a liability off the wrong side of the book flatters it exactly
        // when eUSD is dear, which is when a Trove is most expensive to close.
        functionName: "get_dx",
        args: [usdcIndex, eusdIndex, holdings[i]!.netDebtEusdWei],
      })),
    ];
  }
  const longExitByIndex = new Map<number, number>();
  longTargets.forEach((agentIndex, k) => {
    const q = quotes[k];
    if (typeof q === "bigint") longExitByIndex.set(agentIndex, usdcFloat(q));
  });
  const debtCostByIndex = new Map<number, number>();
  debtTargets.forEach((agentIndex, k) => {
    const q = quotes[longTargets.length + k];
    if (typeof q === "bigint") debtCostByIndex.set(agentIndex, usdcFloat(q));
  });

  const fairWeth = ctx.fairByBase().WETH ?? 0;
  const out: Record<string, AgentProtocolValue> = {};
  ctx.agents.forEach((agent, i) => {
    const h = holdings[i];
    if (!h) {
      // The read that would have revealed the position failed. "Zero" here is indistinguishable
      // from having closed out, so it is reported instead (issue #44).
      out[agent.id] = {
        valueUsdc: 0,
        liquidatableValueUsdc: 0,
        unpriced: [
          {
            source: "liquity-position",
            amountRaw: "",
            reason: "read-failed",
            read: "TroveManager.getEntireDebtAndColl",
          },
        ],
      };
      return;
    }
    const unpriced: UnpricedHoldingDetail[] = [];
    const exposure = h.eusdBalanceWei + h.spDepositEusdWei + h.netDebtEusdWei;
    if (probeMid === undefined && exposure > 0n) {
      // Falling back to par is the least wrong choice -- par is the value the protocol itself
      // enforces through redemption -- but it is exactly the assumption this venue must not make
      // silently, so the eUSD leg is reported as marked without a market.
      unpriced.push({
        token: deployment.eusd,
        amountRaw: exposure.toString(),
        source: "liquity-eusd-market",
        reason: "read-failed",
        read: "CurveStableSwapNG.get_dy",
      });
    }
    const value = liquityPositionValue({
      holdings: h,
      fairPriceUsd: fairWeth,
      eusdPriceUsdc: probeMid ?? 1,
      longExitUsdc: longExitByIndex.get(i),
      debtBuybackUsdc: debtCostByIndex.get(i),
    });
    out[agent.id] = { ...value, unpriced };
  });
  return out;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const liquityAdapter: ProtocolAdapter = {
  id: "liquity",
  parse,
  // Every call here is an ordinary transaction, so a Liquity leg can ride in a bundle with an AMM
  // leg -- buying a depegged eUSD and redeeming it in one shot is the venue's headline trade.
  bundleable: () => true,
  validate,

  async readState(ctx, fairPrice): Promise<LiquityState> {
    return getLiquityState(ctx, fairPrice);
  },

  async observe(ctx, state, agent): Promise<LiquityObservation> {
    return observe(ctx, state as LiquityState, agent);
  },

  async buildTxs(ctx, owner, action, state): Promise<BuiltTx[]> {
    return buildTxs(ctx, owner, action, state as LiquityState | undefined);
  },

  async valueUsdc(ctx, agent, state, fairPrice): Promise<number> {
    if (!LIQUITY) return 0;
    const d = LIQUITY;
    const s = state as LiquityState | undefined;
    const [entire, spDeposit, spGain, eusdBalance, gasCompensation] =
      (await Promise.all([
        read(
          ctx.publicClient,
          d.troveManager,
          troveManagerAbi,
          "getEntireDebtAndColl",
          [agent],
        ),
        read(
          ctx.publicClient,
          d.stabilityPool,
          stabilityPoolAbi,
          "getCompoundedLUSDDeposit",
          [agent],
        ),
        read(
          ctx.publicClient,
          d.stabilityPool,
          stabilityPoolAbi,
          "getDepositorETHGain",
          [agent],
        ),
        read(ctx.publicClient, d.eusd, erc20Abi, "balanceOf", [agent]),
        read(
          ctx.publicClient,
          d.troveManager,
          troveManagerAbi,
          "LUSD_GAS_COMPENSATION",
        ),
      ])) as [
        readonly [bigint, bigint, bigint, bigint],
        bigint,
        bigint,
        bigint,
        bigint,
      ];
    const [debt, coll] = entire;
    const eusdPriceUsdc = s?.marketQuoted ? s.midPriceUsdc : 1;
    return liquityPositionValue({
      holdings: {
        collWei: coll,
        debtEusdWei: debt,
        netDebtEusdWei: debt > gasCompensation ? debt - gasCompensation : 0n,
        spDepositEusdWei: spDeposit,
        spEthGainWei: spGain,
        eusdBalanceWei: eusdBalance,
      },
      fairPriceUsd: fairPrice,
      eusdPriceUsdc,
    }).valueUsdc;
  },

  valueAtBlock(ctx) {
    if (!LIQUITY) {
      const empty: Record<string, AgentProtocolValue> = {};
      for (const a of ctx.agents)
        empty[a.id] = { valueUsdc: 0, liquidatableValueUsdc: 0, unpriced: [] };
      return (async function* () {
        return empty;
      })();
    }
    return liquityValuationRun(LIQUITY, ctx);
  },

  async accountedTokens(): Promise<Address[]> {
    // eUSD is valued above. LQTY deliberately is not listed: the venue issues it (Stability Pool
    // deposits accrue it) but nothing values it, and issue #41's convention is that such a token
    // stays visible as an unaccounted holding rather than being quietly excused.
    return LIQUITY ? [LIQUITY.eusd] : [];
  },

  async setupWallet(): Promise<BuiltTx[]> {
    if (!LIQUITY?.eusdUsdcPool) return [];
    // Liquity itself never pulls tokens through an allowance -- the stablecoin has privileged
    // transfer paths for the pools -- so the only approvals needed are for its market and for the
    // redemption helper, which does take the eUSD it redeems.
    return [
      approveTx(LIQUITY.eusd, LIQUITY.eusdUsdcPool),
      approveTx(TOKENS.USDC.address, LIQUITY.eusdUsdcPool),
      ...(LIQUITY.redemptionHelper
        ? [approveTx(LIQUITY.eusd, LIQUITY.redemptionHelper)]
        : []),
    ];
  },
};

export const LIQUITY_PROBE_EUSD_WEI = PROBE_EUSD_WEI;
export const LIQUITY_GAS_RESERVE_WEI = SUGGESTED_GAS_RESERVE_WEI;
