/**
 * agentDisk.ts: how much an agent has written to the host, held to a quota (issue #214 item 1).
 *
 * An agent container can write to two places that outlive the container: its state directory
 * (`/eris/state`, issue #77) and its own log files under `runs/<id>/agents/`. The caps on both are
 * the *reference runtime's* self-limits (`state.ts`, `agentLog.ts`: 64 MiB each), which a submitted
 * runtime bypasses with one `fs.writeFileSync`. Only `/tmp` is a size-capped tmpfs. A host that
 * reaches ENOSPC takes the coordinator down with it -- the 2026-09-10 `anvil-state` outage, with a
 * participant's hand on it this time -- and over k = 60 epochs one agent does not need one epoch.
 *
 * So the coordinator measures, every N blocks, what each launched agent holds in both places and
 * stops the agent past the quota. The agent process is stopped, not the run: rules §2.3 / §4.4.2
 * value a stopped agent on what it left behind. A host-side quota (XFS project quota, a loop
 * device, a tmpfs at the state root) is the stronger line and is the operator's to provision
 * (infra/devnet/CHECKLIST.md); this watch is the one that works on any filesystem.
 *
 * Measuring is itself work a participant can make expensive, and stopping is something that can fail
 * (issue #223). So the field is swept across ticks under a time budget (`DISK_TICK_BUDGET_MS`), and a
 * stopped agent keeps being measured until its files stop growing (`STOPPED_GROWTH_SLACK_BYTES`) --
 * a quota the environment detects but does not enforce is only an event in a log.
 *
 * Pure decision (`diskVerdict`) kept apart from the measurement (`measureAgentDisk`), so the rule
 * is testable without a disk and the measurement without a coordinator.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { bytesOnDisk, measureTree, type TreeLimits, type TreeUsage } from "./dirUsage.js";

export type DiskQuota = {
  /** Bytes the state directory may hold (`run.agentStateQuotaBytes`). */
  stateBytes: number;
  /** Bytes the agent's log files may hold together (`run.agentLogQuotaBytes`). */
  logBytes: number;
};

export type AgentDiskSample = {
  /** Bytes on disk of the state directory, or null when the run gives the agent none. */
  stateBytes: number | null;
  /** The walk behind `stateBytes`, for the record (entries, truncation, irregular entries). */
  stateUsage?: TreeUsage;
  /** Bytes of the agent's log files together. A file that does not exist counts 0. */
  logBytes: number;
};

export type DiskVerdict = {
  level: "ok" | "warning" | "exceeded";
  /** One line per place that is over its warning fraction or its quota. */
  findings: string[];
};

/** Past this fraction of a quota the agent is named once in `agent_disk_usage_warning`. */
export const DISK_WARNING_FRACTION = 0.8;

// The walk is bounded so the measurement cannot be made expensive by the directory it measures. A
// state directory with more entries than this is itself over what the snapshot admits
// (agentState.ts), so the truncated total being a lower bound changes nothing: the agent is already
// past a line.
export const DISK_WALK_LIMITS: TreeLimits = { maxEntries: 20_000, maxDepth: 16 };

/** The log files an agent of this id writes under the run directory (agentLog.ts). */
export function agentLogFiles(runDir: string, agentId: string): string[] {
  return [
    join(runDir, "agents", `${agentId}.jsonl`),
    join(runDir, "agents", `${agentId}.llm.jsonl`),
  ];
}

function fileBytes(path: string): number {
  try {
    const st = statSync(path);
    // A log can be made sparse too; the quota is the larger of the two views, as for the state.
    return Math.max(st.size, st.blocks * 512);
  } catch {
    return 0;
  }
}

/** Measure one agent. Never throws: an unreadable directory reads as what could be read of it. */
export function measureAgentDisk(opts: {
  stateDir?: string;
  logFiles: string[];
  limits?: TreeLimits;
}): AgentDiskSample {
  const sample: AgentDiskSample = {
    stateBytes: null,
    logBytes: opts.logFiles.reduce((sum, f) => sum + fileBytes(f), 0),
  };
  if (opts.stateDir !== undefined) {
    const usage = measureTree(opts.stateDir, opts.limits ?? DISK_WALK_LIMITS);
    sample.stateBytes = bytesOnDisk(usage);
    sample.stateUsage = usage;
  }
  return sample;
}

const mib = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MiB`;

/** The rule: over a quota is `exceeded`, over the warning fraction of one is `warning`. */
export function diskVerdict(
  sample: AgentDiskSample,
  quota: DiskQuota,
  warningFraction = DISK_WARNING_FRACTION,
): DiskVerdict {
  const findings: string[] = [];
  let level: DiskVerdict["level"] = "ok";
  const check = (what: string, bytes: number | null, cap: number): void => {
    if (bytes === null || cap <= 0) return;
    if (bytes > cap) {
      level = "exceeded";
      findings.push(`${what} ${mib(bytes)} over the ${mib(cap)} quota`);
    } else if (bytes > cap * warningFraction) {
      if (level === "ok") level = "warning";
      findings.push(
        `${what} ${mib(bytes)} at ${Math.round((bytes / cap) * 100)}% of the ${mib(cap)} quota`,
      );
    }
  };
  check("state directory", sample.stateBytes, quota.stateBytes);
  check("log files", sample.logBytes, quota.logBytes);
  // A state walk that hit its bound is already past what the epoch-start snapshot admits; said
  // here so the operator sees it before the next epoch refuses the directory.
  if (sample.stateUsage?.truncated) {
    if (level === "ok") level = "warning";
    findings.push(
      `state directory walk stopped at ${sample.stateUsage.entries} entries / depth ` +
        `${sample.stateUsage.depth}: the total is a lower bound and the next snapshot will refuse it`,
    );
  }
  return { level, findings };
}

export type DiskWatchTarget = {
  id: string;
  stateDir?: string;
  logFiles: string[];
};

export type DiskWatchOutcome = {
  id: string;
  sample: AgentDiskSample;
  verdict: DiskVerdict;
  /**
   * What the caller should record and do.
   *
   * `warning` is reported the first time an agent crosses the fraction, not on every tick.
   * `still-writing` is an agent *already* stopped for a quota whose files have grown since: whatever
   * is writing them did not stop when the process the coordinator spawned did, and the caller has to
   * escalate past that process.
   */
  report: "none" | "warning" | "exceeded" | "still-writing";
  /** For `still-writing`: bytes added since this agent was last accounted for. */
  grewBytes?: number;
};

export type DiskTick = {
  /** One entry per agent *measured* this tick, which is not every agent in the rotation. */
  outcomes: DiskWatchOutcome[];
  /** Agents in the rotation this tick. */
  rotation: number;
  /** What the measurements cost, in milliseconds. */
  elapsedMs: number;
  /** Set when this tick closed a pass over the whole rotation, and in how many ticks. */
  sweep?: { ticks: number };
};

/**
 * How long one tick may spend measuring before it stops and the next one resumes where it stopped.
 *
 * `DISK_WALK_LIMITS.maxEntries` bounds one walk, but 20,000 entries is *allowed*, and `diskVerdict`
 * only warns about a truncated walk -- so an agent sitting on 20,001 one-byte files is walked in full
 * on every tick for the rest of the run. Measured 2026-10-03 (APFS, warm cache): 101 ms for a
 * 20,000-entry directory, and the reviewer's box 245 ms. Thirty-two agents of that shape is 3-8
 * seconds of synchronous work inside a loop that owes the chain a block every two seconds, and the
 * oracle write, the GMX keeper and the flow all wait behind it. A quota does not stop this: one byte
 * per file is enough.
 *
 * So the field is swept across ticks. The cost of a tick is the budget plus the one walk that
 * overran it -- a walk's cost is not knowable before doing it, and at least one agent is measured per
 * tick or nothing is ever measured at all. A field of honest agents (a handful of state files each)
 * still measures in a single tick, so the quota is noticed as quickly as it was before; it is only a
 * field built to be expensive that takes several.
 */
export const DISK_TICK_BUDGET_MS = 200;

/**
 * Growth past which a stopped agent's files are read as "something is still writing them".
 *
 * Not zero: a runtime that does stop on SIGTERM may flush a last line to its log, and the host-side
 * file is the one being measured. A few kilobytes of flush is not a container that outlived its
 * stop; a container that is still trading writes far more than this between ticks.
 */
export const STOPPED_GROWTH_SLACK_BYTES = 64 * 1024;

const totalBytes = (sample: AgentDiskSample): number =>
  (sample.stateBytes ?? 0) + sample.logBytes;

/**
 * The per-tick driver: measures part of the field, remembers who has been warned so a warning is one
 * event per crossing rather than one per tick, and hands back what the caller should record and whom
 * it should stop. Stopping is the caller's (it owns the processes and the containers).
 *
 * Two things the caller has to know. **A tick measures what fits in its budget**, resuming next tick
 * where it stopped, so `outcomes` covers part of the rotation and `sweep` says when a pass closed.
 * And **an agent stopped for a quota stays in the rotation**: `close()` reaches the process the
 * coordinator spawned, which under the docker sandbox is the `docker run` client rather than the
 * container, so whether the writing stopped is something to measure and not to assume. It is
 * reported as `still-writing` while it grows, which is what the caller escalates on.
 */
export class AgentDiskWatch {
  private readonly warned = new Set<string>();
  /** Agents stopped for a quota, and what they held when they were last accounted for. */
  private readonly stopped = new Map<string, number>();
  /** Ids still owed a measurement in the pass now open: the rotation's position. */
  private pending = new Set<string>();
  /** Ticks the open pass has taken so far. */
  private ticks = 0;
  private readonly budgetMs: number;
  private readonly now: () => number;

  constructor(
    private readonly quota: DiskQuota,
    private readonly measure: (t: DiskWatchTarget) => AgentDiskSample = (t) =>
      measureAgentDisk({ stateDir: t.stateDir, logFiles: t.logFiles }),
    opts: { budgetMs?: number; now?: () => number } = {},
  ) {
    this.budgetMs = opts.budgetMs ?? DISK_TICK_BUDGET_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  tick(targets: ReadonlyArray<DiskWatchTarget>): DiskTick {
    const ids = new Set(targets.map((t) => t.id));
    // An agent that left the field is no longer owed a measurement, and must not hold a pass open.
    for (const id of this.pending) if (!ids.has(id)) this.pending.delete(id);
    if (ids.size === 0) {
      this.pending.clear();
      this.ticks = 0;
      return { outcomes: [], rotation: 0, elapsedMs: 0 };
    }
    if (this.pending.size === 0) {
      for (const id of ids) this.pending.add(id);
      this.ticks = 0;
    }
    this.ticks++;
    const started = this.now();
    const outcomes: DiskWatchOutcome[] = [];
    for (const target of targets) {
      if (!this.pending.has(target.id)) continue;
      // After the first, so a budget smaller than one walk still makes progress.
      if (outcomes.length > 0 && this.now() - started >= this.budgetMs) break;
      this.pending.delete(target.id);
      outcomes.push(this.judge(target));
    }
    const elapsedMs = this.now() - started;
    return {
      outcomes,
      rotation: ids.size,
      elapsedMs,
      ...(this.pending.size === 0 ? { sweep: { ticks: this.ticks } } : {}),
    };
  }

  private judge(target: DiskWatchTarget): DiskWatchOutcome {
    const sample = this.measure(target);
    const verdict = diskVerdict(sample, this.quota);
    const stoppedAt = this.stopped.get(target.id);
    if (stoppedAt !== undefined) {
      // Already stopped. The question is no longer whether it is over a quota -- it is -- but
      // whether the stop reached what was writing.
      const grewBytes = totalBytes(sample) - stoppedAt;
      if (grewBytes <= STOPPED_GROWTH_SLACK_BYTES)
        return { id: target.id, sample, verdict, report: "none" };
      // Re-based, so the next report is about growth since this one rather than since the stop.
      this.stopped.set(target.id, totalBytes(sample));
      return { id: target.id, sample, verdict, report: "still-writing", grewBytes };
    }
    if (verdict.level === "exceeded") {
      this.stopped.set(target.id, totalBytes(sample));
      return { id: target.id, sample, verdict, report: "exceeded" };
    }
    if (verdict.level === "warning") {
      if (this.warned.has(target.id))
        return { id: target.id, sample, verdict, report: "none" };
      this.warned.add(target.id);
      return { id: target.id, sample, verdict, report: "warning" };
    }
    this.warned.delete(target.id);
    return { id: target.id, sample, verdict, report: "none" };
  }
}
