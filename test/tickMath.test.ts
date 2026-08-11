import test from "node:test";
import assert from "node:assert/strict";
import {
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  MAX_TICK,
  MIN_TICK,
} from "../core/src/realtime/tickMath.js";

// The liquidityPull stress event (issue #52) restores depth through increaseLiquidity, which takes
// token amounts and derives the liquidity from them. If this arithmetic is off, the decay leg puts
// back the wrong amount of depth every block and the venue never returns to where it started -- a
// failure that would only show up as a slow drift in a long run, so it is pinned down here instead.

const Q96 = 1n << 96n;

test("getSqrtRatioAtTick matches the reference contract at its fixed points", () => {
  assert.equal(getSqrtRatioAtTick(0), Q96);
  // TickMath.MIN_SQRT_RATIO / MAX_SQRT_RATIO
  assert.equal(getSqrtRatioAtTick(MIN_TICK), 4295128739n);
  assert.equal(
    getSqrtRatioAtTick(MAX_TICK),
    1461446703485210103287273052203988822378723970342n,
  );
});

test("getSqrtRatioAtTick is monotonic and symmetric about tick 0", () => {
  let previous = 0n;
  for (const tick of [-887220, -100000, -60, 0, 60, 100000, 887220]) {
    const ratio = getSqrtRatioAtTick(tick);
    assert.ok(ratio > previous, `not increasing at ${tick}`);
    previous = ratio;
  }
  // sqrt(1.0001^-t) == 1/sqrt(1.0001^t): the product is 2^192 to within rounding.
  for (const tick of [60, 4200, 100000]) {
    const product = getSqrtRatioAtTick(tick) * getSqrtRatioAtTick(-tick);
    const expected = Q96 * Q96;
    const diff = product > expected ? product - expected : expected - product;
    assert.ok(
      (diff * 1_000_000n) / expected === 0n,
      `tick ${tick}: off by ${(diff * 1_000_000n) / expected} ppm`,
    );
  }
});

test("getSqrtRatioAtTick rejects ticks a position cannot hold", () => {
  assert.throws(() => getSqrtRatioAtTick(MAX_TICK + 1), /out of range/);
  assert.throws(() => getSqrtRatioAtTick(MIN_TICK - 1), /out of range/);
  assert.throws(() => getSqrtRatioAtTick(1.5), /must be an integer/);
});

test("amounts round-trip: what is deposited is never less than what was withdrawn", () => {
  // The full-range position the deployer seeds (tick spacing 60).
  const lower = getSqrtRatioAtTick(-887220);
  const upper = getSqrtRatioAtTick(887220);
  const liquidity = 12_345_678_901_234_567_890n;

  for (const tick of [-200000, -60, 0, 60, 200000]) {
    const sqrtPrice = getSqrtRatioAtTick(tick);
    const { amount0, amount1 } = getAmountsForLiquidity(
      sqrtPrice,
      lower,
      upper,
      liquidity,
    );
    const restored = getLiquidityForAmounts(
      sqrtPrice,
      lower,
      upper,
      amount0,
      amount1,
    );
    // Rounded up, so the restore never silently returns a thinner pool...
    assert.ok(
      restored >= liquidity,
      `tick ${tick}: restored ${restored} < ${liquidity}`,
    );
    // ...and the overshoot is rounding, not a scale error.
    assert.ok(
      restored - liquidity < 1_000n,
      `tick ${tick}: overshoot ${restored - liquidity}`,
    );
  }
});

test("amounts are one-sided when the price is outside the range", () => {
  const lower = getSqrtRatioAtTick(-1000);
  const upper = getSqrtRatioAtTick(1000);
  const liquidity = 10n ** 18n;

  const below = getAmountsForLiquidity(
    getSqrtRatioAtTick(-2000),
    lower,
    upper,
    liquidity,
  );
  assert.equal(below.amount1, 0n);
  assert.ok(below.amount0 > 0n);

  const above = getAmountsForLiquidity(
    getSqrtRatioAtTick(2000),
    lower,
    upper,
    liquidity,
  );
  assert.equal(above.amount0, 0n);
  assert.ok(above.amount1 > 0n);
});

test("a position at the middle of its range holds both sides", () => {
  const lower = getSqrtRatioAtTick(-1000);
  const upper = getSqrtRatioAtTick(1000);
  const { amount0, amount1 } = getAmountsForLiquidity(
    Q96,
    lower,
    upper,
    10n ** 18n,
  );
  assert.ok(amount0 > 0n && amount1 > 0n);
  // Symmetric range at tick 0: both sides carry the same notional to within rounding.
  const diff = amount0 > amount1 ? amount0 - amount1 : amount1 - amount0;
  assert.ok((diff * 10_000n) / amount0 < 10n, `${amount0} vs ${amount1}`);
});
