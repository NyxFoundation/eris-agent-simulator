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
  /** `warning` is reported the first time an agent crosses the fraction, not on every tick. */
  report: "none" | "warning" | "exceeded";
};

/**
 * The per-tick driver: measures every target, remembers who has been warned so a warning is one
 * event per crossing rather than one per tick, and hands back what the caller should record and
 * whom it should stop. Stopping is the caller's (it owns the processes).
 */
export class AgentDiskWatch {
  private readonly warned = new Set<string>();
  private readonly stopped = new Set<string>();

  constructor(
    private readonly quota: DiskQuota,
    private readonly measure: (t: DiskWatchTarget) => AgentDiskSample = (t) =>
      measureAgentDisk({ stateDir: t.stateDir, logFiles: t.logFiles }),
  ) {}

  tick(targets: ReadonlyArray<DiskWatchTarget>): DiskWatchOutcome[] {
    const out: DiskWatchOutcome[] = [];
    for (const target of targets) {
      if (this.stopped.has(target.id)) continue;
      const sample = this.measure(target);
      const verdict = diskVerdict(sample, this.quota);
      let report: DiskWatchOutcome["report"] = "none";
      if (verdict.level === "exceeded") {
        this.stopped.add(target.id);
        report = "exceeded";
      } else if (verdict.level === "warning") {
        if (!this.warned.has(target.id)) {
          this.warned.add(target.id);
          report = "warning";
        }
      } else {
        this.warned.delete(target.id);
      }
      out.push({ id: target.id, sample, verdict, report });
    }
    return out;
  }
}
