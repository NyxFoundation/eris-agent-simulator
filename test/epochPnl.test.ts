import test from "node:test";
import assert from "node:assert/strict";
import { epochPnlFromSeries } from "../core/src/scoring/epochPnl.js";

test("P is the last boundary minus the first, each at its own marks", () => {
  const p = epochPnlFromSeries([25_000, 25_100, 24_900, 25_250]);
  assert.deepEqual(p, {
    pnlUsdc: 250,
    initialValueUsdc: 25_000,
    finalValueUsdc: 25_250,
    finalBoundaryIndex: 3,
    lastBoundaryIndex: 3,
    carriedFinal: false,
  });
});

test("a final boundary that did not report falls back to the last one that did (§4.4.2), and says so", () => {
  const p = epochPnlFromSeries([25_000, 25_100, null, null]);
  assert.equal(p?.pnlUsdc, 100);
  assert.equal(p?.finalBoundaryIndex, 1);
  assert.equal(p?.carriedFinal, true);
});

test("no starting value, or no boundary after it, is no P rather than an invented one", () => {
  assert.equal(epochPnlFromSeries([null, 25_100]), null);
  assert.equal(epochPnlFromSeries([25_000, null, null]), null);
  assert.equal(epochPnlFromSeries([25_000]), null);
  assert.equal(epochPnlFromSeries([]), null);
});

test("a negative final value is a negative P, not a floor (§4.4.2: no flooring)", () => {
  assert.equal(epochPnlFromSeries([25_000, -1_200])?.pnlUsdc, -26_200);
});
