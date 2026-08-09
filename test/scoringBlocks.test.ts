// Thinning the scoring cross-sections must not move any agent's score (ADR 0017 §3).
//
// The final score is alphaLast - alphaFirst, so the only thing that has to survive thinning is
// "the first block read is fromBlock and the last one read is toBlock". Everything between them
// is equity-curve resolution. These tests pin that invariant, because a thinning bug that drops
// either endpoint changes scores silently rather than failing.
import test from "node:test";
import assert from "node:assert/strict";
import { scoringBlocks } from "../core/src/realtime/reconstruct.js";

test("scoreEvery=1 reads every block in the window", () => {
  assert.deepEqual(scoringBlocks(100, 105, 1), [100, 101, 102, 103, 104, 105]);
});

test("scoreEvery thins the interior but keeps both endpoints", () => {
  assert.deepEqual(scoringBlocks(100, 108, 4), [100, 104, 108]);
  // toBlock is not on the stride here: it still has to be the last cross-section.
  assert.deepEqual(scoringBlocks(100, 110, 4), [100, 104, 108, 110]);
});

test("endpoints survive every stride, including strides larger than the window", () => {
  for (const every of [1, 2, 3, 5, 7, 8, 100]) {
    const blocks = scoringBlocks(100, 110, every);
    assert.equal(blocks[0], 100, `fromBlock missing for every=${every}`);
    assert.equal(blocks.at(-1), 110, `toBlock missing for every=${every}`);
    // Strictly increasing, so alphaFirst/alphaLast cannot be assigned out of order.
    for (let i = 1; i < blocks.length; i++)
      assert.ok(blocks[i] > blocks[i - 1], `not increasing for every=${every}`);
  }
});

test("a single-block window yields exactly one cross-section", () => {
  // fromBlock === toBlock means alphaFirst and alphaLast are the same read, so the score is 0.
  // Emitting the block twice would make it 0 as well, but it would double the reads.
  assert.deepEqual(scoringBlocks(100, 100, 1), [100]);
  assert.deepEqual(scoringBlocks(100, 100, 8), [100]);
});

test("a non-positive or fractional stride degrades to every block", () => {
  assert.deepEqual(scoringBlocks(10, 13, 0), [10, 11, 12, 13]);
  assert.deepEqual(scoringBlocks(10, 13, -5), [10, 11, 12, 13]);
  assert.deepEqual(scoringBlocks(10, 14, 2.7), [10, 12, 14]);
});
