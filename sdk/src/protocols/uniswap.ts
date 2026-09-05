import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  maxUint128,
  maxUint256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  erc20Abi,
  nonfungiblePositionManagerAbi,
  poolAbi,
  quoterV2Abi,
  swapRouterAbi,
  uniswapV3FactoryAbi,
  wethAbi,
} from "../abis.js";
import { TOKENS, UNISWAP, stableBalanceOf } from "../constants.js";
import {
  marketFor,
  marketsFor,
  tokenInfo,
  type MarketConfig,
} from "../markets.js";
import { tokenAmountUsd, type UnpricedAmount } from "../valuation.js";
import type { StablePrices } from "../stables.js";
import { resolveMarket } from "./marketHelpers.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  LeafAction,
  LpPositionObservation,
  SwapAction,
  TokenSymbol,
  UniswapMarketObservation,
  UniswapObservation,
} from "../types.js";
import type {
  AgentProtocolValue,
  BuiltTx,
  ProtocolAdapter,
  ValidationResult,
} from "./types.js";

const DECIMAL_INTEGER = /^[0-9]+$/;

type UniswapMarketState = {
  market: MarketConfig;
  priceUsdcPerWeth: number; // base/USD (name kept WETH-compatible; value is this base's price)
  tick: number;
  tickSpacing: number;
  // In-range depth. Constant for a whole run until the liquidityPull stress event (issue #52)
  // withdraws seeded depth for the length of a window. Undefined when the read failed -- never 0,
  // which would read as an empty book.
  liquidity: bigint | undefined;
};

type UniswapState = {
  // WETH market (kept at top level for backward compatibility).
  priceUsdcPerWeth: number;
  tick: number;
  tickSpacing: number;
  liquidity: bigint | undefined;
  // All uniswap markets (including WETH). WETH only on the default fork.
  markets: UniswapMarketState[];
};

function wethMarket(): MarketConfig {
  const m = marketFor("uniswap", "WETH");
  if (!m) throw new Error("uniswap: WETH market not configured");
  return m;
}

function legOf(market: MarketConfig) {
  if (!market.uniswap)
    throw new Error(`uniswap: market ${market.key} has no leg`);
  return market.uniswap;
}

// The market's base/quote and their sort (token0/token1 in ascending address order).
function sortedTokensFor(market: MarketConfig): {
  token0: Address;
  token1: Address;
  baseIsToken0: boolean;
} {
  const baseAddr = tokenInfo(market.base).address;
  const quoteAddr = tokenInfo(market.quote).address;
  const baseIsToken0 = baseAddr.toLowerCase() < quoteAddr.toLowerCase();
  return baseIsToken0
    ? { token0: baseAddr, token1: quoteAddr, baseIsToken0 }
    : { token0: quoteAddr, token1: baseAddr, baseIsToken0 };
}

// swap tokenIn (base|quote symbol) -> in/out addresses.
function swapLeg(
  market: MarketConfig,
  tokenIn: TokenSymbol,
): { assetIn: Address; assetOut: Address } {
  const baseAddr = tokenInfo(market.base).address;
  const quoteAddr = tokenInfo(market.quote).address;
  return tokenIn === market.base
    ? { assetIn: baseAddr, assetOut: quoteAddr }
    : { assetIn: quoteAddr, assetOut: baseAddr };
}

// slot0's sqrtPriceX96 -> quote per base (decimals generalized; absorbs the base/quote decimal difference).
export function poolPriceFromSqrtX96(
  sqrtPriceX96: bigint,
  market: MarketConfig,
): number {
  const { baseIsToken0 } = sortedTokensFor(market);
  const baseDec = tokenInfo(market.base).decimals;
  const quoteDec = tokenInfo(market.quote).decimals;
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const rawToken1PerToken0 = ratio * ratio;
  const scale = 10 ** (baseDec - quoteDec);
  // raw(token1/token0) -> quote per base
  return baseIsToken0 ? rawToken1PerToken0 * scale : scale / rawToken1PerToken0;
}

// The inverse, for `createPool` (issue #40): the sqrtPriceX96 that initializes a pool at a given
// price. `humanPrice` is whole units of token1 per one whole token0, with the pair already sorted
// (the lower address is token0), so the decimal difference is applied here rather than by the
// caller. A pool initialized at the wrong price is not a bug the environment can catch -- seeding a
// market away from fair is a legitimate thing to do -- so the arithmetic being obvious matters.
export function sqrtPriceX96For(opts: {
  humanPrice: number;
  token0Decimals: number;
  token1Decimals: number;
}): bigint {
  const raw =
    opts.humanPrice *
    10 ** (opts.token1Decimals - opts.token0Decimals);
  if (!(raw > 0)) throw new Error("sqrtPriceX96For: price must be positive");
  // Float sqrt then a single conversion. Uniswap re-derives the tick from this value, so the last
  // few bits do not survive initialization anyway; what matters is landing in the right tick.
  return BigInt(Math.floor(Math.sqrt(raw) * 2 ** 96));
}

// Backward compatible: WETH/USDC sqrtPriceX96 -> USDC per WETH. Shared by reconstruct/dashboard.
export function poolPriceUsdcPerWethFromSqrtX96(sqrtPriceX96: bigint): number {
  return poolPriceFromSqrtX96(sqrtPriceX96, wethMarket());
}

async function getMarketState(
  publicClient: PublicClient,
  market: MarketConfig,
): Promise<UniswapMarketState> {
  const leg = legOf(market);
  const [slot0, tickSpacing, liquidity] = await Promise.all([
    publicClient.readContract({
      address: leg.pool,
      abi: poolAbi,
      functionName: "slot0",
    }),
    publicClient
      .readContract({
        address: leg.pool,
        abi: poolAbi,
        functionName: "tickSpacing",
      })
      .catch(() => leg.tickSpacing),
    // Unlike tickSpacing there is no configured value to fall back to, and "0" would read as an
    // empty book -- which is a state the liquidityPull event deliberately cannot produce. An
    // unreadable depth is reported as absent instead (see UniswapMarketObservation.liquidity).
    publicClient
      .readContract({
        address: leg.pool,
        abi: poolAbi,
        functionName: "liquidity",
      })
      .catch(() => undefined),
  ]);
  return {
    market,
    priceUsdcPerWeth: poolPriceFromSqrtX96(slot0[0], market),
    tick: Number(slot0[1]),
    tickSpacing: Number(tickSpacing),
    liquidity: liquidity === undefined ? undefined : BigInt(liquidity),
  };
}

export async function getPoolState(
  publicClient: PublicClient,
): Promise<UniswapState> {
  const markets = marketsFor("uniswap");
  const states = await Promise.all(
    markets.map((m) => getMarketState(publicClient, m)),
  );
  const weth = states.find((s) => s.market.base === "WETH") ?? states[0];
  return {
    priceUsdcPerWeth: weth.priceUsdcPerWeth,
    tick: weth.tick,
    tickSpacing: weth.tickSpacing,
    liquidity: weth.liquidity,
    markets: states,
  };
}

export async function getPoolPriceUsdcPerWeth(
  publicClient: PublicClient,
): Promise<number> {
  return (await getPoolState(publicClient)).priceUsdcPerWeth;
}

async function quoteExactInput(
  publicClient: PublicClient,
  market: MarketConfig,
  assetIn: Address,
  assetOut: Address,
  amountIn: bigint,
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: assetIn,
        tokenOut: assetOut,
        amountIn,
        fee: legOf(market).fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const result = await publicClient.call({ to: UNISWAP.quoterV2, data });
  const [amountOut] = decodeFunctionResult({
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    data: result.data ?? "0x",
  });
  return amountOut;
}

async function buildSwapData(
  publicClient: PublicClient,
  recipient: Address,
  market: MarketConfig,
  action: SwapAction,
  slippageBps: number,
): Promise<Hex> {
  const amountIn = BigInt(action.amountIn);
  const { assetIn, assetOut } = swapLeg(market, action.tokenIn);
  const quoted = await quoteExactInput(
    publicClient,
    market,
    assetIn,
    assetOut,
    amountIn,
  );
  return encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: assetIn,
        tokenOut: assetOut,
        fee: legOf(market).fee,
        recipient,
        deadline: deadline(),
        amountIn,
        amountOutMinimum: applySlippage(quoted, slippageBps),
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

async function buildLpActionData(
  publicClient: PublicClient,
  owner: Address,
  market: MarketConfig,
  action: LeafAction,
  slippageBps: number,
): Promise<Hex> {
  const { token0, token1, baseIsToken0 } = sortedTokensFor(market);
  const fee = legOf(market).fee;
  if (action.type === "mintLiquidity") {
    // When base is specified use amountBase/QuoteDesired; when unspecified (default WETH) use amountWeth/UsdcDesired.
    const amountBase = BigInt(
      action.amountBaseDesired ?? action.amountWethDesired,
    );
    const amountQuote = BigInt(
      action.amountQuoteDesired ?? action.amountUsdcDesired,
    );
    const amount0Desired = baseIsToken0 ? amountBase : amountQuote;
    const amount1Desired = baseIsToken0 ? amountQuote : amountBase;
    const mintParams = (amount0Min: bigint, amount1Min: bigint) => ({
      token0,
      token1,
      fee,
      tickLower: action.tickLower,
      tickUpper: action.tickUpper,
      amount0Desired,
      amount1Desired,
      amount0Min,
      amount1Min,
      recipient: owner,
      deadline: deadline(),
    });
    const simulated = await publicClient.simulateContract({
      account: owner,
      address: UNISWAP.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "mint",
      args: [mintParams(0n, 0n)],
    });
    const [, , amount0, amount1] = simulated.result;
    return encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "mint",
      args: [
        mintParams(
          applySlippage(amount0, slippageBps),
          applySlippage(amount1, slippageBps),
        ),
      ],
    });
  }

  if (action.type === "removeLiquidity") {
    const amountBaseMin = BigInt(action.amountWethMin ?? "0");
    const amountQuoteMin = BigInt(action.amountUsdcMin ?? "0");
    return encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId: BigInt(action.tokenId),
          liquidity: BigInt(action.liquidity),
          amount0Min: baseIsToken0 ? amountBaseMin : amountQuoteMin,
          amount1Min: baseIsToken0 ? amountQuoteMin : amountBaseMin,
          deadline: deadline(),
        },
      ],
    });
  }

  if (action.type === "collectFees") {
    return encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "collect",
      args: [
        {
          tokenId: BigInt(action.tokenId),
          recipient: owner,
          amount0Max: maxUint128,
          amount1Max: maxUint128,
        },
      ],
    });
  }

  throw new Error(`Unsupported LP action: ${action.type}`);
}

// Resolve the uniswap market that a position's (token0,token1,fee) belongs to. Handles non-WETH/USDC too.
function positionMarketOf(
  token0: Address,
  token1: Address,
  fee: number,
  markets: MarketConfig[],
): MarketConfig | undefined {
  for (const m of markets) {
    const { token0: t0, token1: t1 } = sortedTokensFor(m);
    if (
      token0.toLowerCase() === t0.toLowerCase() &&
      token1.toLowerCase() === t1.toLowerCase() &&
      fee === legOf(m).fee
    ) {
      return m;
    }
  }
  return undefined;
}

export async function getLpPositions(
  publicClient: PublicClient,
  owner: Address,
  // base symbol -> fair price (USD). Matches prior behavior when WETH-only.
  fairPriceByBase: Record<string, number>,
  // pool address (lower) -> tick. If observe passes the already-read tick, the re-read is skipped.
  knownTickByPool?: Record<string, number>,
): Promise<LpPositionObservation[]> {
  const markets = marketsFor("uniswap");
  // Each market's tick (read it if not provided).
  const tickByPool: Record<string, number> = { ...(knownTickByPool ?? {}) };
  await Promise.all(
    markets.map(async (m) => {
      const pool = legOf(m).pool.toLowerCase();
      if (tickByPool[pool] === undefined) {
        const s = await getMarketState(publicClient, m);
        tickByPool[pool] = s.tick;
      }
    }),
  );

  const balance = await publicClient.readContract({
    address: UNISWAP.nonfungiblePositionManager,
    abi: nonfungiblePositionManagerAbi,
    functionName: "balanceOf",
    args: [owner],
  });

  const indices = Array.from({ length: Number(balance) }, (_, i) => BigInt(i));
  const tokenIds = await Promise.all(
    indices.map((i) =>
      publicClient.readContract({
        address: UNISWAP.nonfungiblePositionManager,
        abi: nonfungiblePositionManagerAbi,
        functionName: "tokenOfOwnerByIndex",
        args: [owner, i],
      }),
    ),
  );
  const rawPositions = await Promise.all(
    tokenIds.map((tokenId) =>
      publicClient.readContract({
        address: UNISWAP.nonfungiblePositionManager,
        abi: nonfungiblePositionManagerAbi,
        functionName: "positions",
        args: [tokenId],
      }),
    ),
  );

  // Issue #21: fees earned since the last checkpoint sit in the pool, not in tokensOwed, so a
  // narrow-range position looks flat until it collects. Read the pool fee growth for every boundary
  // an owned position touches so the observation shows the fees as they accrue.
  const ticksByPool = new Map<Address, Set<number>>();
  for (const raw of rawPositions) {
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = raw;
    if (liquidity <= 0n) continue;
    const market = positionMarketOf(token0, token1, fee, markets);
    if (!market) continue;
    const pool = legOf(market).pool;
    const ticks = ticksByPool.get(pool) ?? new Set<number>();
    ticks.add(tickLower).add(tickUpper);
    ticksByPool.set(pool, ticks);
  }
  const feeGrowthByPool =
    ticksByPool.size > 0
      ? await readPoolFeeGrowth(publicClient, ticksByPool)
      : {};

  // Issue #40: positions in pools the environment did not deploy. An agent that creates its own
  // pool and provides liquidity to it used to see *nothing* here -- the position was dropped for
  // having no MARKET_LEGS entry -- so it could not read its own holding and `removeLiquidity` would
  // not even accept the tokenId, because validation checks the observation. Under the round-trip
  // rule that is the whole position lost at the bell, for want of being able to see it.
  //
  // Resolved through the factory, exactly as the scorer already does (issue #41), and only when the
  // agent actually holds such a position: no position, no reads.
  const unregistered = new Map<string, { token0: Address; token1: Address; fee: number }>();
  for (const raw of rawPositions) {
    const [, , token0, token1, fee] = raw;
    if (positionMarketOf(token0, token1, fee, markets)) continue;
    unregistered.set(positionPoolKey(token0, token1, fee), { token0, token1, fee });
  }
  const poolByKey: Record<string, Address> = {};
  if (unregistered.size > 0) {
    const factory = await uniswapFactory(publicClient);
    if (factory) {
      const entries = [...unregistered.entries()];
      const resolved = await Promise.all(
        entries.map(([, p]) =>
          publicClient
            .readContract({
              address: factory,
              abi: uniswapV3FactoryAbi,
              functionName: "getPool",
              args: [p.token0, p.token1, p.fee],
            })
            .catch(() => undefined),
        ),
      );
      const ticks = await Promise.all(
        resolved.map((pool) =>
          pool && pool !== ZERO_ADDRESS
            ? publicClient
                .readContract({
                  address: pool as Address,
                  abi: poolAbi,
                  functionName: "slot0",
                })
                .catch(() => undefined)
            : undefined,
        ),
      );
      entries.forEach(([key], i) => {
        const pool = resolved[i] as Address | undefined;
        if (!pool || pool === ZERO_ADDRESS) return;
        poolByKey[key] = pool;
        const slot0 = ticks[i] as readonly [bigint, number] | undefined;
        if (slot0) tickByPool[pool.toLowerCase()] = slot0[1];
      });
    }
  }

  const positions: LpPositionObservation[] = [];
  for (let i = 0; i < tokenIds.length; i++) {
    const tokenId = tokenIds[i];
    const [
      ,
      ,
      token0,
      token1,
      fee,
      tickLower,
      tickUpper,
      liquidity,
      feeGrowthInside0LastX128,
      feeGrowthInside1LastX128,
      tokensOwed0,
      tokensOwed1,
    ] = rawPositions[i];
    const market = positionMarketOf(token0, token1, fee, markets);
    if (!market) {
      // An agent-created pool. Reported with the raw pair as its key, and valued the way every
      // other unknown holding is: each leg at the environment's price, or nothing when the
      // environment does not price it (an agent-issued token is worth zero to everyone).
      const resolved = poolByKey[positionPoolKey(token0, token1, fee)];
      const unknownTick =
        resolved === undefined ? undefined : tickByPool[resolved.toLowerCase()];
      if (unknownTick === undefined) continue; // the pool could not be resolved; not "worth zero"
      const amounts = liquidityToTokenAmounts({
        liquidity,
        tick: unknownTick,
        tickLower,
        tickUpper,
      });
      const amount0 = amounts.amount0 + tokensOwed0;
      const amount1 = amounts.amount1 + tokensOwed1;
      positions.push({
        tokenId: tokenId.toString(),
        tickLower,
        tickUpper,
        liquidity: liquidity.toString(),
        tokensOwedWethWei: tokensOwed0.toString(),
        tokensOwedUsdcUnits: tokensOwed1.toString(),
        uncollectedFeesWethWei: "0",
        uncollectedFeesUsdcUnits: "0",
        amountWethWei: amounts.amount0.toString(),
        amountUsdcUnits: amounts.amount1.toString(),
        valueUsdc:
          (tokenAmountUsd(token0, amount0, fairPriceByBase) ?? 0) +
          (tokenAmountUsd(token1, amount1, fairPriceByBase) ?? 0),
        // The raw pair, because there is no registry name for it.
        market: `${token0}/${token1}#${fee}`,
      });
      continue;
    }
    const { baseIsToken0 } = sortedTokensFor(market);
    const pool = legOf(market).pool.toLowerCase();
    const tick = tickByPool[pool] ?? 0;
    const amounts = liquidityToTokenAmounts({
      liquidity,
      tick,
      tickLower,
      tickUpper,
    });
    const fees = uncollectedFees({
      liquidity,
      tick,
      tickLower,
      tickUpper,
      feeGrowthInside0LastX128,
      feeGrowthInside1LastX128,
      pool: feeGrowthByPool[pool],
    });
    const amountBase = baseIsToken0 ? amounts.amount0 : amounts.amount1;
    const amountQuote = baseIsToken0 ? amounts.amount1 : amounts.amount0;
    const owedBase = baseIsToken0 ? tokensOwed0 : tokensOwed1;
    const owedQuote = baseIsToken0 ? tokensOwed1 : tokensOwed0;
    const feeBase = baseIsToken0 ? fees.fees0 : fees.fees1;
    const feeQuote = baseIsToken0 ? fees.fees1 : fees.fees0;
    const basePrice = fairPriceByBase[market.base] ?? 0;
    positions.push({
      tokenId: tokenId.toString(),
      tickLower,
      tickUpper,
      liquidity: liquidity.toString(),
      tokensOwedWethWei: owedBase.toString(),
      tokensOwedUsdcUnits: owedQuote.toString(),
      uncollectedFeesWethWei: feeBase.toString(),
      uncollectedFeesUsdcUnits: feeQuote.toString(),
      amountWethWei: amountBase.toString(),
      amountUsdcUnits: amountQuote.toString(),
      valueUsdc: valuePositionUsdc(
        amountBase,
        amountQuote,
        owedBase + feeBase,
        owedQuote + feeQuote,
        market,
        basePrice,
      ),
      ...(market.base === "WETH" ? {} : { market: market.key }),
    });
  }
  return positions;
}

export function liquidityToTokenAmounts(input: {
  liquidity: bigint;
  tick: number;
  tickLower: number;
  tickUpper: number;
}): { amount0: bigint; amount1: bigint } {
  const liquidity = Number(input.liquidity);
  const sqrtLower = Math.pow(1.0001, input.tickLower / 2);
  const sqrtUpper = Math.pow(1.0001, input.tickUpper / 2);
  const sqrtCurrent = Math.pow(1.0001, input.tick / 2);

  let amount0 = 0;
  let amount1 = 0;
  if (input.tick < input.tickLower) {
    amount0 = (liquidity * (sqrtUpper - sqrtLower)) / (sqrtUpper * sqrtLower);
  } else if (input.tick >= input.tickUpper) {
    amount1 = liquidity * (sqrtUpper - sqrtLower);
  } else {
    amount0 =
      (liquidity * (sqrtUpper - sqrtCurrent)) / (sqrtUpper * sqrtCurrent);
    amount1 = liquidity * (sqrtCurrent - sqrtLower);
  }

  return {
    amount0: BigInt(Math.max(0, Math.floor(amount0))),
    amount1: BigInt(Math.max(0, Math.floor(amount1))),
  };
}

// ---------------------------------------------------------------------------
// Uncollected fees (issue #21)
//
// A concentrated position's earned fees stay in the pool until poke/collect writes them into
// tokensOwed. Valuing only liquidity + tokensOwed therefore hides fee income entirely, which is
// exactly the edge a narrow-range strategy is paid for. These helpers reproduce
// UniswapV3Pool.getFeeGrowthInside / Position.update so the value can be marked without a tx.
// ---------------------------------------------------------------------------

const Q128 = 1n << 128n;
const U256 = 1n << 256n;

// Uniswap computes fee-growth deltas with unchecked (wrapping) uint256 arithmetic, and relies on the
// wrapped difference being the true delta. Subtraction here has to wrap the same way.
function wrapSub(a: bigint, b: bigint): bigint {
  return (((a - b) % U256) + U256) % U256;
}

// Per-pool fee-growth snapshot needed to price uncollected fees. outsideByTick must contain an entry
// for both boundaries of every position valued; a missing entry means "unknown / uninitialised" and
// suppresses the fee term rather than guessing.
export type PoolFeeGrowth = {
  feeGrowthGlobal0X128: bigint;
  feeGrowthGlobal1X128: bigint;
  outsideByTick: Record<number, readonly [bigint, bigint]>;
};

// Decode a pool ticks(tick) result into an outsideByTick entry. An uninitialised tick reads as all
// zeros, which is indistinguishable from "initialised at genesis growth" — the trailing `initialized`
// flag is the only way to tell, and getting it wrong would make feeGrowthInside read as the entire
// global growth. Uninitialised ticks return undefined so the caller omits them.
export function tickFeeGrowthEntry(
  tick:
    | readonly [bigint, bigint, bigint, bigint, bigint, bigint, number, boolean]
    | undefined,
): readonly [bigint, bigint] | undefined {
  if (!tick || !tick[7]) return undefined;
  return [tick[2], tick[3]];
}

// UniswapV3Pool Tick.getFeeGrowthInside.
export function feeGrowthInsideX128(args: {
  tickCurrent: number;
  tickLower: number;
  tickUpper: number;
  feeGrowthGlobalX128: bigint;
  feeGrowthOutsideLowerX128: bigint;
  feeGrowthOutsideUpperX128: bigint;
}): bigint {
  const below =
    args.tickCurrent >= args.tickLower
      ? args.feeGrowthOutsideLowerX128
      : wrapSub(args.feeGrowthGlobalX128, args.feeGrowthOutsideLowerX128);
  const above =
    args.tickCurrent < args.tickUpper
      ? args.feeGrowthOutsideUpperX128
      : wrapSub(args.feeGrowthGlobalX128, args.feeGrowthOutsideUpperX128);
  return wrapSub(wrapSub(args.feeGrowthGlobalX128, below), above);
}

// Whether both of a position's boundaries have a fee-growth snapshot, i.e. whether uncollectedFees
// can answer at all. Callers use it to report a suppressed fee term instead of silently marking the
// position as having earned nothing (issue #44).
export function feeGrowthKnown(
  pool: PoolFeeGrowth | undefined,
  tickLower: number,
  tickUpper: number,
): boolean {
  return (
    pool !== undefined &&
    pool.outsideByTick[tickLower] !== undefined &&
    pool.outsideByTick[tickUpper] !== undefined
  );
}

// Fees earned since the position's last checkpoint — what collect() would credit before transferring.
// Returns zero when liquidity is zero (nothing accrues) or when a boundary's fee growth is unknown.
export function uncollectedFees(args: {
  liquidity: bigint;
  tick: number;
  tickLower: number;
  tickUpper: number;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  pool: PoolFeeGrowth | undefined;
}): { fees0: bigint; fees1: bigint } {
  const none = { fees0: 0n, fees1: 0n };
  if (args.liquidity <= 0n || !args.pool) return none;
  const lower = args.pool.outsideByTick[args.tickLower];
  const upper = args.pool.outsideByTick[args.tickUpper];
  if (!lower || !upper) return none;
  const shared = {
    tickCurrent: args.tick,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
  };
  const inside0 = feeGrowthInsideX128({
    ...shared,
    feeGrowthGlobalX128: args.pool.feeGrowthGlobal0X128,
    feeGrowthOutsideLowerX128: lower[0],
    feeGrowthOutsideUpperX128: upper[0],
  });
  const inside1 = feeGrowthInsideX128({
    ...shared,
    feeGrowthGlobalX128: args.pool.feeGrowthGlobal1X128,
    feeGrowthOutsideLowerX128: lower[1],
    feeGrowthOutsideUpperX128: upper[1],
  });
  return {
    fees0:
      (wrapSub(inside0, args.feeGrowthInside0LastX128) * args.liquidity) / Q128,
    fees1:
      (wrapSub(inside1, args.feeGrowthInside1LastX128) * args.liquidity) / Q128,
  };
}

// Read the fee-growth snapshot for each pool, covering the tick boundaries listed for it. A pool
// whose reads fail is omitted, which suppresses its fee term rather than marking a wrong number.
export async function readPoolFeeGrowth(
  publicClient: PublicClient,
  ticksByPool: Map<Address, Set<number>>,
): Promise<Record<string, PoolFeeGrowth>> {
  const out: Record<string, PoolFeeGrowth> = {};
  await Promise.all(
    [...ticksByPool].map(async ([pool, ticks]) => {
      const tickList = [...ticks];
      try {
        const [global0, global1, ...tickResults] = await Promise.all([
          publicClient.readContract({
            address: pool,
            abi: poolAbi,
            functionName: "feeGrowthGlobal0X128",
          }),
          publicClient.readContract({
            address: pool,
            abi: poolAbi,
            functionName: "feeGrowthGlobal1X128",
          }),
          ...tickList.map((t) =>
            publicClient.readContract({
              address: pool,
              abi: poolAbi,
              functionName: "ticks",
              args: [t],
            }),
          ),
        ]);
        const outsideByTick: Record<number, readonly [bigint, bigint]> = {};
        tickList.forEach((t, i) => {
          const entry = tickFeeGrowthEntry(
            tickResults[i] as Parameters<typeof tickFeeGrowthEntry>[0],
          );
          if (entry) outsideByTick[t] = entry;
        });
        out[pool.toLowerCase()] = {
          feeGrowthGlobal0X128: global0 as bigint,
          feeGrowthGlobal1X128: global1 as bigint,
          outsideByTick,
        };
      } catch {
        // Leave the pool out: uncollectedFees() then returns zero for it.
      }
    }),
  );
  return out;
}

// The V3 factory backing the position manager, used to resolve pools outside the registered market
// set (issue #41). Cached per NPM address: it is immutable for a given deployment, and reconstruct
// would otherwise re-read it once per block of the run window.
const factoryByNpm = new Map<string, Address>();

export async function uniswapFactory(
  publicClient: PublicClient,
): Promise<Address | undefined> {
  const npm = UNISWAP.nonfungiblePositionManager.toLowerCase();
  const cached = factoryByNpm.get(npm);
  if (cached) return cached;
  try {
    const factory = (await publicClient.readContract({
      address: UNISWAP.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "factory",
    })) as Address;
    factoryByNpm.set(npm, factory);
    return factory;
  } catch {
    return undefined;
  }
}

// The pool a position's (token0, token1, fee) trades in, when that pool is a registered market.
export function registeredPoolFor(
  token0: Address,
  token1: Address,
  fee: number,
): Address | undefined {
  const market = positionMarketOf(token0, token1, fee, marketsFor("uniswap"));
  return market ? legOf(market).pool : undefined;
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

// A Date.now()-based value causes "Transaction too old" once evm_increaseTime pushes EVM time
// past the wall clock. This is a harmless MEV-protection field, so use a far-future constant.
function deadline(): bigint {
  return DEADLINE_FAR_FUTURE;
}
const DEADLINE_FAR_FUTURE = BigInt(2 ** 32 - 1); // ~ year 2106

// Value base/quote amounts + owed at the base's USD price (quote is $1).
function valuePositionUsdc(
  amountBaseWei: bigint,
  amountQuoteUnits: bigint,
  owedBaseWei: bigint,
  owedQuoteUnits: bigint,
  market: MarketConfig,
  basePriceUsd: number,
): number {
  const baseDec = tokenInfo(market.base).decimals;
  const quoteDec = tokenInfo(market.quote).decimals;
  const base = Number(formatUnits(amountBaseWei + owedBaseWei, baseDec));
  const quote = Number(
    formatUnits(amountQuoteUnits + owedQuoteUnits, quoteDec),
  );
  return quote + base * basePriceUsd;
}

// Historical-block reconstruction (ADR 0006 §4): a pure function that derives LP value from the raw
// positions(tokenId) tuple. Since reconstruct passes the WETH price, only the WETH/USDC market is valued
// for now (WBTC etc. are 0 until Phase 7 can pass fairByBase). Default-WETH scoring is byte-identical to before.
export function lpPositionValueUsdc(
  position: readonly [
    bigint,
    Address,
    Address,
    Address,
    number,
    number,
    number,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ],
  tick: number,
  fairPriceUsdcPerWeth: number,
): number {
  const [
    ,
    ,
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    liquidity,
    ,
    ,
    tokensOwed0,
    tokensOwed1,
  ] = position;
  const markets = marketsFor("uniswap");
  const market = positionMarketOf(token0, token1, fee, markets);
  // Backward compatible: since reconstruct passes a single WETH price, non-WETH markets are 0 for now (handled in Phase 7).
  if (!market || market.base !== "WETH") return 0;
  const { baseIsToken0 } = sortedTokensFor(market);
  const amounts = liquidityToTokenAmounts({
    liquidity,
    tick,
    tickLower,
    tickUpper,
  });
  return valuePositionUsdc(
    baseIsToken0 ? amounts.amount0 : amounts.amount1,
    baseIsToken0 ? amounts.amount1 : amounts.amount0,
    baseIsToken0 ? tokensOwed0 : tokensOwed1,
    baseIsToken0 ? tokensOwed1 : tokensOwed0,
    market,
    fairPriceUsdcPerWeth,
  );
}

// ---------------------------------------------------------------------------
// General LP valuation (issue #41)
//
// The scorer used to value only positions whose (token0, token1, fee) matched a registered market
// and return 0 for everything else, so an agent that provided liquidity in another fee tier or pair
// read as having lost the entire stake. Valuation is now driven by the position's own tokens: any
// pool the agent holds an NFT for is valued, and only genuinely unpriceable tokens are excluded --
// and those are reported rather than silently zeroed.
// ---------------------------------------------------------------------------

// The raw positions(tokenId) tuple the NPM returns.
export type PositionTuple = Parameters<typeof lpPositionValueUsdc>[0];

// UniswapV3Factory.getPool returns this for a pair/fee that has no pool.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Identifies a Uniswap V3 pool by the tuple the NPM stores, for callers that must resolve pools they
// do not have in MARKET_LEGS (via the factory).
export function positionPoolKey(
  token0: Address,
  token1: Address,
  fee: number,
): string {
  return `${token0.toLowerCase()}-${token1.toLowerCase()}-${fee}`;
}

export type LpValuationContext = {
  // lowercased pool address -> current tick.
  tickByPool: Record<string, number>;
  // base symbol -> USD price. Stables do not appear here: they are quoted against USDC, not
  // against a USD fair-price feed, so their prices come from stablePrices (issue #27).
  fairByBase: Record<string, number>;
  // Market-priced stables (issue #27). Omitted -> every stable leg is valued at par, which is the
  // right answer for a run whose only stables are USDC-equivalents.
  stablePrices?: StablePrices;
  // positionPoolKey -> pool address, for pools outside the registered market set.
  poolByKey?: Record<string, Address>;
  // Issue #21: pool fee growth keyed by lowercased pool address. Omitted -> fees are not marked.
  feeGrowthByPool?: Record<string, PoolFeeGrowth>;
};

export type LpPositionValuation = {
  valueUsdc: number;
  // Holdings excluded from valueUsdc because they could not be priced. amountRaw is "" when even the
  // amounts are unknown (the pool, and therefore the tick, could not be resolved).
  unpriced: UnpricedAmount[];
};

// Value one LP position from the raw positions(tokenId) tuple, in any pool.
export function lpPositionValuation(
  position: Parameters<typeof lpPositionValueUsdc>[0],
  ctx: LpValuationContext,
): LpPositionValuation {
  const [
    ,
    ,
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    liquidity,
    feeGrowthInside0LastX128,
    feeGrowthInside1LastX128,
    tokensOwed0,
    tokensOwed1,
  ] = position;
  const pool =
    registeredPoolFor(token0, token1, fee) ??
    ctx.poolByKey?.[positionPoolKey(token0, token1, fee)];
  const key = pool?.toLowerCase();
  const tick = key === undefined ? undefined : ctx.tickByPool[key];
  // Without a tick the liquidity cannot be split into token amounts. Falling back to tick 0 would
  // silently mis-value the position (it reads as entirely one-sided), so report it instead.
  if (tick === undefined) {
    return {
      valueUsdc: 0,
      unpriced: [
        { token: token0, amountRaw: "" },
        { token: token1, amountRaw: "" },
      ],
    };
  }

  const amounts = liquidityToTokenAmounts({
    liquidity,
    tick,
    tickLower,
    tickUpper,
  });
  const poolFeeGrowth =
    key === undefined ? undefined : ctx.feeGrowthByPool?.[key];
  const fees = uncollectedFees({
    liquidity,
    tick,
    tickLower,
    tickUpper,
    feeGrowthInside0LastX128,
    feeGrowthInside1LastX128,
    pool: poolFeeGrowth,
  });
  const totals = [
    [token0, amounts.amount0 + tokensOwed0 + fees.fees0],
    [token1, amounts.amount1 + tokensOwed1 + fees.fees1],
  ] as const;

  let valueUsdc = 0;
  const unpriced: LpPositionValuation["unpriced"] = [];
  // Suppressing the fee term when a boundary read failed is deliberate (guessing would mis-mark the
  // position), but it still removes value from the mark, so it says so rather than only returning
  // zero fees. The principal above is unaffected and stays valued (issue #44). Only a caller that
  // asked for fees at all (it passed a feeGrowthByPool) can have a read go missing.
  if (
    liquidity > 0n &&
    ctx.feeGrowthByPool !== undefined &&
    !feeGrowthKnown(poolFeeGrowth, tickLower, tickUpper)
  ) {
    unpriced.push({
      amountRaw: "",
      reason: "read-failed",
      read: "UniswapV3Pool.ticks (uncollected fees only; principal still valued)",
    });
  }
  for (const [token, amount] of totals) {
    const usd = tokenAmountUsd(token, amount, ctx.fairByBase, ctx.stablePrices);
    if (usd === undefined) {
      if (amount > 0n) unpriced.push({ token, amountRaw: amount.toString() });
      continue;
    }
    valueUsdc += usd;
  }
  return { valueUsdc, unpriced };
}

// For reconstruct (scoring): resolve the position's market and derive an all-base LP value (WBTC/USDC etc.)
// using tickByPool and fairByBase. Registered markets only; lpPositionValuation covers the rest.
export function lpPositionValueUsdcMulti(
  position: Parameters<typeof lpPositionValueUsdc>[0],
  tickByPool: Record<string, number>,
  fairByBase: Record<string, number>,
  feeGrowthByPool?: Record<string, PoolFeeGrowth>,
): number {
  return lpPositionValuation(position, {
    tickByPool,
    fairByBase,
    feeGrowthByPool,
  }).valueUsdc;
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
function requireInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`${name} must be an integer`);
  return value;
}
function addPriorityFee(
  action: { maxPriorityFeePerGasWei?: string },
  obj: Record<string, unknown>,
): void {
  if (obj.maxPriorityFeePerGasWei === undefined) return;
  requireDecimalString(obj.maxPriorityFeePerGasWei, "maxPriorityFeePerGasWei");
  action.maxPriorityFeePerGasWei = obj.maxPriorityFeePerGasWei;
}
function addSlippage(
  action: { slippageBps?: number },
  obj: Record<string, unknown>,
): void {
  if (obj.slippageBps === undefined) return;
  const slippageBps = requireInteger(obj.slippageBps, "slippageBps");
  if (slippageBps < 0 || slippageBps > 1000)
    throw new Error("slippageBps must be an integer between 0 and 1000");
  action.slippageBps = slippageBps;
}

// Read action.base (default WETH) and resolve the corresponding market (for parse).
function parseBase(obj: Record<string, unknown>): {
  base: string;
  market: MarketConfig;
} {
  const base = typeof obj.base === "string" ? obj.base : "WETH";
  const market = marketFor("uniswap", base);
  if (!market) throw new Error(`uniswap: no market for base "${base}"`);
  return { base, market };
}

const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

// Issue #40: the fee tiers the environment's factory enables. A pool at an unenabled tier reverts on
// chain, which costs the creator a block and the gas — cheap, but a rejection here is cheaper.
const ENABLED_FEE_TIERS = new Set([100, 500, 3000, 10000]);

function parse(obj: Record<string, unknown>): LeafAction | null {
  if (obj.type === "createPool") {
    for (const key of ["tokenA", "tokenB"] as const) {
      if (typeof obj[key] !== "string" || !HEX_ADDRESS_PATTERN.test(obj[key]))
        throw new Error(`${key} must be a 20-byte hex address`);
    }
    const fee = requireInteger(obj.fee, "fee");
    if (!ENABLED_FEE_TIERS.has(fee))
      throw new Error(
        `fee must be one of ${[...ENABLED_FEE_TIERS].join(" / ")} (pips)`,
      );
    requireDecimalString(obj.sqrtPriceX96, "sqrtPriceX96");
    if (
      (obj.tokenA as string).toLowerCase() ===
      (obj.tokenB as string).toLowerCase()
    )
      throw new Error("tokenA and tokenB must differ");
    const action: LeafAction = {
      type: "createPool",
      tokenA: obj.tokenA as string,
      tokenB: obj.tokenB as string,
      fee,
      sqrtPriceX96: obj.sqrtPriceX96,
    };
    addPriorityFee(action, obj);
    return action;
  }
  if (obj.type === "swap") {
    const { base, market } = parseBase(obj);
    if (obj.tokenIn !== market.base && obj.tokenIn !== market.quote)
      throw new Error(`tokenIn must be ${market.base} or ${market.quote}`);
    requireDecimalString(obj.amountIn, "amountIn");
    const action: SwapAction = {
      type: "swap",
      tokenIn: obj.tokenIn,
      amountIn: obj.amountIn,
    };
    if (base !== "WETH") action.base = base;
    addPriorityFee(action, obj);
    addSlippage(action, obj);
    return action;
  }
  if (obj.type === "mintLiquidity") {
    const { base } = parseBase(obj);
    const tickLower = requireInteger(obj.tickLower, "tickLower");
    const tickUpper = requireInteger(obj.tickUpper, "tickUpper");
    const action: LeafAction = {
      type: "mintLiquidity",
      tickLower,
      tickUpper,
      // Backward compatible: the default WETH requires amountWeth/UsdcDesired; a specified base uses amountBase/QuoteDesired.
      amountWethDesired: "0",
      amountUsdcDesired: "0",
    };
    if (base === "WETH") {
      requireDecimalString(obj.amountWethDesired, "amountWethDesired");
      requireDecimalString(obj.amountUsdcDesired, "amountUsdcDesired");
      action.amountWethDesired = obj.amountWethDesired;
      action.amountUsdcDesired = obj.amountUsdcDesired;
    } else {
      requireDecimalString(obj.amountBaseDesired, "amountBaseDesired");
      requireDecimalString(obj.amountQuoteDesired, "amountQuoteDesired");
      action.base = base;
      action.amountBaseDesired = obj.amountBaseDesired;
      action.amountQuoteDesired = obj.amountQuoteDesired;
    }
    addPriorityFee(action, obj);
    addSlippage(action as { slippageBps?: number }, obj);
    return action;
  }
  if (obj.type === "removeLiquidity") {
    requireDecimalString(obj.tokenId, "tokenId");
    requireDecimalString(obj.liquidity, "liquidity");
    const action: LeafAction = {
      type: "removeLiquidity",
      tokenId: obj.tokenId,
      liquidity: obj.liquidity,
    };
    if (typeof obj.base === "string" && obj.base !== "WETH")
      action.base = obj.base;
    if (obj.amountWethMin !== undefined) {
      requireDecimalString(obj.amountWethMin, "amountWethMin");
      action.amountWethMin = obj.amountWethMin;
    }
    if (obj.amountUsdcMin !== undefined) {
      requireDecimalString(obj.amountUsdcMin, "amountUsdcMin");
      action.amountUsdcMin = obj.amountUsdcMin;
    }
    addPriorityFee(action, obj);
    return action;
  }
  if (obj.type === "collectFees") {
    requireDecimalString(obj.tokenId, "tokenId");
    const action: LeafAction = { type: "collectFees", tokenId: obj.tokenId };
    if (typeof obj.base === "string" && obj.base !== "WETH")
      action.base = obj.base;
    addPriorityFee(action, obj);
    return action;
  }
  return null;
}

function validate(
  action: LeafAction,
  obs: AgentObservation,
  balances: BalanceSnapshot,
): ValidationResult {
  const uni = obs.protocols.uniswap;
  if (!uni) return { ok: false, reason: "uniswap not enabled" };
  // Creating a market costs gas and nothing else. Whether the pair is worth having, whether the
  // price is sane and whether anyone will trade it are the creator's problem — that is the decision
  // the capability exists to hand over (issue #40).
  if (action.type === "createPool") {
    if (BigInt(action.sqrtPriceX96) <= 0n)
      return { ok: false, reason: "sqrtPriceX96 must be positive" };
    return { ok: true };
  }
  if (action.type === "swap") {
    const amountIn = BigInt(action.amountIn);
    if (amountIn <= 0n)
      return { ok: false, reason: "amountIn must be positive" };
    const base = action.base ?? "WETH";
    const market = marketFor("uniswap", base);
    if (!market) return { ok: false, reason: `no uniswap market for ${base}` };
    const inIsBase = action.tokenIn === market.base;
    // The balance is the only cap. There is no per-order size limit on any venue any more, so a
    // swap is bounded by what the wallet actually holds and by what the pool gives back for it.
    const balance = inIsBase
      ? (balances.bases?.[market.base] ?? balances.wethWei)
      : stableBalanceOf(balances, TOKENS.USDC.address);
    if (amountIn > balance)
      return { ok: false, reason: "amountIn exceeds balance" };
    return { ok: true };
  }
  if (action.type === "mintLiquidity") {
    const base = action.base ?? "WETH";
    const baseAmt = BigInt(
      action.amountBaseDesired ?? action.amountWethDesired,
    );
    const quoteAmt = BigInt(
      action.amountQuoteDesired ?? action.amountUsdcDesired,
    );
    if (baseAmt <= 0n && quoteAmt <= 0n)
      return { ok: false, reason: "LP desired amount must be positive" };
    if (action.tickLower >= action.tickUpper)
      return { ok: false, reason: "tickLower must be less than tickUpper" };
    if (
      action.tickLower % uni.pool.tickSpacing !== 0 ||
      action.tickUpper % uni.pool.tickSpacing !== 0
    ) {
      return { ok: false, reason: "ticks must align to pool tick spacing" };
    }
    // Balance only -- no LP size cap and no cap on how many positions may be open at once.
    const baseBal = balances.bases?.[base] ?? balances.wethWei;
    if (
      baseAmt > baseBal ||
      quoteAmt > stableBalanceOf(balances, TOKENS.USDC.address)
    )
      return { ok: false, reason: "LP desired amounts exceed balance" };
    return { ok: true };
  }
  const position = uni.positions.find(
    (p) => p.tokenId === (action as { tokenId: string }).tokenId,
  );
  if (!position) return { ok: false, reason: "tokenId is not owned by agent" };
  if (action.type === "removeLiquidity") {
    const liquidity = BigInt(action.liquidity);
    if (liquidity <= 0n)
      return { ok: false, reason: "liquidity must be positive" };
    if (liquidity > BigInt(position.liquidity))
      return {
        ok: false,
        reason: "liquidity exceeds owned position liquidity",
      };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------

export const uniswapAdapter: ProtocolAdapter = {
  id: "uniswap",
  parse,
  bundleable: () => true,
  validate,

  async readState(ctx) {
    return getPoolState(ctx.publicClient);
  },

  async observe(ctx, state, agent, fairPrice): Promise<UniswapObservation> {
    const s = state as UniswapState;
    const fairByBase = ctx.fairPrices ?? { WETH: fairPrice };
    const tickByPool: Record<string, number> = {};
    for (const ms of s.markets)
      tickByPool[legOf(ms.market).pool.toLowerCase()] = ms.tick;
    const positions = await getLpPositions(
      ctx.publicClient,
      agent,
      fairByBase,
      tickByPool,
    );
    const weth =
      s.markets.find((m) => m.market.base === "WETH") ?? s.markets[0];
    const obs: UniswapObservation = {
      pool: {
        pair: "WETH/USDC",
        fee: legOf(weth.market).fee,
        priceUsdcPerWeth: weth.priceUsdcPerWeth,
        tick: weth.tick,
        tickSpacing: weth.tickSpacing,
        ...(weth.liquidity === undefined
          ? {}
          : { liquidity: weth.liquidity.toString() }),
      },
      positions,
    };
    const extra: Record<string, UniswapMarketObservation> = {};
    for (const ms of s.markets) {
      if (ms.market.base === "WETH") continue;
      extra[ms.market.key] = {
        pair: ms.market.key,
        fee: legOf(ms.market).fee,
        priceUsdcPerWeth: ms.priceUsdcPerWeth,
        tick: ms.tick,
        tickSpacing: ms.tickSpacing,
        ...(ms.liquidity === undefined
          ? {}
          : { liquidity: ms.liquidity.toString() }),
      };
    }
    if (Object.keys(extra).length > 0) obs.markets = extra;
    return obs;
  },

  async buildTxs(ctx, owner, action): Promise<BuiltTx[]> {
    if (action.type === "createPool") {
      // createAndInitializePoolIfNecessary on the position manager, not the raw factory: it creates
      // and initializes in one call, and it is idempotent, so a creator racing another agent for the
      // same pair does not lose the block to a revert. Liquidity is a separate decision and comes
      // from mintLiquidity — a pool with no reserves is discoverable and useless, which is exactly
      // what a creator wants for the one block before it seeds.
      const [token0, token1] =
        action.tokenA.toLowerCase() < action.tokenB.toLowerCase()
          ? [action.tokenA as Address, action.tokenB as Address]
          : [action.tokenB as Address, action.tokenA as Address];
      return [
        {
          to: UNISWAP.nonfungiblePositionManager,
          data: encodeFunctionData({
            abi: nonfungiblePositionManagerAbi,
            functionName: "createAndInitializePoolIfNecessary",
            args: [token0, token1, action.fee, BigInt(action.sqrtPriceX96)],
          }),
        },
      ];
    }
    if (action.type === "swap") {
      const market = resolveMarket("uniswap", action as SwapAction);
      const slippageBps = (action as SwapAction).slippageBps ?? 50;
      const data = await buildSwapData(
        ctx.publicClient,
        owner,
        market,
        action as SwapAction,
        slippageBps,
      );
      return [{ to: UNISWAP.swapRouter, data }];
    }
    const market = resolveMarket("uniswap", action as { base?: TokenSymbol });
    const slippageBps =
      action.type === "mintLiquidity" ? (action.slippageBps ?? 50) : 0;
    const data = await buildLpActionData(
      ctx.publicClient,
      owner,
      market,
      action,
      slippageBps,
    );
    return [{ to: UNISWAP.nonfungiblePositionManager, data }];
  },

  async valueUsdc(ctx, agent, _state, fairPrice): Promise<number> {
    const fairByBase = ctx.fairPrices ?? { WETH: fairPrice };
    const positions = await getLpPositions(ctx.publicClient, agent, fairByBase);
    return positions.reduce((sum, p) => sum + p.valueUsdc, 0);
  },

  // Historical LP valuation, staged so the scorer can batch each stage across every adapter and
  // agent (issue #41). Stages: registered ticks + NFT counts -> tokenIds -> positions -> pools for
  // positions outside MARKET_LEGS -> their ticks -> fee growth. Stages after the first are skipped
  // entirely when nothing needs them.
  async *valueAtBlock(ctx) {
    const zero = (): Record<string, AgentProtocolValue> => {
      const out: Record<string, AgentProtocolValue> = {};
      for (const a of ctx.agents)
        out[a.id] = { valueUsdc: 0, liquidatableValueUsdc: 0, unpriced: [] };
      return out;
    };

    const markets = marketsFor("uniswap");
    const stage1 = yield [
      ...markets.map((m) => ({
        address: legOf(m).pool,
        abi: poolAbi,
        functionName: "slot0",
      })),
      ...ctx.agents.map((a) => ({
        address: UNISWAP.nonfungiblePositionManager,
        abi: nonfungiblePositionManagerAbi,
        functionName: "balanceOf",
        args: [a.address],
      })),
    ];

    const tickByPool: Record<string, number> = {};
    markets.forEach((m, i) => {
      const slot0 = stage1[i] as readonly [bigint, number] | undefined;
      if (slot0) tickByPool[legOf(m).pool.toLowerCase()] = Number(slot0[1]);
    });
    const owners: Array<{ agentId: string; owner: Address; index: bigint }> =
      [];
    // An unreadable NFT count makes every position the agent holds disappear at once, which reads
    // exactly like having closed them all — report it rather than treating it as "holds none" (#44).
    const countFailed: string[] = [];
    ctx.agents.forEach((agent, i) => {
      const raw = stage1[markets.length + i];
      if (typeof raw !== "bigint") {
        countFailed.push(agent.id);
        return;
      }
      for (let k = 0n; k < raw; k++)
        owners.push({ agentId: agent.id, owner: agent.address, index: k });
    });
    const unreadableCount = (out: Record<string, AgentProtocolValue>) => {
      for (const agentId of countFailed) {
        out[agentId].unpriced.push({
          source: "uniswap-lp",
          amountRaw: "",
          reason: "read-failed",
          read: "NonfungiblePositionManager.balanceOf",
        });
      }
      return out;
    };
    if (owners.length === 0) return unreadableCount(zero());

    const tokenIds = yield owners.map(({ owner, index }) => ({
      address: UNISWAP.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "tokenOfOwnerByIndex",
      args: [owner, index],
    }));
    const positions = yield tokenIds.map((tokenId) => ({
      address: UNISWAP.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "positions",
      args: [tokenId ?? 0n],
    }));

    // Pools outside MARKET_LEGS: resolve through the factory, then read their ticks.
    const poolByKey: Record<string, Address> = {};
    const wanted = new Map<string, [Address, Address, number]>();
    for (const raw of positions) {
      if (!raw) continue;
      const [, , token0, token1, fee] = raw as PositionTuple;
      if (registeredPoolFor(token0, token1, fee)) continue;
      wanted.set(positionPoolKey(token0, token1, fee), [token0, token1, fee]);
    }
    if (wanted.size > 0) {
      const factory = await uniswapFactory(ctx.publicClient);
      if (factory) {
        const keys = [...wanted.keys()];
        const addresses = yield keys.map((k) => ({
          address: factory,
          abi: uniswapV3FactoryAbi,
          functionName: "getPool",
          args: wanted.get(k) as [Address, Address, number],
        }));
        const discovered: Address[] = [];
        keys.forEach((k, i) => {
          const pool = addresses[i] as Address | undefined;
          if (!pool || pool.toLowerCase() === ZERO_ADDRESS) return;
          poolByKey[k] = pool;
          discovered.push(pool);
        });
        if (discovered.length > 0) {
          const slots = yield discovered.map((pool) => ({
            address: pool,
            abi: poolAbi,
            functionName: "slot0",
          }));
          discovered.forEach((pool, i) => {
            const slot0 = slots[i] as readonly [bigint, number] | undefined;
            if (slot0) tickByPool[pool.toLowerCase()] = Number(slot0[1]);
          });
        }
      }
    }

    // Fee growth for every boundary an owned position touches (issue #21).
    const feePools = new Map<string, { address: Address; ticks: number[] }>();
    for (const raw of positions) {
      if (!raw) continue;
      const [, , token0, token1, fee, tickLower, tickUpper, liquidity] =
        raw as PositionTuple;
      if (liquidity <= 0n) continue;
      const pool =
        registeredPoolFor(token0, token1, fee) ??
        poolByKey[positionPoolKey(token0, token1, fee)];
      if (!pool) continue;
      const key = pool.toLowerCase();
      const entry = feePools.get(key) ?? { address: pool, ticks: [] };
      for (const t of [tickLower, tickUpper])
        if (!entry.ticks.includes(t)) entry.ticks.push(t);
      feePools.set(key, entry);
    }
    const feeGrowthByPool: Record<string, PoolFeeGrowth> = {};
    if (feePools.size > 0) {
      const layout: Array<{ key: string; ticks: number[]; base: number }> = [];
      const reads: Array<{
        address: Address;
        abi: unknown;
        functionName: string;
        args?: readonly unknown[];
      }> = [];
      for (const [key, { address, ticks }] of feePools) {
        layout.push({ key, ticks, base: reads.length });
        reads.push(
          { address, abi: poolAbi, functionName: "feeGrowthGlobal0X128" },
          { address, abi: poolAbi, functionName: "feeGrowthGlobal1X128" },
          ...ticks.map((t) => ({
            address,
            abi: poolAbi,
            functionName: "ticks",
            args: [t],
          })),
        );
      }
      const results = yield reads as never;
      for (const { key, ticks, base } of layout) {
        const global0 = results[base];
        const global1 = results[base + 1];
        if (typeof global0 !== "bigint" || typeof global1 !== "bigint")
          continue;
        const outsideByTick: Record<number, readonly [bigint, bigint]> = {};
        ticks.forEach((t, i) => {
          const entry = tickFeeGrowthEntry(
            results[base + 2 + i] as Parameters<typeof tickFeeGrowthEntry>[0],
          );
          if (entry) outsideByTick[t] = entry;
        });
        feeGrowthByPool[key] = {
          feeGrowthGlobal0X128: global0,
          feeGrowthGlobal1X128: global1,
          outsideByTick,
        };
      }
    }

    const fairByBase = ctx.fairByBase();
    const stablePrices = ctx.stablePrices();
    const out = unreadableCount(zero());
    owners.forEach(({ agentId, index }, j) => {
      const raw = positions[j];
      if (!raw || tokenIds[j] === undefined) {
        // The position is known to exist (it was counted) but could not be read, so its value is
        // unknown rather than zero (issue #44).
        out[agentId].unpriced.push({
          source: `uniswap-lp#${index}`,
          amountRaw: "",
          reason: "read-failed",
          read:
            tokenIds[j] === undefined
              ? "NonfungiblePositionManager.tokenOfOwnerByIndex"
              : "NonfungiblePositionManager.positions",
        });
        return;
      }
      const valuation = lpPositionValuation(raw as PositionTuple, {
        tickByPool,
        fairByBase,
        stablePrices,
        poolByKey,
        feeGrowthByPool,
      });
      const agent = out[agentId];
      agent.valueUsdc += valuation.valueUsdc;
      // Burning liquidity returns the position's tokens plus its fees at no cost, so the mark is
      // already what an exit realizes.
      agent.liquidatableValueUsdc += valuation.valueUsdc;
      for (const h of valuation.unpriced)
        agent.unpriced.push({ ...h, source: `uniswap-lp:${tokenIds[j]}` });
    });
    return out;
  },

  // The position manager is an ERC-721 and its positions are valued by valueAtBlock.
  async accountedTokens(): Promise<Address[]> {
    return [UNISWAP.nonfungiblePositionManager];
  },

  async setupWallet(): Promise<BuiltTx[]> {
    const txs: BuiltTx[] = [];
    const seen = new Set<string>();
    const approveBoth = (token: Address) => {
      const key = token.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      txs.push(
        approveTx(token, UNISWAP.swapRouter),
        approveTx(token, UNISWAP.nonfungiblePositionManager),
      );
    };
    for (const m of marketsFor("uniswap")) {
      approveBoth(tokenInfo(m.base).address);
      approveBoth(tokenInfo(m.quote).address);
    }
    return txs;
  },
};

// Build a single approve BuiltTx (reused by balancer/curve/aave/gmx setupWallet too)
export function approveTx(token: Address, spender: Address): BuiltTx {
  return {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, maxUint256],
    }),
  };
}

export { wethAbi };
