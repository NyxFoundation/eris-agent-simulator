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
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { safeStringify } from "@eris/sdk/logger.js";
import type { AgentLogEntry } from "@eris/sdk/agent.js";

export type { AgentLogEntry };

export type AgentLog = (entry: AgentLogEntry) => void;

// Low-level append to runs/<runDir>/agents/<agentId><suffix>.jsonl.
// Shared implementation so the action log (createAgentLog) and mempool self-reports (send.ts)
// write to the same file (no suffix), while the LLM conversation log (bot.ts's
// ERIS_PROMPT_LOG_CALLS) writes to a separate file (suffix ".llm").
export function createJsonlAppender(
  runDir: string | undefined,
  agentId: string,
  suffix = "",
): (record: Record<string, unknown>) => void {
  if (!runDir) return () => {}; // do nothing when not running under the coordinator
  const dir = join(runDir, "agents");
  const path = join(dir, `${agentId}${suffix}.jsonl`);
  let ready = false;
  return (record) => {
    try {
      if (!ready) {
        mkdirSync(dir, { recursive: true });
        ready = true;
      }
      const line = safeStringify({
        ts: new Date().toISOString(),
        agentId,
        ...record,
      });
      appendFileSync(path, `${line}\n`);
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
