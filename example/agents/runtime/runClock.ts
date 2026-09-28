// How long the run is, for an agent nobody spawned (ADR 0021 §2), as pure functions.
//
// A coordinator-spawned agent is told its block budget in ERIS_RUN_BLOCKS and its first block in
// run-start.json (issue #117); that path is read.ts's and is not touched here. A self-hosted agent
// has neither, and took its run length from whatever config it loaded -- with no ERIS_CONFIG, the env
// defaults: no block limit and 20 seconds. `blocksRemaining` read 0 twenty seconds after start and
// stayed 0 for the five weeks of the practice period. A participant's own YAML is no better: the
// template says 100 blocks.
//
// The manifest's `period` (sdk/src/periodClock.ts) is the operator's statement of the run, so it wins
// over both: it is applied as explicit overrides when the config is loaded (so `ctx.config` says the
// same thing the observation does), and read.ts counts `blocksRemaining` from it.
import type { ManifestPeriod } from "@eris/sdk/periodClock.js";
import { blocksRemainingUnderBlockBudget } from "./blockBudget.js";

/**
 * Config overrides (internal env names, as `loadYamlConfig` and `loadConfig` read them) that make the
 * manifest's run length the loaded config's. They are passed explicitly: a YAML's source is built
 * from the file and the secret env keys only, so a plain env var would not reach it.
 *
 * Exactly one of `run.blocks` / `run.endsAt` is set and the other blanked -- the loader refuses both
 * (issue #136), and a participant's YAML may hold either.
 */
export function manifestRunOverrides(
  period: ManifestPeriod,
  blockTimeSec?: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  // The cadence the date converts at. The coordinator converted at its own; so does this.
  if (
    blockTimeSec !== undefined &&
    Number.isInteger(blockTimeSec) &&
    blockTimeSec > 0
  )
    out.ERIS_BLOCK_TIME_SEC = String(blockTimeSec);
  const blocks = period.blocks ?? 0;
  if (period.startBlock !== undefined && blocks > 0) {
    // Started: the number the environment stops on. Stated as blocks rather than re-converting the
    // date, which would count from this process's start instead of the run's.
    out.ERIS_RUN_BLOCKS = String(blocks);
    out.ERIS_RUN_ENDS_AT = "";
  } else if (period.endsAt !== null) {
    out.ERIS_RUN_ENDS_AT = period.endsAt;
    out.ERIS_RUN_BLOCKS = "";
  } else {
    out.ERIS_RUN_BLOCKS = String(blocks);
    out.ERIS_RUN_ENDS_AT = "";
  }
  out.ERIS_RUN_SECONDS = String(period.seconds);
  out.ERIS_SEGMENT_HOURS = String(period.dayHours);
  return out;
}

export type SelfHostedBudgetInput = {
  period: ManifestPeriod;
  /** The block being observed. */
  bn: number;
  nowMs: number;
  blockTimeSec: number;
  /** The first block this process observed, and the blocks its boot took (the inferred origin). */
  firstSeenBlock: number;
  startupLagBlocks: number;
  /** When this process started: the time ceiling's origin when the manifest has no `startedAt`. */
  processStartedAtMs: number;
};

/**
 * Blocks left in the run for a self-hosted agent, or undefined when the run has no limit. In order
 * of preference:
 *   1. `blocks` counted from `startBlock` -- exact, the environment's own stop condition
 *   2. `endsAt` at the published cadence -- the manifest was written before the run started. If the
 *      chain runs behind its cadence the run ends a little after the date, so this is low, never high
 *   3. `blocks` from the first block this process saw -- a run stated in blocks whose start the
 *      manifest does not know. High by however long the run had been going when this process joined
 * and `seconds`, the ceiling, from `startedAt` (from this process's start without one, which can only
 * put the ceiling later than it is). Whichever ends first ends the run.
 */
export function selfHostedBlocksRemaining(
  input: SelfHostedBudgetInput,
): number | undefined {
  const { period, bn, nowMs } = input;
  const blockTimeSec = input.blockTimeSec > 0 ? input.blockTimeSec : 1;
  const blocks = period.blocks ?? 0;
  const budgets: number[] = [];
  if (period.startBlock !== undefined && blocks > 0)
    budgets.push(blocks - (bn - period.startBlock));
  else if (period.endsAt !== null)
    budgets.push(
      Math.floor((Date.parse(period.endsAt) - nowMs) / 1000 / blockTimeSec),
    );
  else if (blocks > 0)
    budgets.push(
      blocksRemainingUnderBlockBudget({
        bn,
        runBlocks: blocks,
        declaredFirstBlock: null,
        firstSeenBlock: input.firstSeenBlock,
        startupLagBlocks: input.startupLagBlocks,
      }) as number,
    );
  if (period.seconds > 0) {
    const originMs =
      period.startedAt !== undefined
        ? Date.parse(period.startedAt)
        : input.processStartedAtMs;
    budgets.push(
      Math.floor(
        (originMs + period.seconds * 1000 - nowMs) / 1000 / blockTimeSec,
      ),
    );
  }
  if (budgets.length === 0) return undefined;
  return Math.max(0, Math.min(...budgets));
}

/** Where a self-hosted agent's `blocksRemaining` comes from, for the one line the runtime logs. */
export function describeSelfHostedBudget(period: ManifestPeriod): string {
  const blocks = period.blocks ?? 0;
  if (period.startBlock !== undefined && blocks > 0)
    return `blocksRemaining is counted from the manifest: ${blocks} blocks from block ${period.startBlock}`;
  if (period.endsAt !== null)
    return (
      `blocksRemaining is counted to the manifest's end date (${period.endsAt}); the manifest was ` +
      "written before the run declared its first block, so it is low by however far the chain " +
      "runs behind its cadence"
    );
  if (blocks > 0)
    return (
      `blocksRemaining is inferred: the manifest states ${blocks} blocks but not the block they ` +
      "start from, so they are counted from the first block this process saw"
    );
  return "the manifest states no block limit: blocksRemaining is absent unless run.seconds ends the run";
}
