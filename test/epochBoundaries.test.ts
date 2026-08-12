// The epoch boundaries ARE the score under ADR 0019 (x_e = ln(W_e / W_{e-1})), so a bug here does not
// coarsen a curve the way scoreEvery does -- it changes every agent's number. These pin the two
// properties the metric depends on: E epochs need E+1 boundaries, and every epoch is the same width.
import test from "node:test";
import assert from "node:assert/strict";
import { epochBoundaryBlocks } from "../core/src/realtime/reconstruct.js";

test("a week of the calibration harness is 42 epochs of 12 blocks", () => {
  // ADR 0019 §8: 12 blocks/epoch, E = 42 -> a 504-block run.
  const boundaries = epochBoundaryBlocks(1000, 1504, 12);
  assert.equal(boundaries.length, 43, "42 returns need 43 marks");
  assert.equal(boundaries[0], 1000);
  assert.equal(boundaries.at(-1), 1504);
});

test("every epoch is the same width", () => {
  const boundaries = epochBoundaryBlocks(0, 120, 12);
  for (let i = 1; i < boundaries.length; i++)
    assert.equal(boundaries[i] - boundaries[i - 1], 12, `epoch ${i} is short`);
});

test("a trailing partial epoch is dropped rather than scored short", () => {
  // 100 blocks at 12/epoch = 8 full epochs and 4 blocks left over. Scoring the remainder as a ninth
  // epoch would hand every agent a smaller log return for it by construction.
  const boundaries = epochBoundaryBlocks(0, 100, 12);
  assert.deepEqual(boundaries, [0, 12, 24, 36, 48, 60, 72, 84, 96]);
});

test("a run shorter than one epoch produces no series", () => {
  // Better than one epoch spanning the whole run: with a single return there is no std term, so the
  // score would silently collapse to case A (mean only).
  assert.deepEqual(epochBoundaryBlocks(0, 11, 12), []);
  assert.deepEqual(epochBoundaryBlocks(0, 0, 12), []);
});

test("a disabled or nonsensical epoch length produces no series", () => {
  for (const epochBlocks of [0, -1, 0.5, Number.NaN])
    assert.deepEqual(
      epochBoundaryBlocks(0, 500, epochBlocks),
      [],
      `epochBlocks=${epochBlocks} should disable the series, not partition it`,
    );
});
