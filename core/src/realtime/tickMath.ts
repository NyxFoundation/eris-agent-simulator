// Uniswap V3 TickMath / LiquidityAmounts, ported to TypeScript for the liquidityPull stress event
// (issue #52).
//
// Why this exists: `decreaseLiquidity` takes a liquidity amount, but `increaseLiquidity` takes token
// amounts and derives the liquidity from them. Putting back exactly the depth that was withdrawn
// therefore needs the same liquidity -> amounts conversion the periphery does on-chain. Overshooting
// leaves the venue deeper than it started (the next scenario inherits it); undershooting leaves the
// crash regime permanently thinner than its calibration.
//
// The arithmetic is a direct transcription of the reference contracts. It is exercised against
// on-chain values in test/tickMath.test.ts rather than trusted by inspection.

const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

// TickMath.getSqrtRatioAtTick: sqrt(1.0001^tick) * 2^96.
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick))
    throw new Error(`tick must be an integer: ${tick}`);
  if (tick < MIN_TICK || tick > MAX_TICK)
    throw new Error(`tick out of range: ${tick}`);
  const absTick = BigInt(Math.abs(tick));

  let ratio =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const step = (mask: bigint, constant: bigint): void => {
    if ((absTick & mask) !== 0n) ratio = (ratio * constant) >> 128n;
  };
  step(0x2n, 0xfff97272373d413259a46990580e213an);
  step(0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn);
  step(0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
  step(0x10n, 0xffcb9843d60f6159c9db58835c926644n);
  step(0x20n, 0xff973b41fa98c081472e6896dfb254c0n);
  step(0x40n, 0xff2ea16466c96a3843ec78b326b52861n);
  step(0x80n, 0xfe5dee046a99a2a811c461f1969c3053n);
  step(0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
  step(0x200n, 0xf987a7253ac413176f2b074cf7815e54n);
  step(0x400n, 0xf3392b0822b70005940c7a398e4b70f3n);
  step(0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n);
  step(0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n);
  step(0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n);
  step(0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n);
  step(0x8000n, 0x31be135f97d08fd981231505542fcfa6n);
  step(0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
  step(0x20000n, 0x5d6af8dedb81196699c329225ee604n);
  step(0x40000n, 0x2216e584f5fa1ea926041bedfe98n);
  step(0x80000n, 0x48a170391f7dc42444e8fa2n);

  if (tick > 0) ratio = MAX_UINT256 / ratio;

  // Round up when shifting from Q128.128 down to Q64.96.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b) / denominator;
}

function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const product = a * b;
  const result = product / denominator;
  return product % denominator === 0n ? result : result + 1n;
}

function divRoundingUp(a: bigint, b: bigint): bigint {
  return a % b === 0n ? a / b : a / b + 1n;
}

// SqrtPriceMath.getAmount0Delta
export function getAmount0Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const [lo, hi] =
    sqrtRatioAX96 > sqrtRatioBX96
      ? [sqrtRatioBX96, sqrtRatioAX96]
      : [sqrtRatioAX96, sqrtRatioBX96];
  const numerator1 = liquidity << 96n;
  const numerator2 = hi - lo;
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, hi), lo)
    : mulDiv(numerator1, numerator2, hi) / lo;
}

// SqrtPriceMath.getAmount1Delta
export function getAmount1Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const [lo, hi] =
    sqrtRatioAX96 > sqrtRatioBX96
      ? [sqrtRatioBX96, sqrtRatioAX96]
      : [sqrtRatioAX96, sqrtRatioBX96];
  return roundUp
    ? mulDivRoundingUp(liquidity, hi - lo, Q96)
    : mulDiv(liquidity, hi - lo, Q96);
}

// LiquidityAmounts.getAmountsForLiquidity. Rounded up, because these amounts are fed back into
// increaseLiquidity, which recomputes the liquidity from them and takes the minimum of the two
// sides -- rounding down there would return slightly less depth than was taken out, every block of
// the decay leg.
export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  const [lower, upper] =
    sqrtRatioAX96 > sqrtRatioBX96
      ? [sqrtRatioBX96, sqrtRatioAX96]
      : [sqrtRatioAX96, sqrtRatioBX96];
  if (sqrtPriceX96 <= lower) {
    return {
      amount0: getAmount0Delta(lower, upper, liquidity, true),
      amount1: 0n,
    };
  }
  if (sqrtPriceX96 < upper) {
    return {
      amount0: getAmount0Delta(sqrtPriceX96, upper, liquidity, true),
      amount1: getAmount1Delta(lower, sqrtPriceX96, liquidity, true),
    };
  }
  return {
    amount0: 0n,
    amount1: getAmount1Delta(lower, upper, liquidity, true),
  };
}

// LiquidityAmounts.getLiquidityForAmounts -- the direction increaseLiquidity actually takes. Used to
// verify a round trip in tests, and to sanity-check what a set of amounts will really deposit.
export function getLiquidityForAmounts(
  sqrtPriceX96: bigint,
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  const [lower, upper] =
    sqrtRatioAX96 > sqrtRatioBX96
      ? [sqrtRatioBX96, sqrtRatioAX96]
      : [sqrtRatioAX96, sqrtRatioBX96];
  const forAmount0 = (sqrtLo: bigint, sqrtHi: bigint, amount: bigint): bigint =>
    mulDiv(amount, mulDiv(sqrtLo, sqrtHi, Q96), sqrtHi - sqrtLo);
  const forAmount1 = (sqrtLo: bigint, sqrtHi: bigint, amount: bigint): bigint =>
    mulDiv(amount, Q96, sqrtHi - sqrtLo);

  if (sqrtPriceX96 <= lower) return forAmount0(lower, upper, amount0);
  if (sqrtPriceX96 < upper) {
    const l0 = forAmount0(sqrtPriceX96, upper, amount0);
    const l1 = forAmount1(lower, sqrtPriceX96, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return forAmount1(lower, upper, amount1);
}
