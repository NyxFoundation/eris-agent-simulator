// Balancer BPT / Curve LP-token valuation (issue #41). These holdings used to contribute nothing to
// an agent's value, so providing liquidity on those venues was recorded as losing the stake.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { poolShareValueUsdc, tokenAmountUsd } from "@eris/sdk/valuation.js";
import { bptAddressOf } from "@eris/sdk/protocols/balancer.js";
import { TOKENS, USDC_VARIANTS } from "@eris/sdk/constants.js";

const WETH = TOKENS.WETH.address;
const USDC = TOKENS.USDC.address;
const UNKNOWN = "0x00000000000000000000000000000000000000ff" as Address;
const FAIR = { WETH: 2000 };

// 100 WETH + 200,000 USDC, 1000 LP tokens outstanding.
const RESERVES = {
  tokens: [WETH, USDC],
  balances: [100n * 10n ** 18n, 200_000n * 10n ** 6n],
  totalSupply: 1000n * 10n ** 18n,
};

test("tokenAmountUsd prices stables at $1 and bases at the fair price", () => {
  assert.equal(tokenAmountUsd(USDC, 250_000_000n, FAIR), 250);
  assert.equal(tokenAmountUsd(WETH, 10n ** 18n, FAIR), 2000);
});

test("tokenAmountUsd returns undefined for tokens it cannot price", () => {
  // Outside the registry: unpriceable, which is not the same as worthless.
  assert.equal(tokenAmountUsd(UNKNOWN, 10n ** 18n, FAIR), undefined);
  // In the registry but with no fair price for the run.
  assert.equal(tokenAmountUsd(WETH, 10n ** 18n, {}), undefined);
});

test("poolShareValueUsdc values an LP balance as its proportional share", () => {
  // 1% of the pool = 1 WETH + 2,000 USDC = $4,000 at $2,000/WETH.
  const share = poolShareValueUsdc(RESERVES, 10n * 10n ** 18n, FAIR);
  assert.ok(Math.abs(share.valueUsdc - 4000) < 1e-9);
  assert.deepEqual(share.unpriced, []);
});

test("poolShareValueUsdc scales linearly with the holding", () => {
  const one = poolShareValueUsdc(RESERVES, 10n * 10n ** 18n, FAIR).valueUsdc;
  const ten = poolShareValueUsdc(RESERVES, 100n * 10n ** 18n, FAIR).valueUsdc;
  assert.ok(Math.abs(ten - one * 10) < 1e-6);
});

test("poolShareValueUsdc is zero for an empty holding or an empty pool", () => {
  assert.deepEqual(poolShareValueUsdc(RESERVES, 0n, FAIR), {
    valueUsdc: 0,
    unpriced: [],
  });
  assert.deepEqual(
    poolShareValueUsdc({ ...RESERVES, totalSupply: 0n }, 10n ** 18n, FAIR),
    { valueUsdc: 0, unpriced: [] },
  );
});

test("poolShareValueUsdc reports reserve tokens it cannot price", () => {
  const reserves = {
    tokens: [WETH, UNKNOWN],
    balances: [100n * 10n ** 18n, 500n * 10n ** 18n],
    totalSupply: 1000n * 10n ** 18n,
  };
  const share = poolShareValueUsdc(reserves, 10n * 10n ** 18n, FAIR);
  // The WETH leg still counts: 1% of 100 WETH at $2,000.
  assert.ok(Math.abs(share.valueUsdc - 2000) < 1e-9);
  assert.deepEqual(share.unpriced, [
    { token: UNKNOWN, amountRaw: (5n * 10n ** 18n).toString() },
  ]);
});

test("bptAddressOf takes the pool address from the leading 20 bytes of the poolId", () => {
  assert.equal(
    bptAddressOf(
      "0x3b106b7ae88c3f8869b5221d2bbae398afc26737000100000000000000000534",
    ),
    "0x3b106b7ae88c3f8869b5221d2bbae398afc26737",
  );
});

// The Arbitrum fork's registry is WETH/USDC only, but the deep Balancer and Curve pools hold USDC.e
// and USDT. Leaving them unpriced cost a BPT holder roughly a third of their value.
test("tokenAmountUsd prices stable variants the registry does not name", () => {
  for (const variant of [USDC_VARIANTS.bridged, USDC_VARIANTS.usdt]) {
    assert.equal(tokenAmountUsd(variant, 250_000_000n, FAIR), 250);
  }
});

test("poolShareValueUsdc counts a stable-variant reserve leg", () => {
  // A 33/33/34-style pool: WETH + native USDC + USDT. The USDT leg must not go missing.
  const reserves = {
    tokens: [WETH, USDC, USDC_VARIANTS.usdt],
    balances: [100n * 10n ** 18n, 200_000n * 10n ** 6n, 200_000n * 10n ** 6n],
    totalSupply: 1000n * 10n ** 18n,
  };
  const share = poolShareValueUsdc(reserves, 10n * 10n ** 18n, FAIR);
  // 1% of 100 WETH at $2,000 + 1% of 200k USDC + 1% of 200k USDT.
  assert.ok(Math.abs(share.valueUsdc - (2000 + 2000 + 2000)) < 1e-9);
  assert.deepEqual(share.unpriced, []);
});
