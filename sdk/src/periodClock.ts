// The period's clock: how long the run is, and where the scored day ends (ADR 0021 §2 / §6).
//
// A coordinator-spawned agent learns the run's length from its env (ERIS_RUN_BLOCKS) and its run
// directory (run-start.json, issue #117). A self-hosted agent has neither -- nobody spawns it, and
// its run directory is its own -- and has only the manifest. The manifest carried the chain and the
// interval but not the run's length, so the runtime fell back to whatever config it loaded: with no
// ERIS_CONFIG, the env defaults of no block limit and a 20-second time limit. `blocksRemaining` hit
// 0 twenty seconds after start and stayed there for the five weeks of the practice period.
//
// This is the manifest's `period` section, and the arithmetic both sides do with it:
//
//   blocksRemaining     until the run ends. `blocks` counted from `startBlock` is what the
//                       environment stops on; `endsAt` is the date that was converted from, and the
//                       fallback while the run has not started.
//   dayBlocksRemaining  until the scored day ends. A practice period ranks each day's return as one
//                       epoch (core/src/scoring/practiceReturn.ts), and the day is cut on the wall
//                       clock, on a fixed grid from the moment the period's clock started: day k ends
//                       at startedAt + (k + 1) x dayHours. The coordinator rolls at the first block
//                       it processes at or after that instant (core/src/segments.ts) and a runtime
//                       computes the same instant from the same two numbers, so what is left over is
//                       the two machines' clock disagreement and the block the roll lands in.
//
// Lives in sdk because both sides read it (`example → sdk ← core`).

/** The manifest's `period` section. */
export type ManifestPeriod = {
  /** When the run ends, as a date (`run.endsAt`), in UTC ISO 8601. null when stated in blocks. */
  endsAt: string | null;
  /**
   * The run's block budget, counted from `startBlock`: the number the environment stops on.
   * Absent when the run is stated as a date and has not started yet -- the date is converted into
   * blocks when the run starts, which a manifest written earlier cannot know.
   */
  blocks?: number;
  /**
   * The wall-clock ceiling (`run.seconds`), counted from `startedAt`. A run with episodes and a
   * block budget stops on the blocks and ignores it (ADR 0009 §4), so this is at most a later bound.
   */
  seconds: number;
  /** The run's first block, once the environment has declared it (run-start.json's number). */
  startBlock?: number;
  /** When the period's clock started (UTC ISO 8601): the origin of the day grid. */
  startedAt?: string;
  /** Hours per scored day. 0 when the run is scored as one epoch and has no days. */
  dayHours: number;
  note: string;
};

/**
 * Hours per scored day, or 0. A practice period is one continuous world cut into days, each scored
 * as one epoch; anything else -- a scenario epoch, a single `sim:realtime` run -- is one epoch, and
 * has no day that ends before the run does. The predicate is the dashboard's `isPracticePeriod`.
 */
export function scoredDayHours(config: {
  resetUnit: string;
  segmentHours: number;
}): number {
  return config.resetUnit === "continuous" && config.segmentHours > 0
    ? config.segmentHours
    : 0;
}

/**
 * The end of the day that contains `nowMs`, on the grid `startedAtMs + k x dayHours`. Before the
 * origin (a clock running behind the environment's) the first day is the one that counts.
 */
export function nextDayBoundaryMs(
  startedAtMs: number,
  dayHours: number,
  nowMs: number,
): number {
  const dayMs = dayHours * 3_600_000;
  const k = Math.max(0, Math.floor((nowMs - startedAtMs) / dayMs));
  return startedAtMs + (k + 1) * dayMs;
}

/** Blocks until the current day ends, at `blockTimeSec` a block. Never negative. */
export function dayBlocksRemaining(input: {
  startedAtMs: number;
  dayHours: number;
  nowMs: number;
  blockTimeSec: number;
}): number {
  const blockTimeSec = input.blockTimeSec > 0 ? input.blockTimeSec : 1;
  const endMs = nextDayBoundaryMs(
    input.startedAtMs,
    input.dayHours,
    input.nowMs,
  );
  return Math.max(0, Math.floor((endMs - input.nowMs) / 1000 / blockTimeSec));
}

/**
 * The manifest's `period`, validated. null when the manifest has none (one written before this
 * section existed). A section that is present and malformed throws: reading around it would put the
 * agent back on its local config's run length, which is the failure this section exists to remove.
 */
export function parseManifestPeriod(raw: unknown): ManifestPeriod | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error("manifest.period must be an object");
  const r = raw as Record<string, unknown>;
  const count = (key: string): number | undefined => {
    const v = r[key];
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      throw new Error(`manifest.period.${key} must be a non-negative number`);
    return v;
  };
  const date = (key: string): string | undefined => {
    const v = r[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string" || !Number.isFinite(Date.parse(v)))
      throw new Error(`manifest.period.${key} must be an ISO 8601 date`);
    return v;
  };
  const blocks = count("blocks");
  const startBlock = count("startBlock");
  const startedAt = date("startedAt");
  return {
    endsAt: date("endsAt") ?? null,
    ...(blocks !== undefined ? { blocks } : {}),
    seconds: count("seconds") ?? 0,
    ...(startBlock !== undefined ? { startBlock } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    dayHours: count("dayHours") ?? 0,
    note: typeof r.note === "string" ? r.note : "",
  };
}
