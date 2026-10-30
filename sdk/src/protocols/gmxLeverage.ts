// The GMX leverage cap, checked before GMX checks it.
//
// GMX applies MIN_COLLATERAL_FACTOR (gmxKeys.ts GMX_MIN_COLLATERAL_FACTOR, ~5.05x) inside the keeper's
// executeOrder, at the execution price, and for a market order that fails it cancels the order and
// refunds the collateral and the execution fee in the same transaction (OrderHandler's
// `isMarketOrder` branch). The minimum execution fee is gasLimit x tx.gasprice = 0 at a tip of 0. So
// an order sized just over the cap was a free conditional order: a WETH-collateral long at ~1.03x the
// cap executed only if the price had risen ~3% (the collateral is worth more), and otherwise came
// back at no cost, to be re-sent the next block -- the stop order 11d74b7 closed for real stop
// orders, rebuilt out of the cap. It rides the rest of a spike's gap. A short standing at the cap
// gives the downside version: its own PnL lets an add-on increase pass only after a drop.
//
// The keeper sets the prices every order executes at (it writes the mock oracle provider for the
// next block), so it can decide first: for each order it is about to execute it computes the
// position the order would leave at exactly those prices, and does not execute one that would use
// more than GMX_KEEPER_CAP_USE of the cap. A refused market order is not refunded: it stays in the
// OrderVault, counted as nothing, until its account cancels it after requestExpirationTime (300 s,
// deployer/vendor/gmx-localhost.patch). A miss now locks the collateral for 150 blocks instead of
// costing nothing. The margin under the cap is what keeps GMX from ever reaching its own
// cancel-and-refund for the cap: the keeper rounds every term it does not read exactly toward the
// stricter side (fees at the larger factor plus the most a UI fee can add, the worst negative impact
// the check may count, no referral discount), and 2% of the required equity is ~40bps of size at the
// cap, against fees of 6bps and impacts under 1bp at this deploy's depths. GMX's check stays as the
// backstop.
//
// A refusal only costs what the order carries, so every increase must also carry collateral for its
// own size at no more than the keeper's line (gmxOwnCapUse): GMX accepts an increase with size and
// no collateral, and an empty add-on to a position standing at the cap would otherwise be the same
// free conditional order, refused at no cost. Refused, an increase now locks at least size / ~4.95.
// A decrease locks only its execution fee when refused, but one the cap conditions on the price goes
// through only after a move in the position's favour (it must leave the rest under the line): a
// withdrawal changes no exposure, and a partial close after a favourable move is a contrarian order,
// which takes nothing from a gap that does not come back.
//
// What GMX checks, and which of it this covers (gmx-synthetics contracts/position):
//   - increase (IncreasePositionUtils): willPositionCollateralBeSufficient -- collateral after the
//     opening fee and the pending borrowing/funding, at the collateral's price, against size x
//     max(MIN_COLLATERAL_FACTOR, the open-interest factor) -- then validatePosition, whose
//     isPositionLiquidatable compares equity (collateral + PnL + capped impact - closing fees) with
//     size x MIN_COLLATERAL_FACTOR. Both are "collateral" and "equity" below.
//   - decrease (DecreasePositionUtils), partial only: a collateral withdrawal that fails
//     willPositionCollateralBeSufficient (remaining collateral plus any realized loss) is zeroed, or
//     with no size the order is cancelled; then validatePosition on what remains cancels it.
//   - not covered, on purpose: a collateral deposit (an increase of no size) is checked by GMX against
//     the liquidation factor (1%), not the cap; a full close always executes; MIN_COLLATERAL_USD and
//     MIN_POSITION_SIZE_USD ($1 each) only bind positions of a few dollars; the reserve and
//     open-interest caps are price-independent on a [base-base-USDC] market (a long's reserve and its
//     pool are both in the base); acceptablePrice / minOutputAmount give only a contrarian limit.
//
// Pure: reads in, a share of the cap out. The chain IO is the keeper's (gmx.ts keeperOrderPlan), and
// the reference runtime feeds the same function from its observation (gmx.ts validate).

/** The keeper does not execute an order that would use more than this share of the cap at the execution price. */
export const GMX_KEEPER_CAP_USE = 0.98;
/**
 * The reference runtime does not send an increase, or a decrease that withdraws collateral, that
 * would use more than this share of the cap at the price it observed. The price moves between
 * observing and executing (a block or two; 10% a block inside a crash or spike gap), and an order
 * the keeper refuses is locked for 300 s, so an honest order leaves room.
 */
export const GMX_RUNTIME_CAP_USE = 0.9;
/**
 * The position fee the runtime assumes when it cannot read the DataStore: the larger of the deploy's
 * two (0.06%, for an order that widens the skew; deployer/vendor/gmx-localhost.patch).
 */
export const GMX_ASSUMED_POSITION_FEE_FACTOR = 6n * 10n ** 26n;

const FLOAT_PRECISION = 10n ** 30n;
const SHARE_PRECISION = 10n ** 12n;

function applyFactor(value: bigint, factor: bigint): bigint {
  return (value * factor) / FLOAT_PRECISION;
}

/** required / available as a number; Infinity when nothing is available. */
function share(required: bigint, available: bigint): number {
  if (available <= 0n) return Infinity;
  return Number((required * SHARE_PRECISION) / available) / Number(SHARE_PRECISION);
}

/** A position as GMX's check reads it, at the execution prices. USD at 30 decimals. */
export type GmxCapPosition = {
  sizeInUsd: bigint;
  /** Collateral token units. */
  collateralAmount: bigint;
  /** PnL of the whole position at the execution prices, as GMX caps it (Reader basePnlUsd). */
  pnlUsd: bigint;
  /** Borrowing + funding owed, collateral token units: the next order pays it out of the collateral. */
  pendingFeeAmount: bigint;
  /** The impact closing the whole position would realize now (negative = a cost); scaled to a partial decrease. */
  closeImpactUsd?: bigint;
};

/** The market-side inputs of the check. Factors at 30 decimals. */
export type GmxCapMarket = {
  /** The collateral token's price, GMX scale (USD x 10^(30 - decimals) per unit). */
  collateralPrice: bigint;
  /** MIN_COLLATERAL_FACTOR: the cap. */
  minCollateralFactor: bigint;
  /** MIN_COLLATERAL_FACTOR_FOR_OPEN_INTEREST_MULTIPLIER of the order's side; absent or 0 = none. */
  oiMultiplierFactor?: bigint;
  /** Open interest of the order's side before the order, USD. */
  openInterestUsd?: bigint;
  /** Charged per unit of size on open and again on close: the larger position fee plus the max UI fee. */
  feeFactor: bigint;
  /** MAX_POSITION_IMPACT_FACTOR_FOR_LIQUIDATIONS: the most negative impact the check counts. */
  maxImpactFactorForLiquidations?: bigint;
};

export type GmxCapOrder = {
  kind: "increase" | "decrease";
  sizeDeltaUsd: bigint;
  /** Increase: the collateral posted. Decrease: the collateral withdrawn. Collateral token units. */
  collateralDeltaAmount: bigint;
};

/** Where the order would leave the position, in the terms GMX checks. */
export type GmxCapUse = {
  sizeAfterUsd: bigint;
  /** Collateral GMX compares with size x max(factor, OI factor), PnL not counted; undefined when it does not check it. */
  collateralAfterUsd?: bigint;
  /** Collateral + PnL + impact - closing fees, which GMX compares with size x factor. */
  equityAfterUsd: bigint;
  /** The larger share of the cap the two tests use: 1 is exactly GMX's line; Infinity when nothing is left. */
  capUse: number;
  /** capUse in units of leverage: size / equity (or / collateral when that is the binding test). */
  leverage: number;
  binding: "collateral" | "equity";
};

/**
 * The share of the cap the position would use after this order, at the given prices, or null when
 * GMX does not apply the cap to it: a collateral deposit (increase of no size), a decrease with no
 * position or of more than its size (reverted at any price), a full close, a decrease that changes
 * neither size nor collateral, or any order on a market with no factor set.
 */
export function gmxCapUse(
  order: GmxCapOrder,
  position: GmxCapPosition | undefined,
  market: GmxCapMarket,
): GmxCapUse | null {
  const factor = market.minCollateralFactor;
  // No factor configured (an unpatched deploy): GMX has no cap to apply.
  if (factor <= 0n) return null;
  const pos = position && position.sizeInUsd > 0n ? position : undefined;
  const price = market.collateralPrice;
  const fee = market.feeFactor;
  const impactCap = market.maxImpactFactorForLiquidations ?? 0n;
  const oiFactor = (openInterestAfter: bigint): bigint => {
    const multiplier = market.oiMultiplierFactor ?? 0n;
    if (multiplier === 0n) return factor;
    const byOi = applyFactor(
      openInterestAfter > 0n ? openInterestAfter : 0n,
      multiplier,
    );
    return byOi > factor ? byOi : factor;
  };
  const openInterest = market.openInterestUsd ?? 0n;
  // isPositionLiquidatable's equity: the PnL, closing fees on the whole size, and the most negative
  // impact it may count (it caps the impact at -size x the factor, and at 0 from above).
  const equity = (collateralUsd: bigint, pnlUsd: bigint, size: bigint) =>
    collateralUsd + pnlUsd - applyFactor(size, fee) - applyFactor(size, impactCap);

  if (order.kind === "increase") {
    if (order.sizeDeltaUsd === 0n) return null;
    const sizeAfter = (pos?.sizeInUsd ?? 0n) + order.sizeDeltaUsd;
    // processCollateral: the posted amount, less the opening fee and what the position owed.
    const collateralAfterUsd =
      ((pos?.collateralAmount ?? 0n) -
        (pos?.pendingFeeAmount ?? 0n) +
        order.collateralDeltaAmount) *
        price -
      applyFactor(order.sizeDeltaUsd, fee);
    // The new tokens are bought at the index price, so their PnL is 0 at it; the old ones keep theirs.
    const equityAfterUsd = equity(collateralAfterUsd, pos?.pnlUsd ?? 0n, sizeAfter);
    return capResult(
      sizeAfter,
      factor,
      { usd: collateralAfterUsd, factor: oiFactor(openInterest + order.sizeDeltaUsd) },
      equityAfterUsd,
    );
  }

  if (!pos) return null;
  if (order.sizeDeltaUsd >= pos.sizeInUsd) return null;
  if (order.sizeDeltaUsd === 0n && order.collateralDeltaAmount === 0n) return null;
  const withdrawn =
    order.collateralDeltaAmount > pos.collateralAmount
      ? pos.collateralAmount
      : order.collateralDeltaAmount;
  const sizeAfter = pos.sizeInUsd - order.sizeDeltaUsd;
  const realizedPnl = (pos.pnlUsd * order.sizeDeltaUsd) / pos.sizeInUsd;
  // A realized loss is paid out of the collateral; a realized gain goes to the account, not into it.
  const lossPaid = realizedPnl < 0n ? realizedPnl : 0n;
  // The withdrawal test (willPositionCollateralBeSufficient): no fees, no remaining PnL.
  const collateralTestUsd = (pos.collateralAmount - withdrawn) * price + lossPaid;
  const closeImpact = pos.closeImpactUsd ?? 0n;
  const realizedImpact =
    closeImpact < 0n ? (closeImpact * order.sizeDeltaUsd) / pos.sizeInUsd : 0n;
  const collateralAfterUsd =
    (pos.collateralAmount - withdrawn - pos.pendingFeeAmount) * price -
    applyFactor(order.sizeDeltaUsd, fee) +
    lossPaid +
    realizedImpact;
  const equityAfterUsd = equity(
    collateralAfterUsd,
    pos.pnlUsd - realizedPnl,
    sizeAfter,
  );
  // With nothing withdrawn, a failed withdrawal test changes nothing (GMX zeroes a zero); only what
  // remains is checked.
  const testsCollateral = withdrawn > 0n || order.sizeDeltaUsd === 0n;
  return capResult(
    sizeAfter,
    factor,
    testsCollateral
      ? {
          usd: collateralTestUsd,
          factor: oiFactor(openInterest - order.sizeDeltaUsd),
        }
      : undefined,
    equityAfterUsd,
  );
}

/**
 * The share of the cap an increase's own collateral carries its own size at, as if the order opened a
 * position alone (fees on both ends), or null for anything that is not an increase with size.
 *
 * The keeper and the runtime hold every increase to this as well as to the whole-position check
 * (gmxCapUse). The point of refusing instead of letting GMX cancel is that a refusal locks what the
 * order carries; GMX accepts an increase with size and no collateral, so an add-on with nothing
 * posted, to a position standing at the cap, was still a free conditional order -- refused, it
 * locked nothing. With this rule such an add-on is refused at every price, so it carries no option,
 * and any refused increase locks at least its size / ~4.95 for 300 s.
 */
export function gmxOwnCapUse(
  order: GmxCapOrder,
  market: GmxCapMarket,
): GmxCapUse | null {
  if (order.kind !== "increase") return null;
  return gmxCapUse(order, undefined, market);
}

function capResult(
  sizeAfterUsd: bigint,
  factor: bigint,
  collateral: { usd: bigint; factor: bigint } | undefined,
  equityAfterUsd: bigint,
): GmxCapUse {
  const byEquity = share(applyFactor(sizeAfterUsd, factor), equityAfterUsd);
  const byCollateral = collateral
    ? share(applyFactor(sizeAfterUsd, collateral.factor), collateral.usd)
    : 0;
  const capUse = Math.max(byEquity, byCollateral);
  return {
    sizeAfterUsd,
    ...(collateral ? { collateralAfterUsd: collateral.usd } : {}),
    equityAfterUsd,
    capUse,
    leverage: capUse * (Number(FLOAT_PRECISION) / Number(factor)),
    binding: byCollateral > byEquity ? "collateral" : "equity",
  };
}

/** The leverage `use` of the cap stands for, rounded for a message. */
function times(value: number): string {
  return `${value.toFixed(2)}x`;
}

/**
 * Why this order must not go ahead, or null if it may: over `maxUse` of a cap of `maxLeverage`.
 * `where` names the price ("the execution price" for the keeper, "the observed price" for the
 * runtime); `own` says the use is the order's own collateral against its own size (gmxOwnCapUse)
 * rather than the position it would leave.
 */
export function gmxCapRefusal(
  use: GmxCapUse | null,
  opts: { maxUse: number; maxLeverage: number; where: string; own?: boolean },
): string | null {
  if (use === null || use.capUse <= opts.maxUse) return null;
  const limit = `${times(opts.maxUse * opts.maxLeverage)} (${Math.round(
    opts.maxUse * 100,
  )}% of the ${times(opts.maxLeverage)} cap)`;
  if (opts.own) {
    const rule = "an increase must bring the collateral for its own size";
    if (!Number.isFinite(use.capUse))
      // No collateral, or none left after the fees on both ends: "collateral" either way to the agent.
      return `brings no collateral for its own size at ${opts.where}, over ${limit}: ${rule}`;
    return (
      `would carry its own size at ${times(use.leverage)} on its own collateral ` +
      `(size / ${use.binding}) at ${opts.where}, over ${limit}: ${rule}`
    );
  }
  if (!Number.isFinite(use.capUse))
    return `would leave the position with no ${use.binding} at ${opts.where}, over ${limit}`;
  return (
    `would leave the position at ${times(use.leverage)} (size / ${use.binding}) at ${opts.where}, ` +
    `over ${limit}`
  );
}
