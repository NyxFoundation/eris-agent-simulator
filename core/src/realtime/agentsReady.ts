// The epoch clock waits for the field (issue #94, decided 2026-09-07 from #91 F5).
//
// The coordinator spawns the agent processes and used to switch to interval mining without
// waiting for any of them. Measured 2026-09-07 with 32 docker agents on a saturated Docker Desktop
// VM: `interval_mining_started` at +24 s, the agents' `runtime_start` at +86..99 s. The first ~45
// blocks of a 360-block epoch went by with nobody watching, V_0 was marked at a boundary no agent
// had observed, and a stress window planned at windowFrac 0.10 (block 36) opened before the field
// existed -- so a hand check of that regime records "no agent reacted" for the environment's own
// doing. Every agent misses the same blocks, so T is untouched; what is lost is the record. And a
// participant whose container boots slower than the rest loses blocks that nothing writes down.
//
// So the run waits: every agent the coordinator started has to have written `runtime_start` to its
// own log -- the line runtime/bot.ts writes once the preflight passed, the venue approvals are in
// place and the block watcher is armed, i.e. everything that precedes its first observation --
// before mining starts. Bounded, so a participant that never comes up cannot hold the epoch
// hostage; who was ready when, who was still booting at the bound, and who had already exited are
// on the record as `agents_ready`.
//
// Pure with respect to the chain: it reads files and a clock, both supplied by the coordinator.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const RUNTIME_START_EVENT = "runtime_start";

export type ReadyProbe = {
  id: string;
  /** False once the process is known to be gone: nothing more will be written, so nothing to wait for. */
  isAlive: () => boolean;
};

export type AgentsReadyReport = {
  /** How long the wait held the clock. */
  waitedMs: number;
  timeoutMs: number;
  /** Every agent that wrote `runtime_start`, with how long after the spawn it took. */
  ready: Array<{ id: string; afterMs: number }>;
  /** Alive at the bound but still without `runtime_start`: the epoch starts without them watching. */
  late: string[];
  /** Exited before writing `runtime_start` (preflight refusal, spawn error): not waited for. */
  exited: string[];
  /** True when the bound was reached with at least one agent still booting. */
  timedOut: boolean;
};

// Path the runtime writes to: runs/<id>/agents/<agentId>.jsonl (example/agents/runtime/agentLog.ts).
export function agentLogPath(runDir: string, agentId: string): string {
  return join(runDir, "agents", `${agentId}.jsonl`);
}

// Whether the agent's log holds a `runtime_start` line. The file is a handful of lines at this
// point, and the substring check keeps the common negative (no file yet, or preflight lines only)
// from parsing anything. A line that merely mentions the word -- an error message quoting it --
// is parsed and rejected rather than counted.
export function agentLogHasRuntimeStart(file: string): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  if (!text.includes(RUNTIME_START_EVENT)) return false;
  for (const line of text.split("\n")) {
    if (!line.includes(RUNTIME_START_EVENT)) continue;
    try {
      const parsed = JSON.parse(line) as { event?: unknown };
      if (parsed.event === RUNTIME_START_EVENT) return true;
    } catch {
      // a partial last line while the agent is mid-write; the next poll reads it whole
    }
  }
  return false;
}

export async function waitForAgentsReady(opts: {
  agents: ReadyProbe[];
  runDir: string;
  /** When the processes were spawned; `ready[].afterMs` is measured from here. */
  spawnedAt: number;
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AgentsReadyReport> {
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 250;
  const startedAt = now();
  const deadline = startedAt + opts.timeoutMs;
  const ready = new Map<string, number>();
  const exited = new Set<string>();
  const pending = new Set(opts.agents.map((a) => a.id));
  const byId = new Map(opts.agents.map((a) => [a.id, a]));

  const poll = (): void => {
    for (const id of [...pending]) {
      const agent = byId.get(id);
      if (!agent) continue;
      if (agentLogHasRuntimeStart(agentLogPath(opts.runDir, id))) {
        ready.set(id, now() - opts.spawnedAt);
        pending.delete(id);
      } else if (!agent.isAlive()) {
        // Checked after the log, not before: a process that wrote its line and then died is
        // still one that was up when the clock started.
        exited.add(id);
        pending.delete(id);
      }
    }
  };

  poll();
  while (pending.size > 0 && now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    poll();
  }
  return {
    waitedMs: now() - startedAt,
    timeoutMs: opts.timeoutMs,
    ready: [...ready].map(([id, afterMs]) => ({ id, afterMs })),
    late: [...pending],
    exited: [...exited],
    timedOut: pending.size > 0,
  };
}
