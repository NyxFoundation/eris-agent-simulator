import assert from "node:assert/strict";
import test from "node:test";
import { Rng } from "@eris/sdk/rng.js";
import {
  EnvBidder,
  PULL_REFERENCE_TRADE_USD,
  SEEDED_SPOT_DEPTH_USD,
  impactValueUsd,
  pullFrontRunValueUsd,
  seededImpactValueUsd,
  sendByBid,
  FLAT_FEE_MEDIAN_WEI,
  WHALE_SLIPPAGE_BPS,
  LAUNCH_WAVE_SLIPPAGE_BPS,
  DEPEG_SLIPPAGE_BPS,
} from "../core/src/realtime/envBid.js";

// ADR 0011 §1c: the environment's event transactions pay an ordinary fee and carry a slippage limit.

const FLOOR = 100_000_000n; // 0.1 gwei

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

test("the ordinary fee averages 1-2 gwei, and never falls below the floor", () => {
  // Pulls and whale prints pay what an ordinary sender pays (PR #287 follow-up), not a share of V.
  const bidder = new EnvBidder(Rng.fromSeed(101, "env-bid:flat"), FLOOR);
  const n = 20_000;
  let sum = 0;
  const fees: number[] = [];
  for (let i = 0; i < n; i++) {
    const gwei = Number(bidder.flatBid(FLAT_FEE_MEDIAN_WEI).priorityFeeWei) / 1e9;
    sum += gwei;
    fees.push(gwei);
  }
  const mean = sum / n;
  assert.ok(mean > 1 && mean < 2, `mean ${mean} gwei`);
  fees.sort((a, b) => a - b);
  const p05 = fees[Math.floor(n * 0.05)];
  const p95 = fees[Math.floor(n * 0.95)];
  assert.ok(p05 > 0.6 && p95 < 3, `p05 ${p05}, p95 ${p95}`);
  const floored = new EnvBidder(Rng.fromSeed(1, "env-bid:floor"), 5_000_000_000n);
  assert.equal(floored.flatBid(FLAT_FEE_MEDIAN_WEI, 0).priorityFeeWei, 5_000_000_000n);
});

test("slippage limits are drawn over a factor-of-two range, inside it; the whale's is a fixed 0.5%", () => {
  assert.equal(WHALE_SLIPPAGE_BPS, 50);
  const bidder = new EnvBidder(Rng.fromSeed(7, "env-bid:slippage"), FLOOR);
  for (const [lo, hi] of [LAUNCH_WAVE_SLIPPAGE_BPS, DEPEG_SLIPPAGE_BPS]) {
    assert.equal(hi, lo * 2);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 2_000; i++) {
      const bps = bidder.drawSlippageBps(lo, hi);
      min = Math.min(min, bps);
      max = Math.max(max, bps);
    }
    assert.ok(min >= lo && max <= hi, `[${lo}, ${hi}]: drew ${min}..${max}`);
    assert.ok(min < lo * 1.05 && max > hi * 0.95, `the whole range is used: ${min}..${max}`);
  }
});
