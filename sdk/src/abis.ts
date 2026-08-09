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
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
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
]);

// Balancer v2 WeightedPool. The spot price of a weighted pool is set by the balance/weight ratios,
// so seeding it at the live price needs the weights (issue #43).
export const balancerWeightedPoolAbi = parseAbi([
  "function getNormalizedWeights() view returns (uint256[])",
]);

export const balancerQueriesAbi = parseAbi([
  "function querySwap((bytes32 poolId, uint8 kind, address assetIn, address assetOut, uint256 amount, bytes userData) singleSwap, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds) returns (uint256)",
]);

// Curve StableSwap-NG (the LST/WETH secondary market, issue #38). Note the int128 coin indices --
// stableswap and the crypto pools above disagree on that, so they cannot share an ABI.
export const curveStableSwapNgAbi = parseAbi([
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
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
