// The interval boundaries are where P is read from (V_K − V_0 at the first and last boundary, ADR
// 0023), and under ADR 0019 they were the score outright, so a bug here does not coarsen a curve the
// way scoreEvery does -- it changes every agent's number. These pin the properties the series
// depends on: N intervals need N+1 boundaries, every interval but the last is the same width, and the
// epoch's end block is always the last boundary (epochExtent.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { intervalBoundaryBlocks } from "../core/src/realtime/reconstruct.js";

test("a week of the calibration harness is 42 intervals of 12 blocks", () => {
  // ADR 0019 §8: 12 blocks/interval, 42 of them -> a 504-block run.
  const boundaries = intervalBoundaryBlocks(1000, 1504, 12);
  assert.equal(boundaries.length, 43, "42 intervals need 43 marks");
  assert.equal(boundaries[0], 1000);
  assert.equal(boundaries.at(-1), 1504);
});

test("every interval is the same width", () => {
  const boundaries = intervalBoundaryBlocks(0, 120, 12);
  for (let i = 1; i < boundaries.length; i++)
    assert.equal(
      boundaries[i] - boundaries[i - 1],
      12,
      `interval ${i} is short`,
    );
});

test("a 360-block epoch is 30 intervals and ends on its last block", () => {
  // The official regimes: 360 blocks at 12/interval. The boundary that closes the 30th interval is
  // the epoch's end block -- where every agent reads blocksRemaining 0 -- and it is where V_K is read.
  // It used to be missing: the last boundary was start+348 and 29 intervals were scored.
  const boundaries = intervalBoundaryBlocks(5000, 5360, 12);
  assert.equal(boundaries.length, 31);
  assert.equal(boundaries.at(-1), 5360);
  assert.equal(boundaries.at(-2), 5348);
});

test("the end block is the last boundary; the final interval is the remainder", () => {
  // 100 blocks at 12/interval = 8 full intervals and 4 blocks left over. The grid is kept (the live
  // scorer walks it, and the practice segments are cut on it), and the end closes a short ninth
  // interval. This used to drop the remainder, which put V_K four blocks before the end.
  const boundaries = intervalBoundaryBlocks(0, 100, 12);
  assert.deepEqual(boundaries, [0, 12, 24, 36, 48, 60, 72, 84, 96, 100]);
});

test("a run shorter than one interval is one short interval", () => {
  // The epoch still has two ends, so it still has a P. It used to produce no series at all.
  assert.deepEqual(intervalBoundaryBlocks(0, 11, 12), [0, 11]);
  // A window with no block after its first has no interval.
  assert.deepEqual(intervalBoundaryBlocks(0, 0, 12), []);
  assert.deepEqual(intervalBoundaryBlocks(10, 9, 12), []);
});

test("a disabled or nonsensical interval length produces no series", () => {
  for (const intervalBlocks of [0, -1, 0.5, Number.NaN])
    assert.deepEqual(
      intervalBoundaryBlocks(0, 500, intervalBlocks),
      [],
      `intervalBlocks=${intervalBlocks} should disable the series, not partition it`,
    );
});
