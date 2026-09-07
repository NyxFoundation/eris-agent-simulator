// Which venue a transaction reached, and what each venue node shows.
//
// Kept in its own module with no imports for two reasons: the world map is the only view that has
// to place a transaction on a *node* (every other view names a method and stops), and the action
// vocabulary it joins against lives in the sdk (`ACTION_TYPES_BY_PROTOCOL`, sdk/src/action.ts),
// which cannot be imported into the browser bundle — it pulls in the protocol adapters and viem.
// `test/dashboardWorldVenues.test.ts` reads both and fails when an action type is added or renamed
// without this table following, so the copy cannot drift silently.

/** A venue node's shape on the map. The glyph is the taxonomy; there is no fourth kind for decoration. */
export type WorldVenueKind = "pool" | "perp" | "lending" | "stake" | "cdp";

export interface WorldVenueSpec {
  kind: WorldVenueKind;
  color: string;
}

/**
 * Every protocol that can hold state on the map. `lending` is the permissionless lending singleton
 * an agent deploys markets on (issue #40) — a venue the environment did not place, which is why it
 * is here rather than folded into `aave`.
 */
export const WORLD_VENUES: Record<string, WorldVenueSpec> = {
  uniswap: { kind: "pool", color: "#7c9eff" },
  balancer: { kind: "pool", color: "#f5a623" },
  curve: { kind: "pool", color: "#4fd1a5" },
  gmx: { kind: "perp", color: "#b18cf0" },
  aave: { kind: "lending", color: "#6dd3e0" },
  lst: { kind: "stake", color: "#e879a6" },
  liquity: { kind: "cdp", color: "#f0a3c0" },
  lending: { kind: "lending", color: "#9aa4b2" },
};

/** An Eris action type -> the venue it goes to. The sender's own account of what it did. */
export const VENUE_BY_ACTION: Record<string, string> = {
  swap: "uniswap",
  mintLiquidity: "uniswap",
  removeLiquidity: "uniswap",
  collectFees: "uniswap",
  createPool: "uniswap",

  balancerSwap: "balancer",

  curveSwap: "curve",
  stableSwap: "curve",

  gmxIncrease: "gmx",
  gmxDecrease: "gmx",

  aaveSupply: "aave",
  aaveWithdraw: "aave",
  aaveBorrow: "aave",
  aaveRepay: "aave",

  lstDeposit: "lst",
  lstSwap: "lst",
  lstRequestWithdraw: "lst",
  lstClaimWithdraw: "lst",

  liquityOpenTrove: "liquity",
  liquityAdjustTrove: "liquity",
  liquityCloseTrove: "liquity",
  liquityRedeem: "liquity",
  liquityProvideToSP: "liquity",
  liquityWithdrawFromSP: "liquity",
  liquityLiquidate: "liquity",
  liquitySwapEusd: "liquity",

  createLendingMarket: "lending",
  lendingSupply: "lending",
  lendingWithdraw: "lending",
  lendingSupplyCollateral: "lending",
  lendingWithdrawCollateral: "lending",
  lendingBorrow: "lending",
  lendingRepay: "lending",
  lendingLiquidate: "lending",
};

/**
 * A decoded function name -> the venue that function belongs to (ADR 0021 §4).
 *
 * The fallback, and the only join that works for a participant running their own agent: the method
 * is decoded from the transaction's own calldata, so it is there for every sender, while the action
 * type above is a self-report that only arrives for agents the coordinator started.
 *
 * **Only unambiguous names are listed.** `deposit` is both the WETH wrap and the LST vault's stake;
 * `withdraw` is both the unwrap and Aave's; `multicall` is half the venues. Guessing a node for
 * those would put a transaction on a contract it never touched, so they resolve to nothing and the
 * transaction is shown reaching the chain and stopping there.
 */
export const VENUE_BY_METHOD: Record<string, string> = {
  exactInputSingle: "uniswap",
  exactInput: "uniswap",
  exactOutputSingle: "uniswap",
  increaseLiquidity: "uniswap",
  decreaseLiquidity: "uniswap",
  createAndInitializePoolIfNecessary: "uniswap",

  batchSwap: "balancer",
  joinPool: "balancer",
  exitPool: "balancer",

  exchange: "curve",
  exchange_received: "curve",
  add_liquidity: "curve",
  remove_liquidity: "curve",
  remove_liquidity_one_coin: "curve",

  createOrder: "gmx",
  cancelOrder: "gmx",

  supply: "aave",
  borrow: "aave",
  repay: "aave",
  liquidationCall: "aave",
  setUserUseReserveAsCollateral: "aave",

  openTrove: "liquity",
  closeTrove: "liquity",
  adjustTrove: "liquity",
  redeemCollateral: "liquity",
  provideToSP: "liquity",
  withdrawFromSP: "liquity",
  batchLiquidateTroves: "liquity",
};

/**
 * The venue a transaction reached, or null when nothing on it names one.
 *
 * `protocol` (the sender's mempool self-report) wins over the decoded method: it says which venue,
 * where the method only says which function. The two tables also disagree on one name — `swap` is
 * Uniswap's action and Balancer's function — which is why the method table does not carry it.
 */
export function venueOfTx(tx: {
  protocol?: string | undefined;
  actionType?: string | undefined;
  method?: string | undefined;
}): string | null {
  if (tx.protocol && tx.protocol in WORLD_VENUES) return tx.protocol;
  if (tx.actionType && VENUE_BY_ACTION[tx.actionType])
    return VENUE_BY_ACTION[tx.actionType];
  if (tx.method && VENUE_BY_METHOD[tx.method]) return VENUE_BY_METHOD[tx.method];
  return null;
}
