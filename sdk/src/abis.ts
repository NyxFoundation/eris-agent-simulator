import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  // LP-token share valuation (issue #41).
  "function totalSupply() view returns (uint256)",
  // Balancer seeding (issue #43) sizes legs in USD, so it needs the scale of tokens the registry
  // does not carry (the fork pool's USD₮0 leg).
  "function decimals() view returns (uint8)",
]);

export const wethAbi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function tickSpacing() view returns (int24)",
  // Depth in range at the current tick. It is what decides slippage on a given notional, and the
  // liquidityPull stress event (issue #52) moves it mid-run, so agents have to be able to see it.
  "function liquidity() view returns (uint128)",
  // Uncollected-fee accounting (issue #21): a position's fees live in the pool until poke/collect.
  "function feeGrowthGlobal0X128() view returns (uint256)",
  "function feeGrowthGlobal1X128() view returns (uint256)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
]);

export const quoterV2Abi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export const swapRouterAbi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

export const nonfungiblePositionManagerAbi = parseAbi([
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)",
  // The liquidityPull stress event (issue #52) has to put the depth back when its window closes,
  // so the withdrawal is a constraint for the duration rather than a permanent change to the venue.
  "function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  // decreaseLiquidity only credits tokensOwed; the tokens do not leave the pool until collect. The
  // liquidityPull event has to do both, and in one transaction: two sends from the same key race on
  // the nonce the same way the LST accrual did.
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  // Issue #41: positions may sit in pools outside the registered market set; the factory resolves them.
  "function factory() view returns (address)",
]);

export const uniswapV3FactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);

// Balancer v2 Vault + Queries
export const balancerVaultAbi = parseAbi([
  "function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)",
  "function swap((bytes32 poolId, uint8 kind, address assetIn, address assetOut, uint256 amount, bytes userData) singleSwap, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds, uint256 limit, uint256 deadline) payable returns (uint256 amountCalculated)",
  "function joinPool(bytes32 poolId, address sender, address recipient, (address[] assets, uint256[] maxAmountsIn, bytes userData, bool fromInternalBalance) request) payable",
  // Proportional exit for the liquidityPull stress event (issue #52). EXACT_BPT_IN_FOR_TOKENS_OUT
  // takes both sides at the pool's current weights, so depth changes and the spot price does not.
  "function exitPool(bytes32 poolId, address sender, address recipient, (address[] assets, uint256[] minAmountsOut, bytes userData, bool toInternalBalance) request)",
]);

// Balancer v2 WeightedPool. The spot price of a weighted pool is set by the balance/weight ratios,
// so seeding it at the live price needs the weights (issue #43).
export const balancerWeightedPoolAbi = parseAbi([
  "function getNormalizedWeights() view returns (uint256[])",
]);

export const balancerQueriesAbi = parseAbi([
  "function querySwap((bytes32 poolId, uint8 kind, address assetIn, address assetOut, uint256 amount, bytes userData) singleSwap, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds) returns (uint256)",
]);

// twocrypto-ng liquidity operations, for the liquidityPull stress event (issue #52). These pools are
// their own ERC-20, so the LP balance is read from the pool address itself. `remove_liquidity` is the
// balanced exit -- it returns both coins at the current ratio and does not touch the price (the
// one-coin variant would, which is why it is not here).
export const curveTwocryptoLiquidityAbi = parseAbi([
  "function add_liquidity(uint256[2] amounts, uint256 min_mint_amount) returns (uint256)",
  "function remove_liquidity(uint256 amount, uint256[2] min_amounts) returns (uint256[2])",
  "function balances(uint256 i) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

// Curve StableSwap-NG (the LST/WETH secondary market, issue #38). Note the int128 coin indices --
// stableswap and the crypto pools above disagree on that, so they cannot share an ABI.
export const curveStableSwapNgAbi = parseAbi([
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  // The mirror of get_dy: how much of coin i it takes to obtain dy of coin j. Buying back a Trove's
  // eUSD debt is quoted with this (issue #39) -- get_dy would answer a different question and
  // marking the liability off it would understate what closing the position costs.
  "function get_dx(int128 i, int128 j, uint256 dy) view returns (uint256)",
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
  "function coins(uint256 i) view returns (address)",
  "function balances(uint256 i) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  // The rate the pool applies to each coin. For the LST leg this is the vault's redemption rate,
  // which is what keeps a rising exchange rate from opening a free arb (issue #38).
  "function stored_rates() view returns (uint256[])",
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
]);

// MockLSTVault (issue #38): ERC-4626 shaped with wstETH aliases and a request/claim withdrawal
// queue. `redeem` enqueues rather than paying out, so previewRedeem is the queue's eventual payout.
export const lstVaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function stEthPerToken() view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function requestWithdraw(uint256 shares) returns (uint256)",
  "function claimWithdraw(uint256 requestId) returns (uint256)",
  "function claimAllWithdrawals() returns (uint256)",
  "function accrueRewards() returns (uint256)",
  "function fundRewards(uint256 assets)",
  "function slash(uint256 bps) returns (uint256)",
  "function setRewardRate(uint256 ratePerBlockRay)",
  "function setWithdrawalDelayBlocks(uint256 delayBlocks)",
  "function operators(address account) view returns (bool)",
  "function rewardReserve() view returns (uint256)",
  "function withdrawalDelayBlocks() view returns (uint256)",
  "function rewardRatePerBlockRay() view returns (uint256)",
  "function requestIdsOf(address owner) view returns (uint256[])",
  "function withdrawalRequests(uint256 id) view returns (address owner, uint256 shares, uint256 assets, uint256 claimableAt, bool claimed)",
  "function accountSummary(address owner) view returns (uint256 shares, uint256 shareAssets, uint256 pendingAssets, uint256 claimableAssets, uint256 nextClaimableAt, uint256 openRequests)",
  "function accountSummaryAt(address owner, uint256 horizonBlock) view returns (uint256 shares, uint256 shareAssets, uint256 claimableAssets, uint256 reachableAssets, uint256 unreachableAssets, uint256 openRequests)",
  "function openRequestsOf(address owner) view returns (uint256[] ids, uint256[] assets, uint256[] claimableAt)",
  "function vaultSummary() view returns (uint256 pooledWeth, uint256 shareSupply, uint256 redemptionRate, uint256 reserve, uint256 queuedWeth, uint256 queueLength, uint256 delayBlocks, uint256 ratePerBlockRay, uint256 throughputWeiPerBlock, uint256 drainBlock)",
  // Issue #38 phase 2: the queue is rate-limited, so the wait depends on your size and on what is
  // already queued ahead of you. Quote it before committing rather than discovering it after.
  "function estimateClaimableAt(uint256 assets) view returns (uint256)",
  "function estimateDelayBlocks(uint256 assets) view returns (uint256)",
  "function setQueueThroughput(uint256 weiPerBlock)",
  "function queueThroughputWeiPerBlock() view returns (uint256)",
  "function queueDrainBlock() view returns (uint256)",
  "function surplusWeth() view returns (uint256)",
]);

// ---------------------------------------------------------------------------
// Liquity V1, the CDP stablecoin venue issuing eUSD (issue #39).
//
// The core is forked unmodified, so these are Liquity's own signatures -- including the LUSD names
// the source uses for what this venue calls eUSD. Renaming them here would make the ABI stop
// matching the deployed selectors.
// ---------------------------------------------------------------------------

export const troveManagerAbi = parseAbi([
  // System state. Every ratio view takes the price explicitly rather than reading the oracle, which
  // is what lets the observation and the scorer evaluate a *historical* block at that block's price.
  "function getTCR(uint256 price) view returns (uint256)",
  "function checkRecoveryMode(uint256 price) view returns (bool)",
  "function getEntireSystemColl() view returns (uint256)",
  "function getEntireSystemDebt() view returns (uint256)",
  "function MCR() view returns (uint256)",
  "function CCR() view returns (uint256)",
  "function MIN_NET_DEBT() view returns (uint256)",
  // The 200 eUSD held in the GasPool for the duration of a Trove. It is part of the Trove's debt but
  // not of what the borrower has to repay, so a valuation that ignores it understates every Trove.
  "function LUSD_GAS_COMPENSATION() view returns (uint256)",
  // Per-Trove state. getEntireDebtAndColl includes pending redistribution rewards, which is what the
  // system will actually charge, so it is the one to value against.
  "function getEntireDebtAndColl(address borrower) view returns (uint256 debt, uint256 coll, uint256 pendingLUSDDebtReward, uint256 pendingETHReward)",
  "function getCurrentICR(address borrower, uint256 price) view returns (uint256)",
  "function getNominalICR(address borrower) view returns (uint256)",
  "function getTroveStatus(address borrower) view returns (uint256)",
  "function getTroveOwnersCount() view returns (uint256)",
  "function getTroveFromTroveOwnersArray(uint256 index) view returns (address)",
  // Both fee curves. They decay on a ~12h half-life, so within a run the first large redemption
  // raises the cost for everyone who follows -- which is the timing decision the venue adds.
  "function getBorrowingRateWithDecay() view returns (uint256)",
  "function getRedemptionRateWithDecay() view returns (uint256)",
  "function getBorrowingFeeWithDecay(uint256 debt) view returns (uint256)",
  "function getRedemptionFeeWithDecay(uint256 ethDrawn) view returns (uint256)",
  "function baseRate() view returns (uint256)",
  "function BORROWING_FEE_FLOOR() view returns (uint256)",
  "function REDEMPTION_FEE_FLOOR() view returns (uint256)",
  // Ground truth for what the venue actually did, rather than what the block state implies. A Trove
  // count that fell could be a close, a full redemption or a liquidation, and issue #39's open
  // question about ordering can only be answered by counting the real ones.
  "event TroveLiquidated(address indexed _borrower, uint256 _debt, uint256 _coll, uint8 _operation)",
  "event Liquidation(uint256 _liquidatedDebt, uint256 _liquidatedColl, uint256 _collGasCompensation, uint256 _LUSDGasCompensation)",
  "event Redemption(uint256 _attemptedLUSDAmount, uint256 _actualLUSDAmount, uint256 _ETHSent, uint256 _ETHFee)",
  // Actions.
  "function redeemCollateral(uint256 LUSDAmount, address firstRedemptionHint, address upperPartialRedemptionHint, address lowerPartialRedemptionHint, uint256 partialRedemptionHintNICR, uint256 maxIterations, uint256 maxFeePercentage)",
  "function liquidate(address borrower)",
  "function batchLiquidateTroves(address[] troveArray)",
  "function liquidateTroves(uint256 n)",
]);

export const borrowerOperationsAbi = parseAbi([
  // Collateral is native ETH (msg.value), which is why the adapter unwraps WETH first.
  "function openTrove(uint256 maxFeePercentage, uint256 LUSDAmount, address upperHint, address lowerHint) payable",
  "function addColl(address upperHint, address lowerHint) payable",
  "function withdrawColl(uint256 amount, address upperHint, address lowerHint)",
  "function withdrawLUSD(uint256 maxFeePercentage, uint256 amount, address upperHint, address lowerHint)",
  "function repayLUSD(uint256 amount, address upperHint, address lowerHint)",
  "function adjustTrove(uint256 maxFeePercentage, uint256 collWithdrawal, uint256 LUSDChange, bool isDebtIncrease, address upperHint, address lowerHint) payable",
  "function closeTrove()",
  "function claimCollateral()",
  // Net debt plus the gas compensation, i.e. what a requested borrow actually books as debt.
  "function getCompositeDebt(uint256 debt) pure returns (uint256)",
]);

export const stabilityPoolAbi = parseAbi([
  "function provideToSP(uint256 amount, address frontEndTag)",
  "function withdrawFromSP(uint256 amount)",
  "function getCompoundedLUSDDeposit(address depositor) view returns (uint256)",
  "function getDepositorETHGain(address depositor) view returns (uint256)",
  "function getDepositorLQTYGain(address depositor) view returns (uint256)",
  "function getTotalLUSDDeposits() view returns (uint256)",
  "function getETH() view returns (uint256)",
]);

export const sortedTrovesAbi = parseAbi([
  // Sorted by nominal ICR, descending: the head is the safest Trove and the tail is the one a
  // redemption reaches first.
  "function getFirst() view returns (address)",
  "function getLast() view returns (address)",
  "function getNext(address id) view returns (address)",
  "function getPrev(address id) view returns (address)",
  "function getSize() view returns (uint256)",
  "function contains(address id) view returns (bool)",
  "function findInsertPosition(uint256 NICR, address prevId, address nextId) view returns (address, address)",
]);

// HintHelpers deliberately has no ABI here. A redemption's hints cannot be computed off chain in
// this environment -- they depend on the price the transaction itself fetches, and the oracle moves
// every block ahead of every agent -- so they are computed on chain by LiquityRedemptionHelper
// instead. An ABI here would invite exactly the stale-hint call that reverted every redemption in
// the venue's first live run.

// The oracle Liquity holds forever (deployer/contracts/LiquityPriceFeedAdapter.sol). Each run points
// it at the PriceFeed it just deployed. `fetchPrice` is state-changing (it caches the last good
// price), but simulating it is the only way to ask what the venue would actually serve right now --
// which is what the startup check compares against the run's fair price.
export const liquityPriceFeedAdapterAbi = parseAbi([
  "function operator() view returns (address)",
  "function source() view returns (address)",
  "function lastGoodPrice() view returns (uint256)",
  "function setSource(address source)",
  "function fetchPrice() returns (uint256)",
]);

// LiquityRedemptionHelper (deployer/contracts/LiquityRedemptionHelper.sol). Liquity checks a partial
// redemption against a hint derived from the price the transaction itself fetches, so the hints have
// to be computed on chain: this environment writes a new price every block, ahead of every agent.
export const liquityRedemptionHelperAbi = parseAbi([
  "function redeem(uint256 amount, uint256 maxFeePercentage, uint256 maxIterations) returns (uint256 redeemed, uint256 ethOut)",
]);

// Curve CryptoSwap (tricrypto v0.2.x): exchange / get_dy / coins / balances
export const curveTricryptoAbi = parseAbi([
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
  "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy)",
  "function coins(uint256 i) view returns (address)",
  "function balances(uint256 i) view returns (uint256)",
  // LP-token share valuation (issue #41). Older tricrypto pools mint a separate LP token; the
  // twocrypto-ng pools used locally are their own ERC-20, where token() does not exist.
  "function token() view returns (address)",
]);
