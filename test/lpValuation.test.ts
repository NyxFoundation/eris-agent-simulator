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
  feeGrowthInsideX128,
  liquidityToTokenAmounts,
  lpPositionValueUsdc,
  lpPositionValueUsdcMulti,
  tickFeeGrowthEntry,
  uncollectedFees,
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

// ---------------------------------------------------------------------------
// Uncollected fees (#21)
// ---------------------------------------------------------------------------

const Q128 = 1n << 128n;
const U256 = 1n << 256n;
// Independent restatement of the pool's unchecked subtraction, so the expectations below do not
// borrow the implementation's own helper.
const wrapSub = (a: bigint, b: bigint) => (((a - b) % U256) + U256) % U256;

test("feeGrowthInsideX128 subtracts both sides when the tick is inside the range", () => {
  const inside = feeGrowthInsideX128({
    tickCurrent: TICK_IN_RANGE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    feeGrowthGlobalX128: 1000n,
    feeGrowthOutsideLowerX128: 100n,
    feeGrowthOutsideUpperX128: 250n,
  });
  assert.equal(inside, 650n);
});

test("feeGrowthInsideX128 flips the below/above terms when the tick leaves the range", () => {
  const shared = {
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    feeGrowthGlobalX128: 1000n,
    feeGrowthOutsideLowerX128: 100n,
    feeGrowthOutsideUpperX128: 250n,
  };
  // Below the range: below = global - outsideLower, above = outsideUpper.
  assert.equal(
    feeGrowthInsideX128({ ...shared, tickCurrent: TICK_LOWER - 1 }),
    wrapSub(1000n - (1000n - 100n), 250n),
  );
  // At/above the upper tick: below = outsideLower, above = global - outsideUpper.
  assert.equal(
    feeGrowthInsideX128({ ...shared, tickCurrent: TICK_UPPER }),
    wrapSub(1000n - 100n, 1000n - 250n),
  );
});

test("feeGrowthInsideX128 wraps like the pool's unchecked arithmetic", () => {
  // Fee growth accumulators are allowed to overflow; the wrapped difference is the true delta.
  const inside = feeGrowthInsideX128({
    tickCurrent: TICK_IN_RANGE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    feeGrowthGlobalX128: 10n,
    feeGrowthOutsideLowerX128: 40n,
    feeGrowthOutsideUpperX128: 0n,
  });
  assert.equal(inside, U256 - 30n);
});

test("uncollectedFees marks fees earned since the position's checkpoint (#21)", () => {
  // Target 0.05 WETH (token0) and 30 USDC (token1) of accrued fees.
  const delta0 = (5n * 10n ** 16n * Q128) / LIQUIDITY;
  const delta1 = (30_000_000n * Q128) / LIQUIDITY;
  const fees = uncollectedFees({
    liquidity: LIQUIDITY,
    tick: TICK_IN_RANGE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
    pool: {
      feeGrowthGlobal0X128: delta0,
      feeGrowthGlobal1X128: delta1,
      outsideByTick: { [TICK_LOWER]: [0n, 0n], [TICK_UPPER]: [0n, 0n] },
    },
  });
  // Integer division loses at most one wei/unit per side.
  assert.ok(
    fees.fees0 <= 5n * 10n ** 16n && fees.fees0 > 49_999_999_000_000_000n,
  );
  assert.ok(fees.fees1 <= 30_000_000n && fees.fees1 > 29_999_990n);
});

test("uncollectedFees returns zero when it cannot know the answer", () => {
  const pool = {
    feeGrowthGlobal0X128: 10n ** 30n,
    feeGrowthGlobal1X128: 10n ** 30n,
    outsideByTick: { [TICK_LOWER]: [0n, 0n] as const },
  };
  const args = {
    liquidity: LIQUIDITY,
    tick: TICK_IN_RANGE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
  };
  // No pool snapshot at all.
  assert.deepEqual(uncollectedFees({ ...args, pool: undefined }), {
    fees0: 0n,
    fees1: 0n,
  });
  // Upper boundary missing (an uninitialised tick reads as all zeros and would otherwise make
  // feeGrowthInside read as the whole global growth).
  assert.deepEqual(uncollectedFees({ ...args, pool }), {
    fees0: 0n,
    fees1: 0n,
  });
  // No liquidity means nothing accrues.
  assert.deepEqual(
    uncollectedFees({
      ...args,
      liquidity: 0n,
      pool: {
        ...pool,
        outsideByTick: { [TICK_LOWER]: [0n, 0n], [TICK_UPPER]: [0n, 0n] },
      },
    }),
    { fees0: 0n, fees1: 0n },
  );
});

test("tickFeeGrowthEntry rejects uninitialised ticks", () => {
  const initialized = [0n, 0n, 7n, 9n, 0n, 0n, 0, true] as const;
  const uninitialized = [0n, 0n, 0n, 0n, 0n, 0n, 0, false] as const;
  assert.deepEqual(tickFeeGrowthEntry(initialized), [7n, 9n]);
  assert.equal(tickFeeGrowthEntry(uninitialized), undefined);
  assert.equal(tickFeeGrowthEntry(undefined), undefined);
});

test("lpPositionValueUsdcMulti includes uncollected fees when pool fee growth is supplied (#21)", () => {
  const delta0 = (5n * 10n ** 16n * Q128) / LIQUIDITY; // 0.05 WETH
  const delta1 = (30_000_000n * Q128) / LIQUIDITY; // 30 USDC
  const withFees = lpPositionValueUsdcMulti(
    position({}),
    tickByPool,
    fairByBase,
    {
      [POOL]: {
        feeGrowthGlobal0X128: delta0,
        feeGrowthGlobal1X128: delta1,
        outsideByTick: { [TICK_LOWER]: [0n, 0n], [TICK_UPPER]: [0n, 0n] },
      },
    },
  );
  const bare = lpPositionValueUsdcMulti(position({}), tickByPool, fairByBase);
  assert.ok(Math.abs(withFees - bare - (0.05 * FAIR_WETH + 30)) < 1e-3);
});

test("lpPositionValueUsdcMulti nets out the position's own fee checkpoint (#21)", () => {
  // A position that already collected up to half the pool's growth only owns the remainder.
  const delta = (10n ** 17n * Q128) / LIQUIDITY; // 0.1 WETH of total growth
  const feeGrowth = {
    [POOL]: {
      feeGrowthGlobal0X128: delta,
      feeGrowthGlobal1X128: 0n,
      outsideByTick: {
        [TICK_LOWER]: [0n, 0n] as const,
        [TICK_UPPER]: [0n, 0n] as const,
      },
    },
  };
  const fresh = lpPositionValueUsdcMulti(
    position({}),
    tickByPool,
    fairByBase,
    feeGrowth,
  );
  const halfCollected = lpPositionValueUsdcMulti(
    position({ feeGrowthInside0LastX128: delta / 2n }),
    tickByPool,
    fairByBase,
    feeGrowth,
  );
  assert.ok(Math.abs(fresh - halfCollected - 0.05 * FAIR_WETH) < 1e-3);
});

test("lpPositionValueUsdcMulti leaves fees unmarked when no pool fee growth is supplied", () => {
  // Documented fallback: without a pool snapshot the value stays at liquidity + tokensOwed rather
  // than guessing, so callers that cannot batch the extra reads degrade to the pre-#21 number.
  const accrued = lpPositionValueUsdcMulti(
    position({ feeGrowthInside0LastX128: 12_345_678_901_234_567_890n }),
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
