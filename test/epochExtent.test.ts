// The epoch ends on a chain block, not on a count of loop passes (epochExtent.ts).
//
// Measured before this: the coordinator ended the run after `runBlocks` passes of its block handler,
// and a pass covers every block mined since the previous one. On a loaded laptop crash#101 ran 432
// chain blocks for 360 passes (36 catch-up passes, up to 14 blocks each), so the last boundary sat
// 72 blocks after the agents had read `blocksRemaining` 0. And a loop that kept up never reached the
// boundary that closes the 30th interval: V_K was read at start+348. These pin the decision the
// coordinator now makes each pass, with the loop simulated rather than run.
import test from "node:test";
import assert from "node:assert/strict";
import {
  epochEndBlock,
  intervalBoundaryBlocks,
  intervalCount,
  loopStep,
  nextIntervalBoundary,
  type LoopStep,
} from "../core/src/epochExtent.js";
import { blocksRemainingUnderBlockBudget } from "../example/agents/runtime/blockBudget.js";

// The coordinator's loop, reduced to what decides the run's extent: each notification becomes a
// pass over [fromBlock, block], the live scorer reads every boundary due through `block`, and the
// run stops after the final pass.
function simulateLoop(opts: {
  runStartBlock: number;
  runBlocks: number;
  intervalBlocks: number;
  notifications: number[];
}) {
  const endBlock = epochEndBlock(opts.runStartBlock, opts.runBlocks);
  let lastProcessedBlock = opts.runStartBlock - 1;
  let pending: number | null = opts.runStartBlock;
  const passes: LoopStep[] = [];
  const boundaries: number[] = [];
  for (const notifiedBlock of opts.notifications) {
    const step = loopStep({ lastProcessedBlock, notifiedBlock, endBlock });
    lastProcessedBlock = Math.max(lastProcessedBlock, step.block);
    while (pending !== null && pending <= step.block) {
      boundaries.push(pending);
      pending = nextIntervalBoundary(pending, opts.intervalBlocks, endBlock);
    }
    passes.push(step);
    if (step.final) break;
  }
  return { endBlock, finalBlock: lastProcessedBlock, passes, boundaries };
}

// Heads a loop that keeps up is told about: the block before the start (emitOnBegin), then each one.
function everyBlock(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

test("the end block is runStartBlock + runBlocks, the block blocksRemaining reads 0 at", () => {
  const end = epochEndBlock(1000, 360);
  assert.equal(end, 1360);
  // The agents count from the same declared start (run-start.json, issue #117).
  const remainingAt = (bn: number) =>
    blocksRemainingUnderBlockBudget({
      bn,
      runBlocks: 360,
      declaredFirstBlock: 1000,
      firstSeenBlock: 1000,
      startupLagBlocks: 0,
    });
  assert.equal(remainingAt(1000), 360);
  assert.equal(remainingAt(1359), 1);
  assert.equal(remainingAt(1360), 0);
  assert.equal(epochEndBlock(1000, 0), null, "no block budget, no end block");
  assert.equal(epochEndBlock(1000, -5), null);
});

test("a loop that keeps up processes the end block and reads the 30th interval's boundary", () => {
  const run = simulateLoop({
    runStartBlock: 1000,
    runBlocks: 360,
    intervalBlocks: 12,
    notifications: everyBlock(999, 1400),
  });
  assert.equal(run.finalBlock, 1360);
  assert.equal(run.passes.at(-1)?.final, true);
  assert.equal(run.passes.at(-1)?.block, 1360);
  assert.deepEqual(run.boundaries, intervalBoundaryBlocks(1000, 1360, 12));
  assert.equal(run.boundaries.length, 31, "30 intervals, not 29");
  assert.equal(run.boundaries.at(-1), 1360);
});

test("a lagging loop ends on the same block, never past it", () => {
  // Catch-up passes of up to 14 blocks, as measured on crash#101 -- 36 of them, then 1-block steps.
  // Counting passes, 360 of these would have run the chain to 1432.
  const notifications = [999];
  let head = 999;
  for (let i = 0; i < 36; i++) notifications.push((head += 1 + (i % 14)));
  while (head < 1500) notifications.push(++head);
  const run = simulateLoop({
    runStartBlock: 1000,
    runBlocks: 360,
    intervalBlocks: 12,
    notifications,
  });
  assert.equal(run.finalBlock, 1360);
  assert.ok(
    run.passes.every((p) => p.block <= 1360),
    "no pass processes a block after the end",
  );
  assert.ok(
    run.passes.length < 361,
    "fewer passes than blocks: some caught up",
  );
  assert.deepEqual(run.boundaries, intervalBoundaryBlocks(1000, 1360, 12));
});

test("a final pass told about a head past the end processes through the end only", () => {
  // The loop was busy across the bell: the next notification is 9 blocks past it.
  const step = loopStep({
    lastProcessedBlock: 1355,
    notifiedBlock: 1369,
    endBlock: 1360,
  });
  assert.deepEqual(step, { fromBlock: 1356, block: 1360, final: true });
  const run = simulateLoop({
    runStartBlock: 1000,
    runBlocks: 360,
    intervalBlocks: 12,
    notifications: [...everyBlock(999, 1355), 1369, 1370],
  });
  assert.equal(run.finalBlock, 1360);
  assert.equal(run.passes.length, 358, "the pass at 1369 was the last");
  assert.equal(run.boundaries.at(-1), 1360);
});

test("a lagging loop cannot shorten the run either", () => {
  // Every pass sees a head behind the end: the loop keeps going until one reaches it.
  const step = loopStep({
    lastProcessedBlock: 1340,
    notifiedBlock: 1359,
    endBlock: 1360,
  });
  assert.equal(step.final, false);
  assert.equal(step.block, 1359);
});

test("a stale notification is passed through as it was, and is not the last pass", () => {
  // emitOnBegin reports the block before the run's first; the pass covers nothing new.
  const step = loopStep({
    lastProcessedBlock: 999,
    notifiedBlock: 999,
    endBlock: 1360,
  });
  assert.deepEqual(step, { fromBlock: 1000, block: 999, final: false });
});

test("with no block budget the loop is not clamped and never final", () => {
  const step = loopStep({
    lastProcessedBlock: 5000,
    notifiedBlock: 5014,
    endBlock: null,
  });
  assert.deepEqual(step, { fromBlock: 5001, block: 5014, final: false });
  assert.equal(nextIntervalBoundary(5004, 12, null), 5016);
});

test("off the grid: the end closes a short final interval and nothing follows it", () => {
  assert.equal(nextIntervalBoundary(1096, 12, 1100), 1100);
  assert.equal(nextIntervalBoundary(1100, 12, 1100), null);
  assert.equal(nextIntervalBoundary(1200, 12, 1100), null);
  const run = simulateLoop({
    runStartBlock: 1000,
    runBlocks: 100,
    intervalBlocks: 12,
    notifications: everyBlock(999, 1200),
  });
  assert.equal(run.finalBlock, 1100);
  assert.deepEqual(
    run.boundaries,
    [1000, 1012, 1024, 1036, 1048, 1060, 1072, 1084, 1096, 1100],
  );
});

test("interval count: every block of the run falls in one interval", () => {
  assert.equal(intervalCount(360, 12), 30);
  assert.equal(intervalCount(100, 12), 9);
  assert.equal(intervalCount(11, 12), 1);
  assert.equal(intervalCount(0, 12), 0);
  assert.equal(intervalCount(360, 0), 0);
});
