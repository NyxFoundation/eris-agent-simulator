import assert from "node:assert/strict";
import test from "node:test";
import { Rng } from "@eris/sdk/rng.js";
import {
  ENV_BID_MEDIAN,
  EnvBidder,
  FRONT_RUN_GAS,
  PULL_REFERENCE_TRADE_USD,
  SEEDED_SPOT_DEPTH_USD,
  impactValueUsd,
  pullFrontRunValueUsd,
  seededImpactValueUsd,
  sendByBid,
} from "../core/src/realtime/envBid.js";

// ADR 0011 §1b: the environment's event transactions bid U × V per gas of the front-runner's swap.
// In ~60% of draws U < 1, i.e. getting ahead costs less than it is worth.

const FLOOR = 100_000_000n; // 0.1 gwei

test("about 60% of bids are below the front-running value", () => {
  const bidder = new EnvBidder(Rng.fromSeed(101, "env-bid:test"), FLOOR);
  const n = 20_000;
  let below = 0;
  const us: number[] = [];
  for (let i = 0; i < n; i++) {
    const { u } = bidder.bid({
      valueUsd: 100,
      frontRunGas: FRONT_RUN_GAS.uniswap,
      gasLimit: 700_000n,
      ethUsd: 3000,
    });
    us.push(u);
    if (u < 1) below++;
  }
  const share = below / n;
  assert.ok(share > 0.585 && share < 0.615, `share below 1: ${share}`);
  us.sort((a, b) => a - b);
  const median = us[n / 2];
  assert.ok(Math.abs(median - ENV_BID_MEDIAN) < 0.02, `median ${median}`);
});

test("bid × the front-runner's gas = U × V: what getting ahead costs is the drawn share of V", () => {
  for (const venue of ["uniswap", "balancer", "curve"] as const) {
    const bidder = new EnvBidder(Rng.fromSeed(7, `env-bid:${venue}`), FLOOR);
    const b = bidder.bid({
      valueUsd: 300,
      frontRunGas: FRONT_RUN_GAS[venue],
      gasLimit: 900_000n,
      ethUsd: 3000,
    });
    const costUsd = (Number(b.priorityFeeWei * FRONT_RUN_GAS[venue]) / 1e18) * 3000;
    // Integer division on the fee per gas loses at most one wei per gas.
    assert.ok(Math.abs(costUsd - b.u * 300) < 1e-6, `${venue}: ${costUsd} vs ${b.u * 300}`);
  }
});

test("the gas limit does not move the bid unless the balance cap binds", () => {
  const bid = (gasLimit: bigint, balanceWei?: bigint) =>
    new EnvBidder(Rng.fromSeed(7, "env-bid:limit"), FLOOR).bid({
      valueUsd: 300,
      frontRunGas: FRONT_RUN_GAS.curve,
      gasLimit,
      ethUsd: 3000,
      ...(balanceWei !== undefined ? { balanceWei } : {}),
    });
  const ample = 1000n * 10n ** 18n;
  const base = bid(135_000n, ample);
  for (const gasLimit of [300_000n, 600_000n, 900_000n, 5_000_000n])
    assert.equal(bid(gasLimit, ample).priorityFeeWei, base.priorityFeeWei, `${gasLimit}`);
  assert.equal(bid(900_000n).priorityFeeWei, base.priorityFeeWei, "no balance given");
  assert.equal(base.balanceCapped, false);
});

test("never below the floor, and capped at half the sender's balance", () => {
  const bidder = new EnvBidder(Rng.fromSeed(7, "env-bid:test"), FLOOR);
  const zero = bidder.bid({
    valueUsd: 0,
    frontRunGas: FRONT_RUN_GAS.uniswap,
    gasLimit: 600_000n,
    ethUsd: 3000,
  });
  assert.equal(zero.priorityFeeWei, FLOOR);
  const capped = bidder.bid({
    valueUsd: 1_000_000,
    frontRunGas: FRONT_RUN_GAS.uniswap,
    gasLimit: 100_000n,
    ethUsd: 3000,
    balanceWei: 10n ** 18n,
  });
  assert.equal(capped.balanceCapped, true);
  assert.equal(capped.priorityFeeWei, 10n ** 18n / 2n / 100_000n);
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

// A trade on a constant-product book, done literally: x·y = k, the trade adds N dollars to the side
// it pays into, and what it receives is valued at the marginal price before the trade.
function simulatedShortfall(notionalUsd: number, sideDepthUsd: number): number {
  const y = sideDepthUsd; // dollars on the side paid into
  const x = sideDepthUsd; // the other side, in dollars at the marginal price
  const out = (x * notionalUsd) / (y + notionalUsd);
  return notionalUsd - out;
}

test("seeded impact value is the constant-product shortfall on one side of the book", () => {
  // PR #287 review: the old N²/(2D) used both sides for D and came out a quarter of this.
  const side = SEEDED_SPOT_DEPTH_USD / 2;
  for (const n of [10_000, 150_000, 500_000]) {
    const v = seededImpactValueUsd(n);
    const truth = simulatedShortfall(n, side);
    assert.ok(Math.abs(v - truth) / truth < 0.01, `${n}: ${v} vs ${truth}`);
  }
  // The review's example: a $150k whale buy on a $3M side gives up about $7,143.
  assert.ok(Math.abs(seededImpactValueUsd(150_000) - 7_142.857) < 0.01);
});

test("pull value: a withdrawal is worth getting ahead of, a restore is not", () => {
  // Halving a seeded book: the reference trade's shortfall after the pull minus before it.
  const n = PULL_REFERENCE_TRADE_USD;
  const side = SEEDED_SPOT_DEPTH_USD / 2;
  const v = pullFrontRunValueUsd({ depthBefore: 1000n, depthAfter: 500n, seededDepth: 1000n });
  const truth = simulatedShortfall(n, side / 2) - simulatedShortfall(n, side);
  assert.ok(Math.abs(v - truth) / truth < 0.01, `${v} vs ${truth}`);
  assert.equal(
    pullFrontRunValueUsd({ depthBefore: 500n, depthAfter: 1000n, seededDepth: 1000n }),
    0,
  );
});

test("one key's deferred sends go out highest bid first, ties in the callers' order", async () => {
  // One sender's transactions are included in nonce order, so a low bid sent first would hold back a
  // higher one sent after it (a pull before a depeg from the deployer key; PR #287 review).
  const sent: string[] = [];
  const item = (name: string, gwei: bigint) => ({
    priorityFeeWei: gwei * 1_000_000_000n,
    send: async () => {
      sent.push(name);
      return `0x${name}` as `0x${string}`;
    },
  });
  const hashes = await sendByBid([
    item("pull-a", 1n),
    item("pull-b", 7n),
    item("depeg", 40n),
    item("pull-c", 7n),
  ]);
  assert.deepEqual(sent, ["depeg", "pull-b", "pull-c", "pull-a"]);
  // Results stay in the callers' order.
  assert.deepEqual(hashes, ["0xpull-a", "0xpull-b", "0xdepeg", "0xpull-c"]);
});
