/**
 * dockerCli.ts: talking to the docker CLI from inside the block loop, bounded (issue #223).
 *
 * The coordinator shells out to docker synchronously on the environment's own thread: once per agent
 * at the agents-ready wait to read which networks its container joined (agentNetwork.ts), again every
 * `run.agentDiskCheckEveryBlocks` blocks for any container that was still booting, and -- now -- to
 * remove the container of an agent it has stopped. Every one of those calls sat on a `spawnSync` with
 * no timeout, which is an unbounded wait on a daemon this process does not control: a docker daemon
 * that will not answer stops the oracle write, the GMX keeper and the flow for as long as it sulks.
 * So every call gets a deadline, and a call that does not come back in time is *unmeasured* rather
 * than an answer -- the same rule agentNetwork.ts already applies to a non-zero exit.
 *
 * The second half is the retry: a container that cannot be inspected stays in `networkPending`, so a
 * permanently absent one was asked about again every 15 blocks for the whole run, each time writing
 * an event that says the same thing. `ProbeBudget` spends a fixed number of attempts and then says
 * so once, which is the honest record -- "docker never told us" is a fact about the run, not an
 * absence of one.
 *
 * `removeAgentContainer` is the stop that actually reaches a container. `AgentProcess.close()` kills
 * the process the coordinator spawned, and under the docker sandbox that is the `docker run`
 * *client*: the container is the daemon's child and outlives it (run-agent.sh says the same of the
 * run-end kill, which is why it ships reap.sh). An agent stopped for writing over its quota would
 * therefore keep writing.
 */
import { spawnSync } from "node:child_process";
import { agentContainerName, type DockerRunner } from "./agentNetwork.js";

/**
 * How long one `docker` call may take. Generous for a healthy daemon (an inspect answers in tens of
 * milliseconds) and short enough that a sick one costs the block loop one block, not the run.
 */
export const DOCKER_CALL_TIMEOUT_MS = 5_000;

/** Attempts spent on a container docker will not describe before the coordinator stops asking. */
export const PROBE_ATTEMPTS = 3;

/** How many times a removal is retried within one escalation before it is reported as failed. */
export const REMOVE_TRIES = 2;

function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}

/**
 * A `DockerRunner` that cannot block longer than `timeoutMs`. SIGKILL, not SIGTERM: the point is a
 * CLI that is already stuck waiting on the daemon, and the polite signal is what it is ignoring.
 */
export function createDockerRunner(
  timeoutMs = DOCKER_CALL_TIMEOUT_MS,
): DockerRunner {
  return (args: string[]) => {
    const r = spawnSync("docker", args, {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ETIMEDOUT")
      return {
        // Not 0, so every caller reads this as "could not be measured" rather than as an answer.
        status: null,
        stdout: "",
        stderr: `docker ${args.join(" ")} did not answer within ${timeoutMs} ms`,
      };
    return {
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? (r.error !== undefined ? r.error.message : ""),
    };
  };
}

/**
 * Attempts spent per id. Bounded on purpose: a container that will never be described again (the
 * agent exited, the daemon restarted, the name was taken by something else) otherwise costs two
 * docker calls and one event every interval for the rest of the run.
 */
export class ProbeBudget {
  private readonly tries = new Map<string, number>();

  constructor(private readonly max = PROBE_ATTEMPTS) {}

  /** Record one attempt that could not measure `id`. True when this id's attempts are spent. */
  failed(id: string): boolean {
    const n = (this.tries.get(id) ?? 0) + 1;
    this.tries.set(id, n);
    return n >= this.max;
  }

  /** Attempts recorded for `id`. */
  count(id: string): number {
    return this.tries.get(id) ?? 0;
  }

  /** Forget `id`, so a container that answers after a bad patch starts with a full budget. */
  forget(id: string): void {
    this.tries.delete(id);
  }
}

export type ContainerRemoval = {
  agentId: string;
  container: string;
  /** True only when docker answered and said the container is not running. */
  gone: boolean;
  attempts: number;
  detail: string;
};

/**
 * Remove an agent's container, then read back whether it is gone.
 *
 * The read-back is the point, and it mirrors run-agent.sh's `gone()`: a daemon that will not answer
 * is not evidence of absence, and recording it as one is how the container this function exists to
 * remove ends up surviving the run holding its key and its RPC connection. `docker rm -f` on a
 * container that was never there also exits non-zero, which is why the verdict comes from `docker ps`
 * and not from the removal's exit code.
 */
export function removeAgentContainer(
  agentId: string,
  docker: DockerRunner,
  tries = REMOVE_TRIES,
): ContainerRemoval {
  const container = agentContainerName(agentId);
  let detail = "";
  let attempts = 0;
  for (let i = 1; i <= Math.max(1, tries); i++) {
    attempts = i;
    const rm = docker(["rm", "-f", container]);
    const ps = docker(["ps", "-q", "--filter", `name=^${container}$`]);
    if (ps.status === 0 && ps.stdout.trim() === "")
      return {
        agentId,
        container,
        gone: true,
        attempts,
        detail:
          rm.status === 0
            ? `removed container ${container}`
            : `container ${container} is not running (docker rm -f: ${firstLine(rm.stderr) || `exit ${rm.status}`})`,
      };
    detail =
      ps.status === 0
        ? `container ${container} is still running after docker rm -f (${firstLine(rm.stderr) || `rm exit ${rm.status}`})`
        : `docker ps would not answer (${firstLine(ps.stderr) || `exit ${ps.status}`}), so ${container} cannot be confirmed gone`;
  }
  return { agentId, container, gone: false, attempts, detail };
}
