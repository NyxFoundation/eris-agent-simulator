import test from "node:test";
import assert from "node:assert/strict";
import { scaleLiquidity } from "../core/src/realtime/liquidity.js";

// The trapezoid's envelope is a float and depth is a uint128, so the conversion between them is
// where a liquidityPull (issue #52) could quietly become non-reproducible: two runs of the same
// scenario have to withdraw the same depth on the same block.

const SEEDED = 3_141_592_653_589_793_238n;

test("the seeded depth is returned exactly when nothing is being pulled", () => {
  // Not "close to": the window has to end with the venue exactly where it started, or the next
  // scenario inherits a drained pool.
  assert.equal(scaleLiquidity(SEEDED, 1), SEEDED);
  assert.equal(scaleLiquidity(SEEDED, 1.0000001), SEEDED);
});

test("a pull scales the depth by the multiplier", () => {
  assert.equal(scaleLiquidity(SEEDED, 0.5), SEEDED / 2n);
  const quarter = scaleLiquidity(SEEDED, 0.25);
  assert.ok(quarter > SEEDED / 5n && quarter < SEEDED / 3n, `${quarter}`);
});

test("depth never goes negative, whatever the envelope says", () => {
  assert.equal(scaleLiquidity(SEEDED, 0), 0n);
  assert.equal(scaleLiquidity(SEEDED, -0.5), 0n);
});

test("a given multiplier pins one exact target", () => {
  // Fixed expected values, not f(x) === f(x): the point is that two runs of the same scenario
  // withdraw the same depth, which a self-comparison would assert for any implementation.
  assert.equal(scaleLiquidity(SEEDED, 0.75), 2356194490192344928n);
  // A repeating decimal, to pin the 1e9 grid itself: round(0.8766666666666667 * 1e9) = 876666667.
  assert.equal(scaleLiquidity(SEEDED, 1 - 0.37 / 3), 2754129560694249623n);
  assert.equal(scaleLiquidity(10n ** 18n, 0.123456789), 123456789000000000n);
});

test("scaling is monotonic across a trapezoid's envelope", () => {
  let previous = 0n;
  for (const mult of [0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
    const target = scaleLiquidity(SEEDED, mult);
    assert.ok(target > previous, `not increasing at ${mult}`);
    previous = target;
  }
  assert.ok(previous < SEEDED);
});

test("precision holds at uint128 scale", () => {
  // A seeded pool's liquidity runs to ~1e21; the 1e9 grid still resolves a 1% pull there.
  const big = 10n ** 21n;
  assert.equal(scaleLiquidity(big, 0.99), (big * 99n) / 100n);
});
