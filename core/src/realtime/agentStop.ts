/**
 * agentStop.ts: stopping an agent so that it is stopped (issue #223).
 *
 * The coordinator stops an agent on its own judgment in two places: past its disk quota
 * (agentDisk.ts) and when its container is not on the network its launch declared
 * (agentNetwork.ts). Both did it with `AgentProcess.close()`, which stops the process the
 * coordinator spawned -- and under the docker sandbox that process is `bash run-agent.sh`
 * supervising a `docker run` **client**. The container is the daemon's child. A submitted runtime
 * that installs `process.on("SIGTERM", () => {})` keeps running in it after the client is gone, with
 * its key, its RPC connection, and its hand on the disk the quota exists to protect; run-agent.sh
 * documents the same hole for the run-end kill, which is why it ships reap.sh.
 *
 * So a stop here is: the reason into summary.json, the process closed, and then -- after the grace
 * close() already gives, so a runtime that does stop gets to flush its log -- `docker rm -f` on the
 * container, with the removal read back rather than assumed. The attempts are bounded and the giving
 * up is recorded: a container that outlives the run is the operator's problem, and it being in the
 * record is the difference between a problem and a surprise.
 *
 * Separated from the coordinator so the escalation is testable without a run: the docker runner, the
 * clock and the event sink are all the caller's.
 */
import type { DockerRunner } from "./agentNetwork.js";
import { PROBE_ATTEMPTS, removeAgentContainer } from "./dockerCli.js";

/**
 * How long after the process stop the container is removed. `AgentProcess.close()` gives the process
 * two seconds before SIGKILL; this is that plus room for the signal to land and a log line to flush.
 */
export const CONTAINER_GRACE_MS = 3_000;

/** What this module needs of an agent: enough to stop it and to say why it stopped. */
export type StoppableAgent = {
  id: string;
  exitedEarly?: string;
  process: { close: () => void } | null;
};

export type AgentStopper = {
  /**
   * Stop `agent`: `reason` is what summary.json reports, `why` is what the container-removal events
   * record. Returns nothing -- the removal happens after the grace, through `schedule`.
   */
  stop: (agent: StoppableAgent, reason: string, why: string) => void;
  /** Remove the container now, for an agent already stopped that turns out to still be running. */
  escalate: (agentId: string, why: string) => void;
};

export function createAgentStopper(opts: {
  /** `run.agentSandbox`. Under `process` there is no second process and close() is the whole stop. */
  sandbox: string;
  docker: DockerRunner;
  event: (event: Record<string, unknown>) => void;
  log?: (line: string) => void;
  graceMs?: number;
  /** Injected for tests; `setTimeout` referenced on purpose in the coordinator (see below). */
  schedule?: (fn: () => void, ms: number) => void;
  maxAttempts?: number;
}): AgentStopper {
  const graceMs = opts.graceMs ?? CONTAINER_GRACE_MS;
  const maxAttempts = opts.maxAttempts ?? PROBE_ATTEMPTS;
  const log = opts.log ?? ((line: string) => console.error(line));
  // Referenced on purpose, like close()'s own escalation: an unref'd timer may never fire -- the
  // coordinator can finish scoring and exit inside the grace window -- and a removal that only
  // sometimes happens is not a removal.
  const schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  const attemptsById = new Map<string, number>();

  const escalate = (agentId: string, why: string): void => {
    if (opts.sandbox !== "docker") return;
    const attempt = (attemptsById.get(agentId) ?? 0) + 1;
    attemptsById.set(agentId, attempt);
    if (attempt > maxAttempts) {
      // Once, not on every tick that finds it still writing.
      if (attempt === maxAttempts + 1)
        opts.event({
          type: "agent_container_remove_abandoned",
          agentId,
          attempts: maxAttempts,
          note:
            "the container could not be confirmed gone after repeated removals and the coordinator " +
            "stops trying. Recorded because a container that outlives the run still holds its key " +
            "and its RPC connection -- run infra/docker-agent/reap.sh",
        });
      return;
    }
    const removal = removeAgentContainer(agentId, opts.docker);
    opts.event({
      type: removal.gone
        ? "agent_container_removed"
        : "agent_container_remove_failed",
      agentId,
      container: removal.container,
      why,
      attempt,
      detail: removal.detail,
    });
    if (!removal.gone) log(`[agent] ${agentId}: ${removal.detail}`);
  };

  return {
    escalate,
    stop: (agent, reason, why) => {
      // close() marks the process as stopped on purpose, so onExit will not fire: the reason is
      // recorded here, where summary.json's processExitedEarly reads it.
      agent.exitedEarly = reason;
      agent.process?.close();
      schedule(() => escalate(agent.id, why), graceMs);
    },
  };
}
