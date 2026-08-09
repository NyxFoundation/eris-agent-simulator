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
  "uniswap" | "balancer" | "curve" | "gmx" | "aave" | "lst";

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

// Bundleable leaves (excluding GMX)
export type BundleActionItem =
  | SwapAction
  | MintLiquidityAction
  | RemoveLiquidityAction
  | CollectFeesAction
  | BalancerSwapAction
  | CurveSwapAction
  | AaveSupplyAction
  | AaveWithdrawAction
  | AaveBorrowAction
  | AaveRepayAction
  | LstDepositAction
  | LstSwapAction
  | LstRequestWithdrawAction
  | LstClaimWithdrawAction;

// All leaf actions (including GMX. The unit of intent / buildTxs)
export type LeafAction =
  BundleActionItem | GmxIncreaseAction | GmxDecreaseAction;

export type RawTx = {
  to: string;
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

export type UniswapMarketObservation = {
  pair: string;
  fee: number;
  priceUsdcPerWeth: number; // base/USD (naming stays WETH-compatible; the value is that base's price)
  tick: number;
  tickSpacing: number;
};

export type UniswapObservation = {
  pool: {
    pair: "WETH/USDC";
    fee: number;
    priceUsdcPerWeth: number;
    tick: number;
    tickSpacing: number;
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
  discountBps: number;
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

export type ProtocolObservations = {
  uniswap?: UniswapObservation;
  balancer?: AmmObservation;
  curve?: AmmObservation;
  gmx?: GmxObservation;
  aave?: AaveObservation;
  lst?: LstObservation;
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
    usdcUnits: string;
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
  limits: {
    maxWethInWei: string;
    maxUsdcInUnits: string;
    defaultPriorityFeePerGasWei: string;
    maxPriorityFeePerGasWei: string;
    defaultSlippageBps: number;
    maxBundleActions: number;
    maxLpWethWei: string;
    maxLpUsdcUnits: string;
    maxOpenPositions: number;
    maxGmxSizeUsd: string;
    maxAaveSupplyWethWei: string;
    maxAaveBorrowUsdcUnits: string;
    // Issue #38: cap on a single LST stake (wei). "0" = uncapped (bounded by balance).
    maxLstDepositWethWei?: string;
    // ADR 0013: base symbol -> per-round cap (base units, decimal string). WETH equals maxWethInWei
    // etc. above for compatibility. Caps for additional bases (WBTC etc.) go here. "0" = no cap
    // (balance bound). A base-agnostic agent can cap its base-sell size at this value.
    baseLimits?: Record<
      TokenSymbol,
      {
        maxSwapInBaseWei: string;
        maxLpBaseWei: string;
        maxAaveSupplyBaseWei: string;
      }
    >;
  };
  protocols: ProtocolObservations;
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
  wallet: string;
  description?: string;
  env?: Record<string, string>;
  // A yardstick for discrimination. If true, it is a baseline such as noop/random.
  baseline?: boolean;
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
  usdcUnits: bigint; // sum of active stables (for display/PnL)
  // ADR 0013: base symbol -> balance (WETH/WBTC etc.). wethWei equals bases["WETH"] for compatibility.
  bases?: Record<string, bigint>;
  // stable token address (lowercase) -> balance. Validation checks each venue's stable individually via this map.
  stables?: Record<string, bigint>;
};
