// Where an epoch ends, and which blocks its evaluation-interval boundaries sit on.
//
// The epoch is defined on chain block numbers. It starts at the block the coordinator declares
// (`runStartBlock`, run-start.json, issue #117) and ends at `runStartBlock + runBlocks`: that block
// is processed, it is the epoch's last valuation boundary (V_K, rules §4.4.1), and it is the block at
// which every agent reads `blocksRemaining === 0` -- the bell. A transaction sent after observing it
// lands after the end and is not part of the epoch; one sent when `blocksRemaining` reads 1 lands on
// the bell block and is.
//
// It used to be defined on loop iterations. The coordinator ended the run after `runBlocks` passes of
// its block handler, and one pass covers every block mined since the previous one -- so a loop that
// fell behind (`round_timing.blocksCaughtUp` > 1) ran the chain past the point where the agents had
// been told the run was over (measured on a loaded laptop: crash#101 ran 432 chain blocks for 360
// iterations, and its last boundary was 72 blocks after `blocksRemaining` reached 0). And even a
// loop that kept up never reached the boundary that closes the last interval, so the score's V_K was
// read 12 blocks before the bell and 29 of 30 intervals were scored.
//
// When runBlocks is not a multiple of intervalBlocks, the interval grid is kept (every boundary but
// the last sits on runStartBlock + k·intervalBlocks, the same grid the live scorer walks and the
// practice segments are cut on) and the final interval is the remainder: shorter than the others,
// closed by the end block. The score reads only the first and the last boundary, so the short
// interval changes nothing about P; it is only what the interim-progress bar shows last.
//
// Pure: the dashboard imports this through the `@core` alias.

/**
 * The block the epoch ends on (its last boundary; the bell), or null when the run has no block
 * budget -- a run bounded only by the wall clock ends wherever its loop last got to.
 */
export function epochEndBlock(
  runStartBlock: number,
  runBlocks: number,
): number | null {
  if (!(runBlocks > 0) || !Number.isFinite(runBlocks)) return null;
  return runStartBlock + Math.floor(runBlocks);
}

/** What one pass of the coordinator's block handler covers. */
export type LoopStep = {
  /** The first block this pass has not seen before. */
  fromBlock: number;
  /** The block the pass processes through: the notified head, but never past the end. */
  block: number;
  /** True when this pass reaches the end block: the last pass of the run. */
  final: boolean;
};

/**
 * One pass of the block handler, clamped to the epoch.
 *
 * The handler drops notifications while it is busy, so a pass can be told about a head several
 * blocks past the last one it processed. Every consumer reads the range [fromBlock, block]; clamping
 * `block` to the end is what keeps a lagging loop from valuing, scheduling or observing anything
 * after the bell, and ending on the end block rather than on a pass count is what keeps it from
 * running past it.
 */
export function loopStep(input: {
  lastProcessedBlock: number;
  notifiedBlock: number;
  endBlock: number | null;
}): LoopStep {
  const { lastProcessedBlock, notifiedBlock, endBlock } = input;
  const block =
    endBlock === null ? notifiedBlock : Math.min(notifiedBlock, endBlock);
  return {
    fromBlock: lastProcessedBlock + 1,
    block,
    final: endBlock !== null && block >= endBlock,
  };
}

/**
 * The boundary after `boundary`: one interval on, but never past the end. Null once `boundary` is the
 * end (there is nothing after it). With no end the grid continues.
 */
export function nextIntervalBoundary(
  boundary: number,
  intervalBlocks: number,
  endBlock: number | null,
): number | null {
  if (endBlock !== null && boundary >= endBlock) return null;
  const next = boundary + intervalBlocks;
  return endBlock === null ? next : Math.min(next, endBlock);
}

/**
 * Every boundary of an epoch that starts at `fromBlock` and ends at `toBlock`: `fromBlock`, each
 * `intervalBlocks` after it, and `toBlock` itself as the last one. N intervals need N+1 boundaries.
 * Empty when the series is disabled (a non-positive or fractional-below-one interval length) or the
 * window has no block after its first.
 */
export function intervalBoundaryBlocks(
  fromBlock: number,
  toBlock: number,
  intervalBlocks: number,
): number[] {
  const step = Math.floor(intervalBlocks);
  if (!Number.isFinite(step) || step < 1) return [];
  if (!(toBlock > fromBlock)) return [];
  const boundaries = [fromBlock];
  for (
    let b = nextIntervalBoundary(fromBlock, step, toBlock);
    b !== null;
    b = nextIntervalBoundary(b, step, toBlock)
  )
    boundaries.push(b);
  return boundaries;
}

/** How many evaluation intervals a run of `runBlocks` has (the last one may be short). */
export function intervalCount(
  runBlocks: number,
  intervalBlocks: number,
): number {
  return Math.max(
    0,
    intervalBoundaryBlocks(0, runBlocks, intervalBlocks).length - 1,
  );
}
