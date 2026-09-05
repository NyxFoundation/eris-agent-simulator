import type { Address, Hex } from "viem";

// Keys of the token registry (TOKENS in src/markets.ts). Made a string by stripping the literal union
// (so adding a token is just adding a constant. ADR 0013). Actual existence is managed in TOKENS.
export type TokenSymbol = string;
// base = a tradable with a USD price (WETH/WBTC…), stable = a $1-pegged settlement currency
// (USDC-equivalent), lst = a yield-bearing claim on a base whose venue values it itself.
//
// An lst is deliberately neither of the first two. Calling it a base would put it in the scorer's
// spot sweep, priced off the fair-price feed at face value -- while its own adapter is separately
// marking it at what it could realize (issue #38). That is a double count and a wrong number.
// Keeping it its own kind means it is only ever valued by the venue that understands it.
export type TokenKind = "base" | "stable" | "lst";

export type ProtocolId =
  | "uniswap"
  | "balancer"
  | "curve"
  | "gmx"
  | "aave"
  | "lst"
  | "liquity"
  // Issue #40: the permissionless lending singleton agents create markets in. Distinct from `aave`
  // because Aave's reserves are opened by an admin-only PoolConfigurator, so it cannot be opened to
  // agents without handing them admin.
  | "lending";

// ---------------------------------------------------------------------------
// Market leg (venue-specific metadata. ADR 0013). One per protocol × base.
// MARKET_LEGS (constants) holds the protocol→base→leg table, and markets.ts assembles it into
// MarketConfig. New tokens add a market by adding a single leg.
// ---------------------------------------------------------------------------
export type UniswapLeg = { pool: Address; fee: number; tickSpacing: number };
export type BalancerLeg = { poolId: Hex; tokens: Address[]; stable: Address };
export type CurveLeg = {
  pool: Address;
  baseIndex: number;
  quoteIndex: number;
  stable: Address;
};
export type GmxLeg = { market: Address };
export type AaveLeg = Record<string, never>;
export type MarketLegs = {
  uniswap: Record<TokenSymbol, UniswapLeg>;
  balancer: Record<TokenSymbol, BalancerLeg>;
  curve: Record<TokenSymbol, CurveLeg>;
  gmx: Record<TokenSymbol, GmxLeg>;
  aave: Record<TokenSymbol, AaveLeg>;
};

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

// Uniswap
export type SwapAction = {
  type: "swap";
  tokenIn: TokenSymbol;
  // The traded market's base (default WETH. ADR 0013). tokenIn is either the base or the quote.
  base?: TokenSymbol;
  amountIn: string;
  maxPriorityFeePerGasWei?: string;
  slippageBps?: number;
};

export type MintLiquidityAction = {
  type: "mintLiquidity";
  // ADR 0013: the market's base (default WETH). When base is set, use amountBase/QuoteDesired.
  base?: TokenSymbol;
  tickLower: number;
  tickUpper: number;
  // WETH-market compatibility fields (required when base is unset).
  amountWethDesired: string;
  amountUsdcDesired: string;
  // Generic fields (used when base is set).
  amountBaseDesired?: string;
  amountQuoteDesired?: string;
  slippageBps?: number;
  maxPriorityFeePerGasWei?: string;
};

export type RemoveLiquidityAction = {
  type: "removeLiquidity";
  base?: TokenSymbol; // ADR 0013: the market's base (default WETH). amountWethMin is the base min.
  tokenId: string;
  liquidity: string;
  amountWethMin?: string;
  amountUsdcMin?: string;
  maxPriorityFeePerGasWei?: string;
};

export type CollectFeesAction = {
  type: "collectFees";
  base?: TokenSymbol; // ADR 0013: the market's base (default WETH)
  tokenId: string;
  maxPriorityFeePerGasWei?: string;
};

// Balancer v2 / Curve (spot swap)
export type BalancerSwapAction = {
  type: "balancerSwap";
  tokenIn: TokenSymbol;
  base?: TokenSymbol; // ADR 0013: the market's base (default WETH)
  amountIn: string;
  slippageBps?: number;
  maxPriorityFeePerGasWei?: string;
};

export type CurveSwapAction = {
  type: "curveSwap";
  tokenIn: TokenSymbol;
  base?: TokenSymbol; // ADR 0013: the market's base (default WETH)
  amountIn: string;
  slippageBps?: number;
  maxPriorityFeePerGasWei?: string;
};

// Issue #27 (c): swap a market-priced registry stable against USDC on the stableswap pool that
// quotes it. Without it a depeg is something an agent can only watch: the registry knows what DAI is
// worth, and nothing lets anyone act on it. The same argument #39 made for liquitySwapEusd -- a
// venue whose α cannot be reached is not a venue.
export type StableSwapAction = {
  type: "stableSwap";
  // The market-priced stable. USDC is the other leg, always: it is the numéraire.
  stable: TokenSymbol;
  // Which side is being spent -- the stable, or the USDC buying it.
  tokenIn: TokenSymbol;
  amountIn: string;
  slippageBps?: number;
  maxPriorityFeePerGasWei?: string;
};

// Aave v3
export type AaveSupplyAction = {
  type: "aaveSupply";
  asset: TokenSymbol;
  amount: string;
  maxPriorityFeePerGasWei?: string;
};
export type AaveWithdrawAction = {
  type: "aaveWithdraw";
  asset: TokenSymbol;
  amount: string; // decimal integer or "max"
  maxPriorityFeePerGasWei?: string;
};
export type AaveBorrowAction = {
  type: "aaveBorrow";
  asset: TokenSymbol;
  amount: string;
  maxPriorityFeePerGasWei?: string;
};
export type AaveRepayAction = {
  type: "aaveRepay";
  asset: TokenSymbol;
  amount: string; // decimal integer or "max"
  maxPriorityFeePerGasWei?: string;
};

// GMX v2 (perp. Cannot be bundled because keeper execution is required; single only)
export type GmxIncreaseAction = {
  type: "gmxIncrease";
  isLong: boolean;
  base?: TokenSymbol; // ADR 0013: the index market's base (default WETH = ETH/USD)
  collateral: TokenSymbol;
  collateralAmount: string; // token units
  sizeDeltaUsd: string; // GMX 1e30-scale USD
  acceptablePrice?: string; // GMX 1e(30-decimals) scale. LOOSE when omitted
  maxPriorityFeePerGasWei?: string;
};
export type GmxDecreaseAction = {
  type: "gmxDecrease";
  isLong: boolean;
  base?: TokenSymbol; // ADR 0013: the index market's base (default WETH = ETH/USD)
  collateral: TokenSymbol;
  collateralDeltaAmount: string; // collateral to withdraw (token units). 0 allowed
  sizeDeltaUsd: string; // GMX 1e30-scale USD
  acceptablePrice?: string;
  maxPriorityFeePerGasWei?: string;
};

// LST venue (issue #38). The market is LST/WETH -- adapter-private, not a base/USDC market -- so
// these actions carry no `base` selector.
export type LstDepositAction = {
  type: "lstDeposit";
  // WETH to stake, in wei. Mints LST at the current redemption rate.
  amountWethWei: string;
  maxPriorityFeePerGasWei?: string;
};

export type LstSwapAction = {
  type: "lstSwap";
  // "WETH" buys LST from the secondary market; "LST" sells into it (the instant, discounted exit).
  tokenIn: "WETH" | "LST";
  amountIn: string; // wei of tokenIn (both are 18-decimal)
  slippageBps?: number;
  maxPriorityFeePerGasWei?: string;
};

export type LstRequestWithdrawAction = {
  type: "lstRequestWithdraw";
  // LST shares to queue for redemption at par. Claimable after the queue delay.
  amountLstWei: string;
  maxPriorityFeePerGasWei?: string;
};

export type LstClaimWithdrawAction = {
  type: "lstClaimWithdraw";
  // A specific request id, or omitted / "all" to claim every finalized request.
  requestId?: string;
  maxPriorityFeePerGasWei?: string;
};

// Liquity venue (issue #39): a CDP stablecoin, eUSD.
//
// Collateral is native ETH, because that is what the forked core takes (`msg.value`). Every
// collateral amount here is still denominated in WETH wei and the adapter unwraps first, so an agent
// never has to think about which of the two it holds -- except for gas, which native ETH also pays:
// sinking the whole balance into a Trove strands the agent with no way to send the next transaction.
export type LiquityOpenTroveAction = {
  type: "liquityOpenTrove";
  // WETH to unwrap and post as collateral.
  collateralWethWei: string;
  // eUSD to draw. The Trove's booked debt is this plus the borrowing fee plus the 200 eUSD gas
  // compensation, and the sum must clear MIN_NET_DEBT (1,800).
  debtEusdWei: string;
  // Slippage bound on the borrowing fee, which moves with baseRate. Default 500 (5%).
  maxFeeBps?: number;
  maxPriorityFeePerGasWei?: string;
};

export type LiquityAdjustTroveAction = {
  type: "liquityAdjustTrove";
  // Exactly one side of each pair. Adding collateral unwraps WETH; withdrawing returns native ETH.
  addCollateralWethWei?: string;
  withdrawCollateralWei?: string;
  debtChangeEusdWei?: string;
  // Whether debtChangeEusdWei is drawn (true) or repaid (false). Required when there is a change.
  isDebtIncrease?: boolean;
  maxFeeBps?: number;
  maxPriorityFeePerGasWei?: string;
};

export type LiquityCloseTroveAction = {
  type: "liquityCloseTrove";
  maxPriorityFeePerGasWei?: string;
};

// Buy eUSD below par and exchange it for collateral at the oracle price: the venue's clearest α.
// The adapter computes the HintHelpers hints and truncates the amount to what the sorted list can
// actually absorb -- an unhinted redemption walks the list on-chain and is prohibitively expensive.
export type LiquityRedeemAction = {
  type: "liquityRedeem";
  amountEusdWei: string;
  // Cap on how many Troves the redemption walks. 0 (default) means no cap.
  maxIterations?: number;
  // Slippage bound on the redemption fee, which rises with every redemption in the run. Default 500.
  maxFeeBps?: number;
  maxPriorityFeePerGasWei?: string;
};

export type LiquityProvideToSpAction = {
  type: "liquityProvideToSP";
  amountEusdWei: string;
  maxPriorityFeePerGasWei?: string;
};

export type LiquityWithdrawFromSpAction = {
  type: "liquityWithdrawFromSP";
  // Decimal wei, or "max". "0" is legal and claims the accrued ETH gain without touching the deposit.
  amountEusdWei: string;
  maxPriorityFeePerGasWei?: string;
};

export type LiquityLiquidateAction = {
  type: "liquityLiquidate";
  // Specific Troves to liquidate. Omit to sweep the riskiest `maxTroves` instead.
  borrowers?: string[];
  maxTroves?: number;
  maxPriorityFeePerGasWei?: string;
};

// The eUSD/USDC market. Not one of the seven actions issue #39 lists, but the venue's own α --
// buying a depegged eUSD to redeem it -- is unreachable without it, and the alternative is every
// agent hand-rolling a rawTx against the pool.
export type LiquitySwapEusdAction = {
  type: "liquitySwapEusd";
  // "USDC" buys eUSD from the pool; "EUSD" sells into it.
  tokenIn: "USDC" | "EUSD";
  amountIn: string; // units of tokenIn (USDC is 6-decimal, eUSD is 18)
  slippageBps?: number;
  maxPriorityFeePerGasWei?: string;
};

// ---------------------------------------------------------------------------
// Agent-created markets (issue #40)
//
// Every address here is a raw hex address rather than a registry symbol: the whole point is that
// these venues trade tokens the environment never deployed and cannot name.
// ---------------------------------------------------------------------------

// Create a Uniswap V3 pool through the environment's factory and initialize its price. The pool is
// `verified` in the registry — its implementation is the factory's, which the environment deployed —
// but its *contents* are whatever the creator seeds, so "verified" says nothing about whether the
// price is fair. Liquidity comes afterwards, from `mintLiquidity`.
export type CreatePoolAction = {
  type: "createPool";
  tokenA: string;
  tokenB: string;
  // Uniswap V3 fee in pips (500 / 3000 / 10000).
  fee: number;
  // Initial price as sqrt(token1/token0) * 2^96. The adapter sorts the pair, so compute this against
  // the sorted order (the lower address is token0).
  sqrtPriceX96: string;
  maxPriorityFeePerGasWei?: string;
};

// Open a market on the permissionless lending singleton. Anyone can call it and no parameter is
// vetted: a self-owned oracle and a 99% LLTV are both legal, and reading them is the counterparty's
// job (issue #40 T4).
export type CreateLendingMarketAction = {
  type: "createLendingMarket";
  loanToken: string;
  collateralToken: string;
  // Any address implementing `price()`. `ConfigurableOracle` has an owner who can move it;
  // `PriceFeedOracle` cannot be moved at all.
  oracle: string;
  // Any address implementing `borrowRatePerSecond`. The zero address means no interest.
  irm: string;
  // Loan-to-value at which a position becomes liquidatable, in WAD (0.9e18 = 90%). Must be < 1e18.
  lltv: string;
  maxPriorityFeePerGasWei?: string;
};

// The market a lending action acts on, by the id `createMarket` emitted. The adapter reads the
// parameters back off the singleton, so an agent never has to keep the tuple in sync.
type LendingActionBase = {
  marketId: string;
  maxPriorityFeePerGasWei?: string;
};

export type LendingSupplyAction = LendingActionBase & {
  type: "lendingSupply";
  // Loan-token units.
  amount: string;
};

export type LendingWithdrawAction = LendingActionBase & {
  type: "lendingWithdraw";
  // Loan-token units, or "max" for the whole supply position. Under the round-trip rule this is the
  // action that decides whether a position was worth anything: what is still inside at the epoch's
  // final block is worth zero.
  amount: string;
};

export type LendingSupplyCollateralAction = LendingActionBase & {
  type: "lendingSupplyCollateral";
  amount: string;
};

export type LendingWithdrawCollateralAction = LendingActionBase & {
  type: "lendingWithdrawCollateral";
  amount: string;
};

export type LendingBorrowAction = LendingActionBase & {
  type: "lendingBorrow";
  amount: string;
};

export type LendingRepayAction = LendingActionBase & {
  type: "lendingRepay";
  // Loan-token units, or "max" to clear the debt.
  amount: string;
};

export type LendingLiquidateAction = LendingActionBase & {
  type: "lendingLiquidate";
  borrower: string;
  // Collateral units to seize. The debt repaid follows from the market's oracle price and its
  // liquidation incentive — both of which the market's creator chose.
  seizedAssets: string;
};

// Bundleable leaves (excluding GMX)
export type BundleActionItem =
  | SwapAction
  | MintLiquidityAction
  | RemoveLiquidityAction
  | CollectFeesAction
  | BalancerSwapAction
  | CurveSwapAction
  | StableSwapAction
  | AaveSupplyAction
  | AaveWithdrawAction
  | AaveBorrowAction
  | AaveRepayAction
  | LstDepositAction
  | LstSwapAction
  | LstRequestWithdrawAction
  | LstClaimWithdrawAction
  | LiquityOpenTroveAction
  | LiquityAdjustTroveAction
  | LiquityCloseTroveAction
  | LiquityRedeemAction
  | LiquityProvideToSpAction
  | LiquityWithdrawFromSpAction
  | LiquityLiquidateAction
  | LiquitySwapEusdAction
  | CreatePoolAction
  | CreateLendingMarketAction
  | LendingSupplyAction
  | LendingWithdrawAction
  | LendingSupplyCollateralAction
  | LendingWithdrawCollateralAction
  | LendingBorrowAction
  | LendingRepayAction
  | LendingLiquidateAction;

// All leaf actions (including GMX. The unit of intent / buildTxs)
export type LeafAction =
  BundleActionItem | GmxIncreaseAction | GmxDecreaseAction;

export type RawTx = {
  // Omitted is a contract deployment (issue #40 T5): `data` is then the creation bytecode. The
  // runtime sends it like any other transaction, so the deploy shares the nonce manager, the
  // per-block transaction cap and the gas budget with the agent's trades.
  to?: string;
  data: string;
  value?: string;
};

export type RawTxAction = {
  type: "rawTx";
  tx: RawTx;
  maxPriorityFeePerGasWei?: string;
};

export type RawBundleAction = {
  type: "rawBundle";
  txs: RawTx[];
  maxPriorityFeePerGasWei?: string;
};

export type AgentAction =
  | { type: "noop"; reason?: string }
  | LeafAction
  | {
      type: "bundle";
      actions: BundleActionItem[];
      maxPriorityFeePerGasWei?: string;
    }
  | RawTxAction
  | RawBundleAction;

// ---------------------------------------------------------------------------
// Observation schema (protocol-namespaced)
// ---------------------------------------------------------------------------

export type LpPositionObservation = {
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  // The naming stays WETH/USDC-compatible. For a WBTC-market position, base=WBTC amount and quote=USDC amount go here.
  tokensOwedWethWei: string;
  tokensOwedUsdcUnits: string;
  // Issue #21: fees earned since the position's last checkpoint. They live in the pool until
  // poke/collect writes them into tokensOwed, but are already included in valueUsdc.
  uncollectedFeesWethWei: string;
  uncollectedFeesUsdcUnits: string;
  amountWethWei: string;
  amountUsdcUnits: string;
  valueUsdc: number;
  // ADR 0013: non-WETH markets ("WBTC/USDC" etc.). Unset means WETH/USDC.
  market?: string;
};

// In-range depth (uint128, decimal string). It decides how much of a price gap a given notional can
// actually take, and the liquidityPull stress event (issue #52) moves it mid-run, so an agent that
// sizes against block-0 depth will be wrong exactly when the crash window is open. Optional because
// a pool whose depth could not be read reports no depth rather than "zero depth".
export type UniswapMarketObservation = {
  pair: string;
  fee: number;
  priceUsdcPerWeth: number; // base/USD (naming stays WETH-compatible; the value is that base's price)
  tick: number;
  tickSpacing: number;
  liquidity?: string;
};

export type UniswapObservation = {
  pool: {
    pair: "WETH/USDC";
    fee: number;
    priceUsdcPerWeth: number;
    tick: number;
    tickSpacing: number;
    liquidity?: string;
  };
  positions: LpPositionObservation[];
  // ADR 0013: non-WETH markets (WBTC/USDC etc.). The WETH market stays on pool/positions.
  markets?: Record<string, UniswapMarketObservation>;
};

// Two-sided executable quote fields (balancer/curve). When set, priceUsdcPerWeth is the executable
// mid = sqrt(sell*buy) from probing both directions, not the one-sided fee-inclusive sell quote.
// A one-sided probe diverges from the executable mid when reserves are imbalanced (twocrypto's
// dynamic fee widened the real bid-ask to ~128bps while a flat 30bps correction saw a phantom
// cross-venue spread — the root cause of the WBTC all-agent bleed), so the effective per-side
// cost is measured on-chain and carried in the observation.
export type TwoSidedQuoteFields = {
  // Executable base->quote price for a small probe (fee/impact included).
  sellPriceUsdcPerWeth?: number;
  // Executable quote->base price for the same notional (fee/impact included).
  buyPriceUsdcPerWeth?: number;
  // Effective per-side cost vs mid in bps (= sqrt(buy/sell)-1). Round-trip cost = 2x this.
  effectiveHalfSpreadBps?: number;
};

export type AmmObservation = TwoSidedQuoteFields & {
  priceUsdcPerWeth: number;
  reserves?: { weth: string; usdc: string };
  // ADR 0013: non-WETH markets (priceUsdcPerWeth is that base/USD).
  markets?: Record<
    string,
    TwoSidedQuoteFields & {
      priceUsdcPerWeth: number;
      reserves?: { weth: string; usdc: string };
    }
  >;
};

export type GmxPositionObservation = {
  isLong: boolean;
  sizeUsd: string;
  sizeInTokens: string;
  collateral: TokenSymbol;
  collateralAmount: string;
  entryPriceUsd: number;
  pnlUsd: number;
};

export type GmxObservation = {
  marketPriceUsd: number;
  position?: GmxPositionObservation;
  // ADR 0013: non-WETH index markets (BTC/USD etc.).
  markets?: Record<
    string,
    { marketPriceUsd: number; position?: GmxPositionObservation }
  >;
};

export type AaveObservation = {
  healthFactor: string;
  totalCollateralBase: string;
  totalDebtBase: string;
  availableBorrowsBase: string;
  supplied: Partial<Record<TokenSymbol, string>>;
  borrowed: Partial<Record<TokenSymbol, string>>;
  poolLiquidity?: Partial<Record<TokenSymbol, string>>;
};

// A queued redemption. The shares are already burnt; what is left is a par claim on WETH that
// lands at `claimableAtBlock`.
export type LstWithdrawalObservation = {
  requestId: string;
  assetsWethWei: string;
  claimableAtBlock: string;
  claimable: boolean;
};

// LST venue (issue #38).
//
// The whole point of the venue is that an LST has two prices, and they are reported separately:
//   - redemptionRateWeth: what the vault owes per share. Reachable only through the queue.
//   - marketPriceWeth:    what the pool pays per share right now, fee and impact included.
// discountBps is how far the second sits below the first -- positive means the market is cheap, so
// buying and queueing a redemption earns the discount in exchange for waiting.
export type LstObservation = {
  // WETH per 1e18 LST, from the vault (`stEthPerToken`).
  redemptionRateWeth: number;
  // Executable mid at probe size = sqrt(sell x buy), which cancels the pool's symmetric fee.
  marketPriceWeth: number;
  // Executable WETH received per LST sold into the pool (fee/impact included) -- the instant exit.
  marketSellPriceWeth?: number;
  // Executable WETH paid per LST bought from the pool.
  marketBuyPriceWeth?: number;
  // (redemptionRate - marketPrice) / redemptionRate, in bps. Positive = the market is discounted.
  // Zero when the pool did not quote -- check marketQuoted before acting on it.
  discountBps: number;
  // False means the pool refused to quote (reverted, or no liquidity at probe size). There is no
  // instant exit and no carry to take; it is not a 100% discount.
  marketQuoted?: boolean;
  // The APY the vault is currently paying on its compressed economic clock (the run's clock, not
  // wall-clock: one block advances lst.simulatedSecondsPerBlock seconds of staking).
  apyBps: number;
  // Yield per block as a fraction, so an agent can compare "wait N blocks" against a discount
  // without re-deriving it from the APY.
  yieldPerBlockBps: number;
  // Floor on the wait between requesting a redemption and being able to claim it.
  withdrawalDelayBlocks: number;
  // What the wait would *actually* be if you queued your whole share balance right now: the floor
  // plus whatever is already queued ahead of you plus your own size draining (issue #38 phase 2).
  // Equal to withdrawalDelayBlocks when the queue is not rate-limited. This, not the floor, is the
  // number to compare against blocksRemaining.
  estimatedQueueDelayBlocks: number;
  // The wait for a one-WETH redemption, i.e. the queue's congestion with your own size taken out.
  // Lets an agent see that the queue is busy even when it holds nothing yet.
  queueDelayPerWethBlocks?: number;
  // WETH the queue finalizes per block ("0" = no limit). With it you can size a redemption to what
  // will actually finalize in the blocks you have left, instead of queueing all of it and finding
  // out none of it lands.
  queueThroughputWeiPerBlock?: string;
  // Unclaimed requests across the whole vault (the queue's length).
  queueLength: number;
  // Remaining pre-funded rewards, in wei. Zero means yield has stopped accruing.
  rewardReserveWei: string;
  // Your position.
  lstBalanceWei: string;
  // What your shares redeem for through the queue, at the current rate.
  lstRedemptionValueWethWei: string;
  // What selling your whole share balance into the pool would fetch right now, fee and impact
  // included -- the instant exit, quoted at your actual size rather than at probe size.
  instantExitWethWei: string;
  // Your queued redemptions.
  pendingWithdrawals: LstWithdrawalObservation[];
  pendingWithdrawalWethWei: string;
  claimableWithdrawalWethWei: string;
  // Pool depth, so an agent can size an exit against it.
  poolReserves?: { weth: string; lst: string };
  // Issue #38 phase 3: whether the LST is listed as Aave collateral, which is what makes leveraged
  // staking possible (supply LST, borrow WETH, stake again). Absent or false means the deploy had
  // no Aave to list it on, and `aaveSupply` with asset "LST" will be rejected.
  aaveCollateral?: boolean;
};

// Your Trove, and where it sits in the queue a redemption walks (issue #39).
export type LiquityTroveObservation = {
  // Liquity's own status enum: 1 = active, 3 = closed by liquidation, 4 = closed by redemption.
  status: number;
  collWei: string;
  // Everything the system books against you, including pending redistribution and the 200 eUSD gas
  // compensation. This is the number ICR is computed from.
  debtEusdWei: string;
  // What you would actually have to repay to close: debt minus the gas compensation the GasPool
  // holds on your behalf. Valuing a Trove against the gross debt understates it by 200 eUSD.
  netDebtEusdWei: string;
  // Individual collateral ratio, as a plain ratio (1.1 = 110% = MCR).
  icr: number;
  // The collateral price at which ICR falls to MCR -- i.e. how far the market has to move before
  // this Trove is liquidatable. Zero when there is no debt.
  liquidationPriceUsd: number;
  // Redemptions start at the riskiest Trove and walk up. 0 means yours is next.
  positionFromRiskiest: number;
  // Net debt of every Trove ahead of you in that walk: the redemption volume the system can absorb
  // before it reaches you. This, not ICR alone, is what "am I about to be redeemed against" means.
  redeemedAheadEusdWei: string;
  // Whether the walk above could be resolved. False when the list is larger than the observation
  // scans, in which case positionFromRiskiest and redeemedAheadEusdWei are not meaningful.
  positionKnown: boolean;
};

// Liquity V1 as the CDP stablecoin venue (issue #39).
//
// Four things move at once here and the observation reports them separately, because trading the
// venue means playing them against each other:
//   - the system's TCR and Recovery Mode, which move *everyone's* liquidation risk at the same time
//   - your own ICR and your position in the sorted list, which is what being redeemed against means
//   - the two fee curves, which rise with use and decay on a ~12h half-life (so within a run they
//     effectively only rise: the first large redemption prices the ones after it)
//   - the market price of eUSD against the $1 the protocol will always redeem it for
export type LiquityObservation = {
  // The collateral price Liquity itself marks against, from the environment's PriceFeed via the
  // oracle adapter. Equal to the run's fair price, one block stale like every other oracle here.
  priceUsd: number;
  // System total collateral ratio, as a plain ratio. Below CCR the system enters Recovery Mode.
  tcr: number;
  // In Recovery Mode the liquidation threshold stops being MCR: a Trove is liquidatable once its
  // ICR is under the *current TCR* (which is itself under CCR while this lasts), and only if the
  // Stability Pool can absorb its whole debt. The seizure is capped at 110% of the debt, so a
  // borrower over that keeps the rest as a claimable surplus. Borrowing is
  // restricted. It is the venue's reflexive failure mode and it applies to everyone at once.
  recoveryMode: boolean;
  mcr: number; // 1.1
  ccr: number; // 1.5
  troveCount: number;
  totalCollWei: string;
  totalDebtEusdWei: string;
  // Fee on newly drawn debt, in bps (floor 50, rises with baseRate).
  borrowingRateBps: number;
  // Fee taken out of the ETH a redemption pays, in bps (floor 50). Subtract it from the discount
  // below to see whether redeeming is actually profitable.
  redemptionRateBps: number;
  baseRateBps: number;
  // Floor on a Trove's net debt (1,800 eUSD) and the gas compensation added on top (200 eUSD).
  minNetDebtEusdWei: string;
  gasCompensationEusdWei: string;
  // --- the eUSD market, against the $1 the protocol redeems at ---
  eusdBalanceWei: string;
  // Executable mid at probe size, in USDC per eUSD. 1.0 is par.
  marketPriceUsdc: number;
  marketSellPriceUsdc?: number;
  marketBuyPriceUsdc?: number;
  // False means the pool refused to quote (no market, or no liquidity at probe size). discountBps
  // is then 0 rather than a fictitious 10000, so check this before acting on it.
  marketQuoted: boolean;
  // (1 - marketPrice) x 10000. Positive means eUSD trades below par: buying it and redeeming
  // against the riskiest Trove converts the discount into collateral.
  discountBps: number;
  // discountBps minus redemptionRateBps: the edge a redemption actually captures before impact and
  // gas. Negative means the fee eats the dislocation and the right move is to wait.
  redemptionEdgeBps: number;
  poolReserves?: { eusd: string; usdc: string };
  // --- your Trove ---
  trove?: LiquityTroveObservation;
  // The Trove a redemption would hit first, and its ICR: the one worth redeeming against, and the
  // one worth liquidating if the price keeps falling.
  riskiestTrove?: { owner: string; icr: number; netDebtEusdWei: string };
  // --- your Stability Pool position ---
  spDepositEusdWei: string;
  // ETH already earned from absorbed liquidations, claimable by withdrawing (any amount, including 0).
  spEthGainWei: string;
  spLqtyGainWei: string;
  spTotalDepositsEusdWei: string;
  // Your share of the pool in bps, which is your share of the next liquidation's collateral.
  spShareBps: number;
  // --- gas headroom ---
  // Collateral is native ETH, so a Trove is funded out of the same balance that pays for gas.
  ethBalanceWei: string;
  // What to keep back for the rest of the run. Posting past this strands the agent: it can no longer
  // send the transaction that would close the position. Self-stranding is a legitimate loss, not a
  // bug, so the number is surfaced rather than enforced.
  suggestedGasReserveWei: string;
};

// ---------------------------------------------------------------------------
// Agent-created markets: registry + lending observations (issue #40 T3)
// ---------------------------------------------------------------------------

export type RegistryKind =
  | "unknown"
  | "uniswapV3Pool"
  | "balancerWeightedPool"
  | "curvePlainPool"
  | "curveTwocryptoPool"
  | "lendingMarket"
  | "erc20";

// One thing the environment saw appear. `verified` means only "this came out of a factory whose
// implementation the environment deployed"; it is not a safety claim, and losing money to an
// unverified contract is a legitimate loss that is not made whole.
export type RegistryEntryObservation = {
  market: string;
  kind: RegistryKind;
  creator: string;
  // True when this agent is the creator. It gets a one-block head start on its own contract, which
  // is the registry's distribution lag rather than a privilege.
  mine: boolean;
  token0?: string;
  token1?: string;
  // Lending markets: the price source, and the first parameter a verifier reads.
  oracle?: string;
  // Who can move that price. `0x0000…0000` means nobody — the oracle renounced ownership or never
  // had an owner. Undefined means the address does not answer `owner()`, which is *not* the same as
  // "nobody owns it": it may own itself through code you have not read.
  oracleOwner?: string;
  // keccak256 of the runtime code at the block the entry was registered.
  codehashAtRegistration: string;
  // keccak256 of the runtime code right now. A difference means the implementation moved between
  // registration and this block — the classic proxy rug. The environment does not police it: under
  // the round-trip rule a swapped-out proxy is just another way of not getting out, so noticing it
  // is a skill difference.
  codehashNow?: string;
  verified: boolean;
  registeredAtBlock: string;
  // The lending marketId / Balancer poolId, when the kind has one.
  extra?: string;
};

// A token this agent has moved into a registry entry the environment cannot value, netted against
// what came back. **This is the number the round-trip rule scores at zero**: profit taken *through*
// an unknown contract counts in full, but what is still inside when the epoch ends is worth nothing.
export type StrandedHoldingObservation = {
  market: string;
  token: string;
  symbol?: string;
  // Net units sent in minus units received back, floored at zero and capped by what the contract
  // still holds of that token. The cap matters: a contract that pulled tokens and forwarded them on
  // holds none of them, and the loss (which the spot balance already records) did not stay here.
  //
  // In the observation this is an **upper bound**: an agent can see its own flows and the
  // contract's balance, but not what other agents put into the same contract, so a balance several
  // agents have a claim on reads as if it were all yours. The scorer's report splits it pro rata,
  // because it can see everybody.
  amountRaw: string;
};

export type RegistryObservation = {
  address: string;
  entries: RegistryEntryObservation[];
  // Outstanding ERC-20 allowances this agent has granted to registry entries. A contract that drains
  // through an unlimited `approve` is in scope: approvals are the victim's problem, and an agent
  // that approved MaxUint256 to an unknown contract has made a decision.
  allowances: Array<{
    spender: string;
    token: string;
    symbol?: string;
    amount: string;
    unlimited: boolean;
  }>;
  strandedUnknown: StrandedHoldingObservation[];
  // Registry entries that exist and are not in `entries`. Deployment is permissionless, so the count
  // is somebody's choice; one observation carries a bounded, newest-first slice of it, and the
  // number dropped is reported rather than left to be inferred from a list that looks complete.
  dropped: number;
};

// Your side of one market on the permissionless lending singleton (issue #40 T4).
export type LendingPositionObservation = {
  marketId: string;
  loanToken: string;
  collateralToken: string;
  oracle: string;
  // Zero address = nobody can move the price. Undefined = the oracle does not answer `owner()`.
  oracleOwner?: string;
  irm: string;
  // Liquidation LTV in WAD. High is leverage, and leverage is one of the two baits that work at a
  // 12-minute epoch (the other is the liquidation incentive).
  lltv: string;
  liquidationIncentiveFactor: string;
  // Collateral units per loan-token unit, 1e36-scaled and decimal-adjusted, as the market's own
  // oracle reports it. If the creator owns the oracle, this number is whatever they want it to be.
  price: string;
  supplyAssets: string;
  borrowAssets: string;
  collateral: string;
  healthy: boolean;
  // Market-wide totals, so a supplier can see whether the loan token is actually there to withdraw.
  totalSupplyAssets: string;
  totalBorrowAssets: string;
};

export type LendingObservation = {
  singleton: string;
  markets: LendingPositionObservation[];
  // Markets that exist and are not in `markets`. `createMarket` is permissionless, so the count is
  // whatever somebody chose to open; one read carries a bounded slice of it, and the number dropped
  // is reported rather than left to be inferred from a list that looks complete.
  dropped: number;
};

export type ProtocolObservations = {
  uniswap?: UniswapObservation;
  balancer?: AmmObservation;
  curve?: AmmObservation;
  gmx?: GmxObservation;
  aave?: AaveObservation;
  lst?: LstObservation;
  liquity?: LiquityObservation;
  lending?: LendingObservation;
};

export type AgentObservation = {
  kind: "observation";
  runId: string;
  round: number;
  blockNumber: string;
  agentAddress: string;
  fairPriceUsdcPerWeth: number;
  oraclePrices: { wethUsd: number; usdcUsd: number };
  // ADR 0013: multi-asset. The WETH market stays on the existing fields above; additional bases go here.
  // Existing strategies work even without referencing it (backward compatible). Only strategies that look at WBTC reference it.
  fairPricesUsd?: Record<TokenSymbol, number>;
  baseBalances?: Record<TokenSymbol, string>;
  // ADR 0013: base symbol -> decimals (WETH=18 / WBTC=8). Used by a process-separated agent to
  // unit-convert base amounts (agents cannot call tokenInfo, so it is passed via the observation).
  baseDecimals?: Record<TokenSymbol, number>;
  markets?: string[];
  // Blocks left before the run ends, counted from the first block this agent observed (undefined
  // when the run has no block limit). An exit that takes longer than this cannot complete inside
  // the run, which is exactly what makes the LST withdrawal queue a decision rather than a
  // formality (issue #38). Approximate by a block or two: an agent starts observing right around
  // the first competition block, not before it.
  blocksRemaining?: number;
  enabledProtocols: ProtocolId[];
  balances: {
    ethWei: string;
    wethWei: string;
    // Native USDC only, since issue #27. It is a *budget*, not a valuation: the summed figure it
    // replaced could not be spent anywhere, because USDT is not accepted in a USDC pool. What the
    // wallet is worth is inventory.valueUsdc.
    usdcUnits: string;
    // Every stable the run holds, kept apart instead of summed (issue #27 (a) step 1). Keyed by
    // registry symbol, or by raw address for the fork's USDC.e / USD₮0 which the registry does not
    // name. This is where an agent sizes a specific venue's stable leg from -- and where it reads
    // that a stablecoin is no longer trading at a dollar.
    stables?: Record<
      string,
      {
        token: string;
        decimals: number;
        // Raw balance, in the token's own units.
        balance: string;
        // USDC per unit. 1 for USDC (the numéraire, $1 by definition) and for any stable with no
        // market to quote it.
        priceUsdc: number;
        // False means priceUsdc is par by convention or by fallback, not an observation of a
        // market. A stable that is *meant* to be a dollar and has no market saying otherwise reads
        // the same as one whose market went quiet -- so do not read `1` as "the peg is holding".
        marketQuoted: boolean;
      }
    >;
  };
  inventory: {
    valueUsdc: number;
    weth: number;
    usdc: number;
    eth: number;
  };
  history: Array<{
    round: number;
    poolPriceUsdcPerWeth: number;
    fairPriceUsdcPerWeth: number;
  }>;
  // What the runtime still decides for you. Order size is *not* in here: the competition has no
  // per-order cap on any venue, so the only bound on a trade is the wallet's balance and the depth
  // the venue is willing to give up. An agent that wants to be sized has to size itself.
  //
  // Everything that used to live here -- maxWethInWei / maxUsdcInUnits / maxLpWethWei /
  // maxLpUsdcUnits / maxGmxSizeUsd / maxAaveSupplyWethWei / maxAaveBorrowUsdcUnits /
  // maxLstDepositWethWei / baseLimits, plus the maxBundleActions and maxOpenPositions counts -- was
  // removed rather than raised. Raising a cap leaves it as a number every strategy reads as its
  // budget (the reference field sized itself off these values in 19 files), and a budget handed out
  // by the environment is not a decision the agent made.
  limits: {
    defaultPriorityFeePerGasWei: string;
    maxPriorityFeePerGasWei: string;
    defaultSlippageBps: number;
  };
  protocols: ProtocolObservations;
  // What other agents have deployed, as the environment discovered it (issue #40 T3). Absent when
  // the run has no registry. Rule agents can read the registry contract or the chain directly; this
  // is what everything else sees, and it is one block behind for everyone — except the creator of an
  // entry, who knew about their own contract before it was published.
  registry?: RegistryObservation;
  // Competition signals (ADR 0011. Observations that make the priority-fee auction skill-based under
  // economicGas). In direct mode the agent self-derives them from the most recent block (not an env
  // privilege, but the same as a real MEV searcher watching recent blocks). undefined in relay mode or early in observation.
  competition?: {
    // Highest priority fee from "others" observed in the most recent block (wei, decimal string).
    // Slightly exceeding it is the rough threshold to win ordering. 0 = there were no competitor bid txs.
    maxCompetitorPriorityFeeWei: string;
    // Highest priority fee across the whole most recent block (including yourself) (wei).
    maxBlockPriorityFeeWei: string;
    // The txIndex of your most recent included tx (0=first is ideal. null=nothing included recently).
    lastTxIndex: number | null;
    // Revert rate of recent included txs (fraction that failed due to being front-run/slippage, 0..1). High = a sign of losing the bid.
    recentRevertRate: number;
    // Denominator of the revert rate (number of recent included txs).
    recentSampleSize: number;
  };
};

export type AgentSpec = {
  id: string;
  // ADR 0015 §6: the actual directory name (defaults to id). Used when running multiple instances of
  // the same strategy under a different id + different env (e.g. clean-arb-wide → dir: clean-arb).
  dir?: string;
  // ADR 0015 §6: when omitted, resolved by the directory convention (runtime/bot.ts drives
  // <agentsDir>/<dir ?? id>/). Explicit command/args override for a fully self-contained agent (other languages, etc.).
  command?: string;
  args?: string[];
  // Which key the environment signs for this agent with. Required unless `address` is given: an
  // external participant who holds their own key is registered by address instead (ADR 0021 §2).
  wallet?: string;
  description?: string;
  env?: Record<string, string>;
  // A yardstick for discrimination. If true, it is a baseline such as noop/random.
  baseline?: boolean;
  // ADR 0021 §2: a registered participant who runs the agent on their own machine. The environment
  // funds it, attributes its txs, scores it and rule-checks it exactly as before -- all of which are
  // address-based already -- but never starts a process for it. Its decision log lives on the
  // participant's disk and never reaches the coordinator, which is the point (§4 / axis C2).
  external?: boolean;
  // The participant's own address, for an external entry whose key the environment does not hold.
  // This is the safer registration: a key the operator generated is a key the operator has. The
  // alternative -- `wallet`, with the environment deriving and handing over a key -- stays available
  // because a practice devnet issuing funded keys is a legitimate way to run one.
  address?: string;
};

export type AgentsFile = {
  agents: AgentSpec[];
};

export type WalletRole =
  "agent" | "uninformed-flow" | "informed-flow" | "setup" | "admin" | "keeper";

export type SimWallet = {
  id: string;
  role: WalletRole;
  privateKey: Hex;
};

export type TxIntent = {
  ownerId: string;
  role: WalletRole;
  privateKey: Hex;
  protocol: ProtocolId;
  action: LeafAction;
  priorityFeeWei: bigint;
  bundleId?: string;
  bundleIndex?: number;
  gmxOrder?: boolean;
};

export type RawTxIntent = {
  ownerId: string;
  role: WalletRole;
  privateKey: Hex;
  rawTx: RawTx;
  priorityFeeWei: bigint;
  bundleId?: string;
  bundleIndex?: number;
};

export type BalanceSnapshot = {
  ethWei: bigint;
  wethWei: bigint;
  // Native USDC only, since issue #27. A spending budget, not a valuation: it used to be every
  // active stable summed, which could not be spent anywhere. The per-stable breakdown is `stables`,
  // and what the wallet is worth comes from pnl.ts valueUsdc over that.
  usdcUnits: bigint;
  // ADR 0013: base symbol -> balance (WETH/WBTC etc.). wethWei equals bases["WETH"] for compatibility.
  bases?: Record<string, bigint>;
  // stable token address (lowercase) -> balance. Validation checks each venue's stable individually via this map.
  stables?: Record<string, bigint>;
};
