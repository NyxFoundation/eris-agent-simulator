// Balancer admin seed sizing (issue #43). The seed used to be fixed notionals that implied
// ETH~$2,100, so every fork run whose spot had left that level died on the startup no-arb check.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { seedAmountsIn, type SeedLeg } from "@eris/sdk/protocols/balancer.js";

const WETH = "0x0000000000000000000000000000000000000001" as Address;
const USDC = "0x0000000000000000000000000000000000000002" as Address;
const USDT = "0x0000000000000000000000000000000000000003" as Address;

const ONE = 10n ** 18n;
const THIRD = ONE / 3n;
const SEED_WETH = 200n * ONE;

function legsAt(
  price: number,
  weights: bigint[] = [THIRD, THIRD, ONE - 2n * THIRD],
  balances: bigint[] = [0n, 0n, 0n],
): SeedLeg[] {
  return [
    {
      token: WETH,
      decimals: 18,
      priceUsd: price,
      weight: weights[0],
      balance: balances[0],
    },
    {
      token: USDC,
      decimals: 6,
      priceUsd: 1,
      weight: weights[1],
      balance: balances[1],
    },
    {
      token: USDT,
      decimals: 6,
      priceUsd: 1,
      weight: weights[2],
      balance: balances[2],
    },
  ];
}

// What the pool quotes for the base after the join: a weighted pool's spot price is the ratio of
// the legs' balance/weight, in whole tokens.
function impliedBasePrice(
  legs: SeedLeg[],
  amountsIn: bigint[],
  baseIndex: number,
  quoteIndex: number,
): number {
  const perWeight = (i: number) =>
    Number(legs[i].balance + amountsIn[i]) /
    10 ** legs[i].decimals /
    Number(legs[i].weight);
  return perWeight(quoteIndex) / perWeight(baseIndex);
}

test("seeds the stable legs at the live price", () => {
  const legs = legsAt(4000);
  const amounts = seedAmountsIn(legs, 0, SEED_WETH);
  assert.equal(amounts[0], SEED_WETH);
  // 200 WETH at $4,000 = $800,000 per equal-weight leg.
  assert.equal(amounts[1], 800_000_000_000n);
  assert.equal(amounts[2], 800_000_000_000n);
  assert.ok(Math.abs(impliedBasePrice(legs, amounts, 0, 1) - 4000) < 1e-6);
});

test("tracks the price rather than drifting away from it", () => {
  for (const price of [1200, 2100, 3456.78, 9000]) {
    const legs = legsAt(price);
    const amounts = seedAmountsIn(legs, 0, SEED_WETH);
    assert.ok(
      Math.abs(impliedBasePrice(legs, amounts, 0, 1) / price - 1) < 1e-9,
      `implied price off at $${price}`,
    );
  }
  // At the price the retired constants assumed, the derived seed reproduces them exactly.
  assert.deepEqual(seedAmountsIn(legsAt(2100), 0, SEED_WETH).slice(1), [
    420_000_000_000n,
    420_000_000_000n,
  ]);
});

test("sizes each leg by its own weight", () => {
  // 20/40/40: the stable legs are twice the base leg's weight, so twice its USD value.
  const legs = legsAt(3000, [ONE / 5n, (ONE * 2n) / 5n, (ONE * 2n) / 5n]);
  const amounts = seedAmountsIn(legs, 0, SEED_WETH);
  assert.equal(amounts[1], 1_200_000_000_000n);
  assert.equal(amounts[2], 1_200_000_000_000n);
  assert.ok(Math.abs(impliedBasePrice(legs, amounts, 0, 1) - 3000) < 1e-6);
});

test("subtracts what the depleted pool still holds", () => {
  const residue = [ONE, 1_000_000_000n, 0n];
  const legs = legsAt(4000, undefined, residue);
  const amounts = seedAmountsIn(legs, 0, SEED_WETH);
  assert.equal(amounts[0], SEED_WETH - ONE);
  assert.equal(amounts[1], 800_000_000_000n - 1_000_000_000n);
  assert.equal(amounts[2], 800_000_000_000n);
  assert.ok(Math.abs(impliedBasePrice(legs, amounts, 0, 1) - 4000) < 1e-6);
});

test("scales up rather than seeding off-price when a leg is already over its target", () => {
  // A join cannot remove tokens, so a leg holding 4x its target forces the whole seed 4x deeper.
  const legs = legsAt(4000, undefined, [0n, 3_200_000_000_000n, 0n]);
  const amounts = seedAmountsIn(legs, 0, SEED_WETH);
  assert.equal(amounts[1], 0n);
  assert.equal(amounts[0], 4n * SEED_WETH);
  assert.equal(amounts[2], 3_200_000_000_000n);
  assert.ok(Math.abs(impliedBasePrice(legs, amounts, 0, 1) - 4000) < 1e-6);
});

test("refuses to seed on inputs it cannot price", () => {
  assert.throws(() => seedAmountsIn(legsAt(0), 0, SEED_WETH), /no USD price/);
  assert.throws(
    () => seedAmountsIn(legsAt(4000, [0n, 0n, 0n]), 0, SEED_WETH),
    /no normalized weights/,
  );
  assert.throws(
    () => seedAmountsIn(legsAt(4000), 3, SEED_WETH),
    /anchor leg out of range/,
  );
});
