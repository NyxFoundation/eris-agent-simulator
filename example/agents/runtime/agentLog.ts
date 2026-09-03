/**
 * agentLog: shared helper for an agent to record its own action log (ADR 0015 runtime).
 *
 * The output location is derived from the environment variables the coordinator passes,
 * and each round's decision is appended one line at a time to
 * runs/<runId>/agents/<agentId>.jsonl. Post-run diagnostics and strategy improvement read
 * this log as their primary source (decision reason / signals / internal state).
 *
 * Usage: bot.ts passes it to the agent as ctx.log. To use it directly:
 *   import { createAgentLog } from "../runtime/agentLog.js";
 *   const log = createAgentLog();
 *   log({ round, action, reason, signals, state });
 *
 * Environment variables:
 *   ERIS_RUN_DIR   output run directory (passed by the coordinator)
 *   ERIS_AGENT_ID  agent identifier
 *
 * Note: when not running under the coordinator (ERIS_RUN_DIR unset) the log is a no-op.
 *       A log write failure never stops strategy execution (it is swallowed).
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeStringify } from "@eris/sdk/logger.js";
import type { AgentLogEntry } from "@eris/sdk/agent.js";

export type { AgentLogEntry };

export type AgentLog = (entry: AgentLogEntry) => void;

// Low-level append to runs/<runDir>/agents/<agentId><suffix>.jsonl.
// Shared implementation so the action log (createAgentLog) and mempool self-reports (send.ts)
// write to the same file (no suffix), while the LLM conversation log (bot.ts's
// ERIS_IMPROVE_LOG_CALLS) writes to a separate file (suffix ".llm").
export function createJsonlAppender(
  runDir: string | undefined,
  agentId: string,
  suffix = "",
): (record: Record<string, unknown>) => void {
  if (!runDir) return () => {}; // do nothing when not running under the coordinator
  // A segmented period rolls the run directory while this process keeps going (ADR 0021 sec 6), so
  // the directory is resolved per write rather than captured. The coordinator points at the segment
  // that is current; without this every line after the first roll lands in segment 0, and every
  // later segment shows a local agent with no lines -- which reads as "it never logged a decision".
  const pointer = process.env.ERIS_RUN_DIR_POINTER;
  let currentDir = runDir;
  let pointerMtimeMs = -1;
  const resolveDir = (): string => {
    if (!pointer) return runDir;
    try {
      const mtimeMs = statSync(pointer).mtimeMs;
      if (mtimeMs !== pointerMtimeMs) {
        pointerMtimeMs = mtimeMs;
        const next = readFileSync(pointer, "utf8").trim();
        if (next) currentDir = next;
      }
    } catch {
      // the pointer is an optimisation, not a requirement: keep writing where we were
    }
    return currentDir;
  };
  const ready = new Set<string>();
  return (record) => {
    try {
      const dir = join(resolveDir(), "agents");
      if (!ready.has(dir)) {
        mkdirSync(dir, { recursive: true });
        ready.add(dir);
      }
      const line = safeStringify({
        ts: new Date().toISOString(),
        agentId,
        ...record,
      });
      appendFileSync(join(dir, `${agentId}${suffix}.jsonl`), `${line}\n`);
    } catch {
      // a log failure must not affect strategy execution
    }
  };
}

export function createAgentLog(): AgentLog {
  const append = createJsonlAppender(
    process.env.ERIS_RUN_DIR,
    process.env.ERIS_AGENT_ID ?? "unknown",
  );
  return (entry: AgentLogEntry): void => append({ ...entry });
}
