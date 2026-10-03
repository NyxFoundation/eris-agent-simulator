/**
 * agentState.ts: the per-agent persistent area the organizer provides (#77).
 *
 * Every epoch used to start each agent from `agent.ts` as version 0, so in-run self-improvement
 * (ADR 0018) was worth at most the remainder of one epoch and was then thrown away. Carrying it is
 * a runtime feature (`example/agents/runtime/state.ts`), an infrastructure feature (this file), and
 * a rules amendment (§4.7.1; see docs/proposals/cross-epoch-learning-rules.md).
 *
 * What the environment owes each participating unit is a directory that:
 *
 *   - only that agent can see. The old arrangement bind-mounted the whole of `runs/` into every
 *     container, so state carry-over was already possible through a path nobody designed for it --
 *     and the same mount let an agent read every other epoch's `events.jsonl`. The state directory
 *     replaces that use, and `infra/docker-agent/run-agent.sh` narrows the log mount to the run the
 *     agent is actually in.
 *   - survives every epoch of the competition, and
 *   - is snapshotted at the start of each epoch, because §4.4.2 lets a voided epoch be re-run with
 *     the same seed. A re-run that starts from the state the *first* attempt ended with is a
 *     different experiment, not a re-run.
 *
 * Off unless a root is configured. Every path that existed before this -- a single backtest, a
 * practice devnet, a matrix without `--agent-state-root` -- keeps starting each agent from
 * `agent.ts`, which is also what the frozen control does forever.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import {
  measureTree,
  regularEntriesOnly,
  type TreeLimits,
  type TreeUsage,
} from "./dirUsage.js";

/** Where the per-agent directories live. Set by `backtest --agent-state-root` or by the operator. */
export const AGENT_STATE_ROOT_ENV = "ERIS_AGENT_STATE_ROOT";

/** Subdirectory of the root holding the per-epoch snapshots. Not an agent id, hence the dot. */
export const SNAPSHOT_DIR = ".snapshots";

/**
 * How many epoch snapshots are kept.
 *
 * One per epoch per agent, each a copy of a directory that may be up to the cap. Over a k = 60
 * competition with a full roster that is tens of gigabytes of copies of state nobody is going to
 * re-run: §4.4.2 voids an epoch and re-runs it promptly or not at all. Keeping the recent ones is
 * the guarantee; keeping all of them is a disk that fills quietly, halfway through a competition.
 */
export const SNAPSHOTS_KEPT = Number(process.env.ERIS_AGENT_STATE_SNAPSHOTS ?? 8);

/** The env var the agent runtime reads (`example/agents/runtime/state.ts`). */
export const AGENT_STATE_DIR_ENV = "ERIS_AGENT_STATE_DIR";

/**
 * What a state directory may hold for the environment to copy it (issue #214 item 2).
 *
 * The directory is participant-written, and the epoch-start snapshot copies it on the coordinator's
 * startup path. Measured 2026-10-02 (Node 23.5, APFS): `cpSync` over a tree with one FIFO throws
 * ERR_INTERNAL_ASSERTION -- so without this check a named pipe in one agent's state stops the next
 * epoch for everyone -- and a sparse file of 1 GiB apparent size is copied as 1 GiB of real bytes,
 * by the filtered copy as well as the plain one. Hence a cap on the *apparent* size, a cap on the
 * entry count (each entry is an lstat and a copy), a depth cap, and regular files and directories
 * only. `maxBytes` defaults to the host quota (`run.agentStateQuotaBytes`), which is also what the
 * per-block watch holds the directory to (agentDisk.ts).
 */
export type StateDirLimits = TreeLimits & { maxBytes: number };

export const DEFAULT_STATE_SNAPSHOT_LIMITS: StateDirLimits = {
  maxBytes: 256 * 1024 * 1024,
  maxEntries: 20_000,
  maxDepth: 16,
};

export type StateDirVerdict =
  | { ok: true; usage: TreeUsage }
  | { ok: false; reason: string; usage: TreeUsage };

/** Whether `dir` is something the environment will copy. Never throws. */
export function validateStateDir(
  dir: string,
  limits: StateDirLimits = DEFAULT_STATE_SNAPSHOT_LIMITS,
): StateDirVerdict {
  const usage = measureTree(dir, limits);
  const reasons: string[] = [];
  if (usage.error !== undefined) reasons.push(`unreadable: ${usage.error}`);
  if (usage.irregularCount > 0)
    reasons.push(
      `${usage.irregularCount} entr${usage.irregularCount === 1 ? "y" : "ies"} that ` +
        `${usage.irregularCount === 1 ? "is" : "are"} not a regular file or directory (` +
        usage.irregular.map((e) => `${e.path}: ${e.kind}`).join(", ") +
        (usage.irregularCount > usage.irregular.length ? ", ..." : "") +
        ")",
    );
  if (usage.truncated)
    reasons.push(
      `more than ${limits.maxEntries} entries or deeper than ${limits.maxDepth} levels ` +
        `(stopped at ${usage.entries} entries, depth ${usage.depth})`,
    );
  if (usage.apparentBytes > limits.maxBytes)
    reasons.push(
      `${usage.apparentBytes} bytes to copy, cap ${limits.maxBytes}` +
        (usage.allocatedBytes < usage.apparentBytes
          ? ` (${usage.allocatedBytes} allocated on disk: sparse)`
          : ""),
    );
  return reasons.length === 0
    ? { ok: true, usage }
    : { ok: false, reason: reasons.join("; "), usage };
}

// An agent id reaches this from the roster, and it is joined onto a path. A traversal here would
// let a roster entry name a directory outside the root -- including, on a shared box, another
// participant's. Ids are directory names by ADR 0015 §6, so this refuses rather than sanitizes:
// a rewritten id would silently point two agents at one state directory.
function assertPathSegment(id: string): void {
  if (id === "" || id === "." || id === ".." || /[\\/]/.test(id))
    throw new Error(
      `agent id ${JSON.stringify(id)} cannot be used as a state directory name`,
    );
}

export function agentStateRootFromEnv(env = process.env): string | undefined {
  const root = env[AGENT_STATE_ROOT_ENV];
  return root && root.trim() !== "" ? root : undefined;
}

/** What `prepareAgentState` hands the coordinator. */
export type PreparedAgentState = {
  /** The directory the agent is given: its own, or a fresh one when its own was refused. */
  dir: string;
  usage: TreeUsage;
  /**
   * Set when the directory the agent left behind failed `validateStateDir`. It was moved aside to
   * `refusedTo` (a rename, so nothing in it was read or copied), the agent starts this epoch from an
   * empty directory, and the snapshot is of that empty start. Persistence continues from here: an
   * agent whose directory had been refused for good would have no way to repair it, since the only
   * access it has is through the directory itself.
   */
  refused?: { reason: string; refusedTo: string };
};

/**
 * The directory this agent gets for this epoch, with the epoch-start snapshot already taken.
 *
 * The snapshot is taken *before* the agent starts, so it holds what the epoch began with. Restoring
 * it (`restoreAgentState`) is what makes a §4.4.2 re-run a re-run.
 *
 * The directory is validated before anything copies it (issue #214 item 2; `StateDirLimits`). A
 * refusal is the participant's doing, so it is not fatal to the run: the directory is set aside
 * and the agent starts empty, with `refused` on the result for the coordinator to record.
 */
export function prepareAgentState(
  root: string,
  agentId: string,
  runId: string,
  limits: StateDirLimits = DEFAULT_STATE_SNAPSHOT_LIMITS,
): PreparedAgentState {
  assertPathSegment(agentId);
  assertPathSegment(runId);
  const dir = join(root, agentId);
  mkdirSync(dir, { recursive: true });
  let verdict = validateStateDir(dir, limits);
  let refused: PreparedAgentState["refused"];
  if (!verdict.ok) {
    // A rename, never a read: the whole point is that this tree is not safe to walk at copy speed.
    let refusedTo = `${dir}.refused-${runId}`;
    for (let n = 2; existsSync(refusedTo); n++)
      refusedTo = `${dir}.refused-${runId}-${n}`;
    renameSync(dir, refusedTo);
    mkdirSync(dir, { recursive: true });
    refused = { reason: verdict.reason, refusedTo };
    verdict = validateStateDir(dir, limits);
  }
  const snapshot = join(root, SNAPSHOT_DIR, runId, agentId);
  // A second attempt at the same runId must not overwrite the snapshot with the state the first
  // attempt left behind -- that is precisely the state a re-run must not inherit.
  if (!existsSync(snapshot)) {
    mkdirSync(join(root, SNAPSHOT_DIR, runId), { recursive: true });
    // Copied to a sibling and renamed, for the same reason the restore swaps rather than copies in
    // place: a copy killed halfway leaves a directory that exists, is incomplete, and would pass the
    // `existsSync` check above and be restored as if it were the epoch's starting state.
    const staging = `${snapshot}.partial`;
    rmSync(staging, { recursive: true, force: true });
    // The filter is the second line behind the validation above, for whatever appears between the
    // two: a symlink or a pipe is skipped rather than followed or opened.
    cpSync(dir, staging, { recursive: true, filter: regularEntriesOnly });
    renameSync(staging, snapshot);
  }
  pruneSnapshots(root);
  return { dir, usage: verdict.usage, ...(refused ? { refused } : {}) };
}

// A snapshot directory named by a run id, as prepareAgentState writes them. Run ids are ISO
// timestamps with the punctuation replaced (2026-09-07T02-52-31-293Z).
export function isRunIdSnapshot(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/.test(name);
}

// Keep the most recent epoch snapshots and drop the rest. Only the per-epoch ones, named by run id:
// a label written by snapshotAllAgentState is a caller's checkpoint -- the state a scenario ended
// with, which a resumed matrix restores before re-running the one after it (backtest/resume.ts),
// or the base a --repeat returns to -- and pruning one of those turns a restore into a silent
// no-op halfway through a competition. Labels are bounded by the plan (one per ordinal) and are the
// operator's to delete once the matrix is final.
function pruneSnapshots(root: string, keep = SNAPSHOTS_KEPT): void {
  if (!Number.isFinite(keep) || keep <= 0) return;
  const base = join(root, SNAPSHOT_DIR);
  if (!existsSync(base)) return;
  let entries: string[];
  try {
    entries = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isRunIdSnapshot(e.name))
      .map((e) => e.name);
  } catch {
    return;
  }
  if (entries.length <= keep) return;
  const byAge = entries
    .map((name) => {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(base, name)).mtimeMs;
      } catch {
        // unreadable: treat as oldest, so a directory nothing can stat is the first to go
      }
      return { name, mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  for (const { name } of byAge.slice(0, byAge.length - keep))
    rmSync(join(base, name), { recursive: true, force: true });
}

/**
 * Put an agent's state back to what the named epoch started with (rules §4.4.2).
 *
 * Returns false when there is no snapshot for that epoch, which is the honest answer: an epoch that
 * was never run under persistence cannot be re-run under it.
 */
export function restoreAgentState(
  root: string,
  agentId: string,
  runId: string,
): boolean {
  assertPathSegment(agentId);
  assertPathSegment(runId);
  const snapshot = join(root, SNAPSHOT_DIR, runId, agentId);
  if (!existsSync(snapshot)) return false;
  swapIn(snapshot, join(root, agentId));
  return true;
}

// Replace `dir` with a copy of `from`, without a window in which `dir` is neither.
//
// The obvious `rm -rf` then `cp -r` destroys the agent's state first and restores it second, so a
// copy that fails halfway -- a full disk, a permission -- leaves nothing at all. Copy to a sibling,
// then swap: a failure before the swap loses only the copy.
function swapIn(from: string, dir: string): void {
  const staging = `${dir}.restoring`;
  const outgoing = `${dir}.outgoing`;
  rmSync(staging, { recursive: true, force: true });
  rmSync(outgoing, { recursive: true, force: true });
  cpSync(from, staging, { recursive: true, filter: regularEntriesOnly });
  if (existsSync(dir)) renameSync(dir, outgoing);
  renameSync(staging, dir);
  rmSync(outgoing, { recursive: true, force: true });
}

/**
 * Snapshot every agent's state under one label, and put it all back.
 *
 * The per-epoch snapshot above is keyed by run id, which is what §4.4.2 needs. This pair is for the
 * caller that does not have one yet: `backtest --repeat N` runs the *same* scenario N times and
 * takes the median, and with state carrying, repeat 2 would start from what repeat 1 left behind.
 * That is not a repeat, it is a sequence -- and the spread across repeats is the whole point of the
 * flag (ADR 0005 reads results as a distribution).
 *
 * Cost: one copy of the whole root per label. At 64 MiB an agent that is a rounding error next to
 * the state dump, and the labels are the operator's to delete.
 */
export function snapshotAllAgentState(
  root: string,
  label: string,
  limits: StateDirLimits = DEFAULT_STATE_SNAPSHOT_LIMITS,
): Array<{ agentId: string; reason: string }> {
  assertPathSegment(label);
  const target = join(root, SNAPSHOT_DIR, label);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  // An agent directory that fails validation is left out of the checkpoint rather than copied
  // (issue #214 item 2): the copy is what the validation exists to prevent. The caller records who
  // was skipped; a later restore of this label puts that agent back to *nothing*, which is the
  // honest result of a checkpoint that could not include it.
  const skipped: Array<{ agentId: string; reason: string }> = [];
  for (const agentId of agentDirs(root)) {
    const verdict = validateStateDir(join(root, agentId), limits);
    if (!verdict.ok) {
      skipped.push({ agentId, reason: verdict.reason });
      continue;
    }
    cpSync(join(root, agentId), join(target, agentId), {
      recursive: true,
      filter: regularEntriesOnly,
    });
  }
  utimesSync(target, new Date(), new Date());
  return skipped;
}

export function restoreAllAgentState(root: string, label: string): boolean {
  assertPathSegment(label);
  const target = join(root, SNAPSHOT_DIR, label);
  if (!existsSync(target)) return false;
  const carried = new Set(agentDirs(target));
  // An agent that only appeared during the run being undone is removed, not left behind as one
  // nobody ran.
  for (const agentId of agentDirs(root))
    if (!carried.has(agentId))
      rmSync(join(root, agentId), { recursive: true, force: true });
  for (const agentId of carried)
    swapIn(join(target, agentId), join(root, agentId));
  return true;
}

// The agent directories under a root: every child except the snapshot store, which is why that one
// is named with a leading dot rather than with something an agent id could collide with.
function agentDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        e.name !== SNAPSHOT_DIR &&
        // Left over from a restore that was killed mid-swap. Not an agent, and copying one into a
        // snapshot would make it one on the next restore.
        !e.name.endsWith(".restoring") &&
        !e.name.endsWith(".outgoing") &&
        // Set aside by prepareAgentState because it could not be copied (issue #214). Kept for the
        // operator to look at; not an agent, and not something a checkpoint should try to copy.
        !/\.refused-/.test(e.name),
    )
    .map((e) => e.name);
}
