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

test("priceRngForAsset(seed,'WETH') equals Rng(seed) — WETH byte compatibility", () => {
  // WETH's price Rng uses derived salt 0, so it exactly matches Rng(seed) (preserves existing run paths).
  const seed = 12345;
  const direct = new Rng(seed);
  const viaWeth = priceRngForAsset(seed, "WETH");
  for (let i = 0; i < 5; i++) assert.equal(viaWeth.next(), direct.next());
});

test("adding WBTC leaves the WETH price path byte-identical (independent per-asset Rng)", () => {
  const seed = 99;
  // legacy: advance WETH alone by 4 steps with Rng(seed).
  const solo = new Rng(seed);
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
