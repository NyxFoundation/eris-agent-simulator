import test from "node:test";
import assert from "node:assert/strict";
import { impliedPrice } from "../sdk/src/discoveredPools.js";

test("impliedPrice: token1 per token0 with decimals removed", () => {
  // 10 WETH (18 dp) against 30,000 USDC (6 dp) -> 3,000 USDC per WETH
  assert.equal(impliedPrice(10n * 10n ** 18n, 18, 30_000n * 10n ** 6n, 6), 3000);
});

test("impliedPrice: an unfunded side is null, not zero or infinity", () => {
  assert.equal(impliedPrice(0n, 18, 30_000n * 10n ** 6n, 6), null);
  assert.equal(impliedPrice(10n * 10n ** 18n, 18, 0n, 6), null);
});
