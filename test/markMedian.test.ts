// G7 (ADR 0019 §5): an epoch boundary is marked at the median of the blocks before it, so a mark a
// holder pushed for one block does not become the score.
//
// The rule matters in both directions. Inflating a mark at the final boundary is the obvious abuse,
// but the metric's std term makes the *intermediate* boundaries worth attacking too: moving one
// boundary leaves the mean untouched (the next epoch cancels it) and changes only the dispersion,
// which a push in the smoothing direction lowers. That is why the median is applied at every
// boundary rather than only the last.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import {
  medianStablePrices,
  type StableMarket,
  type StablePrices,
} from "@eris/sdk/stables.js";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;

// Built by hand rather than probed: what is under test is how samples are collapsed, and the probe
// arithmetic that produces each sample is pinned in stables.test.ts.
const MARKET = {
  symbol: "DAI",
  token: TOKEN,
  decimals: 18,
  venue: "curve",
  pool: "0x2222222222222222222222222222222222222222" as Address,
  stableIndex: 0,
  quoteIndex: 1,
  probeStableUnits: 1_000n * 10n ** 18n,
  probeQuoteUnits: 1_000n * 10n ** 6n,
} as StableMarket;

function sample(priceUsdc: number, quoted = true): StablePrices {
  return {
    byToken: { [TOKEN.toLowerCase()]: quoted ? priceUsdc : 1 },
    unquoted: quoted ? [] : [MARKET],
    quotes: [
      {
        symbol: MARKET.symbol,
        token: TOKEN,
        priceUsdc: quoted ? priceUsdc : 1,
        sellPriceUsdc: quoted ? priceUsdc : 0,
        buyPriceUsdc: quoted ? priceUsdc : 0,
        quoted,
      },
    ],
  };
}

const priceOf = (prices: StablePrices) => prices.byToken[TOKEN.toLowerCase()];

test("a one-block push at the boundary does not become the mark", () => {
  // Four blocks of a 98c mark, then the holder buys the pool up to 1.05 in the boundary block and
  // unwinds next block. The median ignores it; the mean would not have.
  const median = medianStablePrices([
    sample(0.98),
    sample(0.98),
    sample(0.98),
    sample(0.98),
    sample(1.05),
  ]);
  assert.equal(priceOf(median), 0.98);
});

test("a move held across the window does move the mark", () => {
  // The rule is not "ignore late moves", it is "a move has to be held to count". A real repeg that
  // survives most of the window is the price.
  const median = medianStablePrices([
    sample(0.98),
    sample(0.98),
    sample(1.0),
    sample(1.0),
    sample(1.0),
  ]);
  assert.equal(priceOf(median), 1.0);
});

test("blocks the pool would not quote are dropped, not counted as par", () => {
  // Counting a silent block as $1 would pull the median toward par and erase exactly the
  // dislocation the venue exists to close (issue #27's "a dollar is not a measurement").
  const median = medianStablePrices([
    sample(0.9),
    sample(0, false),
    sample(0.9),
    sample(0, false),
    sample(0.92),
  ]);
  assert.equal(priceOf(median), 0.9);
  assert.equal(median.unquoted.length, 0);
  assert.equal(median.quotes[0].quoted, true);
});

test("a window where nothing quoted is par, and still says so", () => {
  const median = medianStablePrices([sample(0, false), sample(0, false)]);
  assert.equal(priceOf(median), 1);
  assert.equal(median.quotes[0].quoted, false);
  assert.deepEqual(
    median.unquoted.map((m) => m.symbol),
    ["DAI"],
  );
});

test("an even window medians across the two middle blocks", () => {
  const median = medianStablePrices([
    sample(0.9),
    sample(0.94),
    sample(0.96),
    sample(1.02),
  ]);
  assert.ok(Math.abs(priceOf(median) - 0.95) < 1e-12);
});

test("a degenerate window is the live mark", () => {
  // Boundary 0 has nothing before it, and a window of one block is the live probe by definition.
  assert.equal(priceOf(medianStablePrices([sample(0.93)])), 0.93);
  assert.equal(priceOf(medianStablePrices([])), undefined);
});
