import assert from "node:assert/strict";
import test from "node:test";
import { Rng } from "@eris/sdk/rng.js";
import {
  ENV_BID_MEDIAN,
  EnvBidder,
  PULL_REFERENCE_TRADE_USD,
  SEEDED_SPOT_DEPTH_USD,
  impactValueUsd,
  pullFrontRunValueUsd,
} from "../core/src/realtime/envBid.js";

// ADR 0011: the environment's event transactions bid U × V. In ~60% of draws U < 1, i.e. the bid is
// below what getting ahead is worth.

const FLOOR = 100_000_000n; // 0.1 gwei

test("about 60% of bids are below the front-running value", () => {
  const bidder = new EnvBidder(Rng.fromSeed(101, "env-bid:test"), FLOOR);
  const n = 20_000;
  let below = 0;
  const us: number[] = [];
  for (let i = 0; i < n; i++) {
    const { u } = bidder.bid({ valueUsd: 100, gas: 200_000n, ethUsd: 3000 });
    us.push(u);
    if (u < 1) below++;
  }
  const share = below / n;
  assert.ok(share > 0.585 && share < 0.615, `share below 1: ${share}`);
  us.sort((a, b) => a - b);
  const median = us[n / 2];
  assert.ok(Math.abs(median - ENV_BID_MEDIAN) < 0.02, `median ${median}`);
});

test("the bid is U × V in wei per gas, never below the floor", () => {
  const bidder = new EnvBidder(Rng.fromSeed(7, "env-bid:test"), FLOOR);
  const b = bidder.bid({ valueUsd: 300, gas: 150_000n, ethUsd: 3000 });
  // U × $300 at $3,000/ETH over 150k gas.
  const expected = BigInt(Math.floor(((b.u * 300) / 3000) * 1e18)) / 150_000n;
  assert.equal(b.priorityFeeWei, expected > FLOOR ? expected : FLOOR);
  const zero = bidder.bid({ valueUsd: 0, gas: 150_000n, ethUsd: 3000 });
  assert.equal(zero.priorityFeeWei, FLOOR);
});

test("a fee the sender cannot cover is capped at half its balance", () => {
  const bidder = new EnvBidder(Rng.fromSeed(7, "env-bid:test"), FLOOR);
  const b = bidder.bid({
    valueUsd: 1_000_000,
    gas: 100_000n,
    ethUsd: 3000,
    balanceWei: 10n ** 18n,
  });
  assert.equal(b.balanceCapped, true);
  assert.equal(b.priorityFeeWei, 10n ** 18n / 2n / 100_000n);
});

test("impact value: what the trade loses against the marginal rate, in dollars", () => {
  // Selling 1,000 for 990 USDC when the marginal rate is 1.00: $10 of impact (USDC out, 6 decimals).
  assert.equal(
    impactValueUsd({
      amountIn: 1000n * 10n ** 18n,
      quoted: 990n * 10n ** 6n,
      smallIn: 10n ** 18n,
      smallQuoted: 10n ** 6n,
      usdDecimals: 6,
      usdSide: "out",
    }),
    10,
  );
  // Spending 1,000 USDC for 900 tokens when the marginal rate is 1 token per USDC: 10% of $1,000.
  const v = impactValueUsd({
    amountIn: 1000n * 10n ** 6n,
    quoted: 900n * 10n ** 18n,
    smallIn: 10n ** 6n,
    smallQuoted: 10n ** 18n,
    usdDecimals: 6,
    usdSide: "in",
  });
  assert.ok(Math.abs(v - 100) < 1e-9, `${v}`);
  // No impact, or a quote that failed, is worth nothing.
  assert.equal(
    impactValueUsd({ amountIn: 1n, quoted: 1n, smallIn: 1n, smallQuoted: 0n, usdDecimals: 6, usdSide: "in" }),
    0,
  );
});

test("pull value: a withdrawal is worth getting ahead of, a restore is not", () => {
  // Halving a seeded book: N²/2 × (1/D_after − 1/D_before).
  const n = PULL_REFERENCE_TRADE_USD;
  const d = SEEDED_SPOT_DEPTH_USD;
  const v = pullFrontRunValueUsd({ depthBefore: 1000n, depthAfter: 500n, seededDepth: 1000n });
  assert.ok(Math.abs(v - ((n * n) / 2) * (1 / (d / 2) - 1 / d)) < 1e-9);
  assert.equal(
    pullFrontRunValueUsd({ depthBefore: 500n, depthAfter: 1000n, seededDepth: 1000n }),
    0,
  );
});
