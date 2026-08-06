// Regression net for Uniswap V3 LP valuation (issues #41 / #21).
//
// A full-run golden is impossible here: ADR 0005 makes tx timing and intra-block ordering
// non-deterministic, so summary.json differs between runs of the same regime. The only place a
// regression net can be stretched is at the function level, so these tests pin the exact behaviour
// of the scoring primitives before they are changed.
//
// Tests marked PINS CURRENT BUG document behaviour that is known to be wrong and is expected to be
// replaced; they exist so that the fix is visible as a diff here rather than as a silent shift in a
// run's numbers.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import {
  liquidityToTokenAmounts,
  lpPositionValueUsdc,
  lpPositionValueUsdcMulti,
} from "@eris/sdk/protocols/uniswap.js";
import { TOKENS, UNISWAP } from "@eris/sdk/constants.js";

// Arbitrum fork defaults (MARKET_LEGS registers uniswap WETH/USDC @ fee 500 only).
const WETH = TOKENS.WETH.address;
const USDC = TOKENS.USDC.address;
const REGISTERED_FEE = UNISWAP.fee; // 500
const POOL = UNISWAP.poolWethUsdc500.toLowerCase();

// WETH(0x82aF) < USDC(0xaf88) on Arbitrum, so token0 = WETH and token1 = USDC.
const FAIR_WETH = 2000;
// 1.0001^tick == USDC units per WETH wei, so ~$2000/WETH sits near tick -200350.
const TICK_IN_RANGE = -200350;
const TICK_LOWER = -201000;
const TICK_UPPER = -199000;
const LIQUIDITY = 700_000_000_000_000n; // ~1.04 WETH + ~1000 USDC at TICK_IN_RANGE

type PositionTuple = Parameters<typeof lpPositionValueUsdc>[0];

function position(overrides: {
  token0?: Address;
  token1?: Address;
  fee?: number;
  tickLower?: number;
  tickUpper?: number;
  liquidity?: bigint;
  feeGrowthInside0LastX128?: bigint;
  feeGrowthInside1LastX128?: bigint;
  tokensOwed0?: bigint;
  tokensOwed1?: bigint;
}): PositionTuple {
  return [
    0n, // nonce
    "0x0000000000000000000000000000000000000000" as Address, // operator
    overrides.token0 ?? WETH,
    overrides.token1 ?? USDC,
    overrides.fee ?? REGISTERED_FEE,
    overrides.tickLower ?? TICK_LOWER,
    overrides.tickUpper ?? TICK_UPPER,
    overrides.liquidity ?? LIQUIDITY,
    overrides.feeGrowthInside0LastX128 ?? 0n,
    overrides.feeGrowthInside1LastX128 ?? 0n,
    overrides.tokensOwed0 ?? 0n,
    overrides.tokensOwed1 ?? 0n,
  ] as PositionTuple;
}

const tickByPool = { [POOL]: TICK_IN_RANGE };
const fairByBase = { WETH: FAIR_WETH };

// Independent expectation: principal is token1 (USDC) + token0 (WETH) marked at the fair price.
function expectedPrincipalUsdc(tick: number): number {
  const { amount0, amount1 } = liquidityToTokenAmounts({
    liquidity: LIQUIDITY,
    tick,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
  });
  return Number(amount1) / 1e6 + (Number(amount0) / 1e18) * FAIR_WETH;
}

test("lpPositionValueUsdcMulti values an in-range position in a registered market", () => {
  const value = lpPositionValueUsdcMulti(position({}), tickByPool, fairByBase);
  // Sanity band independent of the implementation: ~1.04 WETH + ~1000 USDC at $2000.
  assert.ok(
    value > 2500 && value < 3700,
    `expected ~$3000 of LP value, got ${value}`,
  );
  assert.ok(Math.abs(value - expectedPrincipalUsdc(TICK_IN_RANGE)) < 1e-6);
});

test("lpPositionValueUsdcMulti adds tokensOwed on top of principal", () => {
  const owed = lpPositionValueUsdcMulti(
    position({ tokensOwed0: 10n ** 17n, tokensOwed1: 25_000_000n }), // 0.1 WETH + 25 USDC
    tickByPool,
    fairByBase,
  );
  const bare = lpPositionValueUsdcMulti(position({}), tickByPool, fairByBase);
  assert.ok(Math.abs(owed - bare - (0.1 * FAIR_WETH + 25)) < 1e-6);
});

test("lpPositionValueUsdcMulti values an out-of-range position on one side only", () => {
  // Pool has moved above the range: the position is entirely token1 (USDC).
  const aboveTick = { [POOL]: TICK_UPPER + 500 };
  const value = lpPositionValueUsdcMulti(position({}), aboveTick, fairByBase);
  assert.ok(Math.abs(value - expectedPrincipalUsdc(TICK_UPPER + 500)) < 1e-6);
  const { amount0 } = liquidityToTokenAmounts({
    liquidity: LIQUIDITY,
    tick: TICK_UPPER + 500,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
  });
  assert.equal(amount0, 0n, "above range holds no token0");

  // Pool has moved below the range: entirely token0 (WETH).
  const belowTick = { [POOL]: TICK_LOWER - 500 };
  const below = lpPositionValueUsdcMulti(position({}), belowTick, fairByBase);
  assert.ok(Math.abs(below - expectedPrincipalUsdc(TICK_LOWER - 500)) < 1e-6);
});

test("lpPositionValueUsdcMulti falls back to tick 0 when the pool tick is unknown", () => {
  // tick 0 is far above the WETH/USDC range, so the position reads as all-USDC. This is a latent
  // trap (a missing tick silently mis-values rather than failing) but is pinned as current behaviour.
  const value = lpPositionValueUsdcMulti(position({}), {}, fairByBase);
  assert.ok(Math.abs(value - expectedPrincipalUsdc(0)) < 1e-6);
});

test("PINS CURRENT BUG (#41): a position in an unregistered pool is valued at exactly zero", () => {
  // Same token pair, different fee tier -> not in MARKET_LEGS -> scored as a total loss.
  const otherFeeTier = lpPositionValueUsdcMulti(
    position({ fee: 3000 }),
    {
      ...tickByPool,
      "0x0000000000000000000000000000000000000dead": TICK_IN_RANGE,
    },
    fairByBase,
  );
  assert.equal(otherFeeTier, 0);

  // Unregistered token pair likewise.
  const unknownPair = lpPositionValueUsdcMulti(
    position({
      token1: "0x0000000000000000000000000000000000000001" as Address,
    }),
    tickByPool,
    fairByBase,
  );
  assert.equal(unknownPair, 0);
});

test("PINS CURRENT BUG (#21): feeGrowthInside checkpoints in the position tuple are ignored", () => {
  // A position that has accrued fees since its last checkpoint carries a non-zero
  // feeGrowthInside*LastX128 but zero tokensOwed until poke/collect. Uncollected fees are invisible.
  const accrued = lpPositionValueUsdcMulti(
    position({
      feeGrowthInside0LastX128: 12_345_678_901_234_567_890n,
      feeGrowthInside1LastX128: 98_765_432_109_876_543_210n,
    }),
    tickByPool,
    fairByBase,
  );
  const fresh = lpPositionValueUsdcMulti(position({}), tickByPool, fairByBase);
  assert.equal(accrued, fresh);
});

test("lpPositionValueUsdc (single-price variant) matches the multi variant for WETH", () => {
  const single = lpPositionValueUsdc(position({}), TICK_IN_RANGE, FAIR_WETH);
  const multi = lpPositionValueUsdcMulti(position({}), tickByPool, fairByBase);
  assert.ok(Math.abs(single - multi) < 1e-9);
});
