import test from "node:test";
import assert from "node:assert/strict";
import {
  Rng,
  nextFairPrice,
  nextFairPrices,
  priceRngForAsset,
} from "@eris/sdk/rng.js";

test("rng and fair price are reproducible for a fixed seed", () => {
  const a = new Rng(42);
  const b = new Rng(42);
  const pricesA = [
    nextFairPrice(3000, a, 3000),
    nextFairPrice(3000, a, 3000),
    nextFairPrice(3000, a, 3000),
  ];
  const pricesB = [
    nextFairPrice(3000, b, 3000),
    nextFairPrice(3000, b, 3000),
    nextFairPrice(3000, b, 3000),
  ];
  assert.deepEqual(pricesA, pricesB);
});

test("fair price mean-reverts toward the anchor", () => {
  // a current well above the anchor is pulled back (downward), a current well below is pulled up.
  // Confirm the mean drift direction over many steps points toward the anchor (shocks average 0).
  const anchor = 3000;
  const stepsFrom = (start: number): number => {
    const rng = new Rng(7);
    let p = start;
    for (let i = 0; i < 200; i++) p = nextFairPrice(p, rng, anchor);
    return p;
  };
  const fromHigh = stepsFrom(3600); // +20% above anchor
  const fromLow = stepsFrom(2400); // -20% below anchor
  // both regress toward the anchor neighborhood (within ±10%)
  assert.ok(Math.abs(fromHigh - anchor) < anchor * 0.1, `fromHigh=${fromHigh}`);
  assert.ok(Math.abs(fromLow - anchor) < anchor * 0.1, `fromLow=${fromLow}`);
});

// This used to pin priceRngForAsset(seed, "WETH") === Rng(seed), to keep the WETH path byte-identical
// to runs from before the multi-asset change. That compatibility was given up on purpose: Rng(seed)
// started every seed from 1 to 200 inside [0.236, 0.314), so every run opened with a 15-21 bps
// fall (see test/rngSeeds.test.ts). WETH now derives its stream like every other base.
test("priceRngForAsset(seed,'WETH') is the hashed stream, not Rng(seed)", () => {
  const seed = 12345;
  const viaWeth = priceRngForAsset(seed, "WETH");
  const hashed = Rng.fromSeed(seed, "price:WETH");
  const raw = new Rng(seed);
  const a = Array.from({ length: 5 }, () => viaWeth.next());
  assert.deepEqual(a, Array.from({ length: 5 }, () => hashed.next()));
  assert.notDeepEqual(a, Array.from({ length: 5 }, () => raw.next()));
});

test("adding WBTC leaves the WETH price path byte-identical (independent per-asset Rng)", () => {
  const seed = 99;
  // WETH alone, 4 steps on its own price stream (Rng(seed) before the seed was hashed).
  const solo = priceRngForAsset(seed, "WETH");
  const wethSolo: number[] = [];
  let p = 3000;
  for (let i = 0; i < 4; i++) {
    p = nextFairPrice(p, solo, 3000);
    wethSolo.push(p);
  }
  // multi: advance WETH+WBTC by 4 steps with an independent per-asset Rng.
  const rngBy = {
    WETH: priceRngForAsset(seed, "WETH"),
    WBTC: priceRngForAsset(seed, "WBTC"),
  };
  let cur: Record<string, number> = { WETH: 3000, WBTC: 60000 };
  const anchors = { WETH: 3000, WBTC: 60000 };
  const wethMulti: number[] = [];
  for (let i = 0; i < 4; i++) {
    cur = nextFairPrices(cur, rngBy, anchors, ["WETH", "WBTC"]);
    wethMulti.push(cur.WETH);
  }
  // adding WBTC keeps the WETH price series exactly equal to the solo version (effect of independent Rng).
  assert.deepEqual(wethMulti, wethSolo);
  // WBTC advances independently.
  assert.notEqual(cur.WBTC, 60000);
});

// The practice period's resume (core/src/realtime/periodResume.ts) continues the price walk's
// streams from a saved position. Restored mid-block as well as on a block edge: four draws share one
// HMAC block, and a position that lands inside one is the common case.
test("a keyed stream restored from its snapshot continues with the same draws", () => {
  for (const before of [0, 1, 3, 4, 5, 37]) {
    const original = Rng.fromSeed(7, "price:WETH");
    for (let i = 0; i < before; i++) original.next();
    const saved = original.snapshot();
    const expected = Array.from({ length: 9 }, () => original.next());
    const resumed = Rng.fromSeed(7, "price:WETH");
    resumed.restore(saved);
    assert.deepEqual(
      Array.from({ length: 9 }, () => resumed.next()),
      expected,
      `after ${before} draws`,
    );
    assert.deepEqual(resumed.snapshot(), { kind: "keyed", draws: before + 9 });
  }
});

test("an LCG stream restores from its snapshot, and the two kinds do not mix", () => {
  const a = new Rng(42);
  a.next();
  const saved = a.snapshot();
  const expected = [a.next(), a.next()];
  const b = new Rng(1);
  b.restore(saved);
  assert.deepEqual([b.next(), b.next()], expected);
  assert.throws(() => Rng.fromSeed(1, "x").restore(saved), /into a keyed stream/);
  assert.throws(() => b.restore({ kind: "keyed", draws: 3 }), /into an LCG stream/);
});
