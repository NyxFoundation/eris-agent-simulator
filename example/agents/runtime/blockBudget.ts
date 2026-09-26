// How many blocks of the run are left, as a pure function (issue #117).
//
// Two origins, in order of preference:
//   1. The coordinator's declaration (`run-start.json`): the run is `runBlocks` long counted from
//      `runStartBlock`, so the remainder is arithmetic on the current block number. A block-number
//      jump between two observations changes nothing -- the origin is not this process's memory.
//   2. Inferred: the first block this process saw, less the blocks its own boot took. The formula
//      the runtime had before the declaration existed, kept for a self-hosted agent (ADR 0021) that
//      has no run directory to read. Any discontinuity in block numbers after boot is charged
//      against the run here, which is the defect the declaration removes.
export type BlockBudgetInput = {
  /** The block being observed. */
  bn: number;
  /** The run's block budget (ERIS_RUN_BLOCKS / config.runBlocks). <= 0 means no block limit. */
  runBlocks: number;
  /** The coordinator's declared first block, when the declaration has been read. */
  declaredFirstBlock: number | null;
  /** The first block this process observed (the inferred origin). */
  firstSeenBlock: number;
  /** Blocks the process spent booting before it first observed one (charged in the inferred case). */
  startupLagBlocks: number;
};

/** Blocks remaining under the block budget, or null when the run has no block limit. */
export function blocksRemainingUnderBlockBudget(
  input: BlockBudgetInput,
): number | null {
  if (!(input.runBlocks > 0)) return null;
  if (input.declaredFirstBlock !== null)
    return input.runBlocks - (input.bn - input.declaredFirstBlock);
  return (
    input.runBlocks - input.startupLagBlocks - (input.bn - input.firstSeenBlock)
  );
}
