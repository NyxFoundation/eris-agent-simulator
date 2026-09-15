// The run's first block, declared by the coordinator to the agent processes (issue #117).
//
// An agent process is spawned before interval mining starts, so the block the run is counted from
// does not exist when its env is built -- which is why `read.ts` used to anchor `blocksRemaining` on
// the first block the agent itself observed. Any jump in block numbers after that point (anvil
// flushing its automine backlog when the mining mode changes, a resume into a world whose head
// moved) was then charged against the run: with a 221-block flush every agent believed a 360-block
// run had 140 blocks left at relative block 1, and every "exit before the end" rule fired inside
// the launch window (PR #116).
//
// The coordinator knows the number the moment it derives `runStartBlock`, and the run directory is
// the one channel both sides already share after spawn (the agent writes its log there; the docker
// sandbox mounts it). So the coordinator writes this file there, once, and the runtime reads it
// lazily until it appears. Env would have been simpler and is impossible; events.jsonl is the
// coordinator's record, not an agent-facing contract, and is not tailed by the runtime.
//
// Lives in sdk because both sides read the format (`example → sdk ← core`).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RUN_START_FILE = "run-start.json";

export type RunStart = {
  schema: 1;
  /** The first block the coordinator counts as the run's (the block after the backlog settled). */
  runStartBlock: number;
  /** The resolved block budget, the same number the agent has in ERIS_RUN_BLOCKS (0 = unbounded). */
  runBlocks: number;
  writtenAt: string;
};

export function runStartPath(runDir: string): string {
  return join(runDir, RUN_START_FILE);
}

/** Write atomically (rename), so a reader never sees a half-written file. */
export function writeRunStart(
  runDir: string,
  start: { runStartBlock: number; runBlocks: number },
): RunStart {
  const record: RunStart = {
    schema: 1,
    runStartBlock: start.runStartBlock,
    runBlocks: start.runBlocks,
    writtenAt: new Date().toISOString(),
  };
  const path = runStartPath(runDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, path);
  return record;
}

/**
 * The declaration, or null while it does not exist yet (the agent booted before the coordinator
 * started counting) or cannot be read as one. A malformed file is treated as absent rather than
 * thrown on: the budget falls back to the inferred origin, which is what it was before this file.
 */
export function readRunStart(runDir: string | undefined): RunStart | null {
  if (!runDir) return null;
  const path = runStartPath(runDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunStart>;
    if (
      parsed.schema !== 1 ||
      typeof parsed.runStartBlock !== "number" ||
      !Number.isInteger(parsed.runStartBlock) ||
      typeof parsed.runBlocks !== "number"
    )
      return null;
    return parsed as RunStart;
  } catch {
    return null;
  }
}
