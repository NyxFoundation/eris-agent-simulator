import test from "node:test";
import assert from "node:assert/strict";
import { liquidityToTokenAmounts } from "@eris/sdk/protocols/uniswap.js";
import { getSqrtRatioAtTick } from "@eris/sdk/tickMath.js";

test("liquidityToTokenAmounts returns token0 below range", () => {
  const result = liquidityToTokenAmounts({ liquidity: 1_000_000n, sqrtPriceX96: getSqrtRatioAtTick(-20), tickLower: -10, tickUpper: 10 });
  assert.ok(result.amount0 > 0n);
  assert.equal(result.amount1, 0n);
});

test("liquidityToTokenAmounts returns both tokens inside range", () => {
  const result = liquidityToTokenAmounts({ liquidity: 1_000_000n, sqrtPriceX96: getSqrtRatioAtTick(0), tickLower: -10, tickUpper: 10 });
  assert.ok(result.amount0 > 0n);
  assert.ok(result.amount1 > 0n);
});

test("liquidityToTokenAmounts returns token1 above range", () => {
  const result = liquidityToTokenAmounts({ liquidity: 1_000_000n, sqrtPriceX96: getSqrtRatioAtTick(20), tickLower: -10, tickUpper: 10 });
  assert.equal(result.amount0, 0n);
  assert.ok(result.amount1 > 0n);
});
