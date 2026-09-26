// The interval boundaries are where P is read from (V_K − V_0 at the first and last boundary, ADR
// 0023), and under ADR 0019 they were the score outright, so a bug here does not coarsen a curve the
// way scoreEvery does -- it changes every agent's number. These pin the two properties the series
// depends on: N intervals need N+1 boundaries, and every interval is the same width.
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

test("a trailing partial interval is dropped rather than recorded short", () => {
  // 100 blocks at 12/interval = 8 full intervals and 4 blocks left over. Recording the remainder as
  // a ninth interval would show every agent a smaller change for it by construction.
  const boundaries = intervalBoundaryBlocks(0, 100, 12);
  assert.deepEqual(boundaries, [0, 12, 24, 36, 48, 60, 72, 84, 96]);
});

test("a run shorter than one interval produces no series", () => {
  // There is no V_K to read: the run never reached a second boundary.
  assert.deepEqual(intervalBoundaryBlocks(0, 11, 12), []);
  assert.deepEqual(intervalBoundaryBlocks(0, 0, 12), []);
});

test("a disabled or nonsensical interval length produces no series", () => {
  for (const intervalBlocks of [0, -1, 0.5, Number.NaN])
    assert.deepEqual(
      intervalBoundaryBlocks(0, 500, intervalBlocks),
      [],
      `intervalBlocks=${intervalBlocks} should disable the series, not partition it`,
    );
});
