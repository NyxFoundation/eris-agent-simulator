/**
 * agentNetwork.ts: the network a docker agent is actually on, measured (issue #214 item 4).
 *
 * `agentNetworkPosture` (agentView.ts) reads the switches the wrapper will be given and says what
 * run-agent.sh *will* do with them. That is a declaration. Two things made it untrue in practice:
 * `docker network create --internal ... || true` reused an `ag-<id>` left by an earlier run that was
 * created without `--internal`, and nothing afterwards looked. The wrapper now recreates a network
 * whose `Internal` flag is not the one asked for and exits on a create failure; this file is the
 * other half -- after the agents are up, the coordinator asks docker which networks each container
 * joined and whether each is internal, records it, and treats a container that is not where its
 * posture says as a container to stop.
 *
 * Pure with respect to docker: the caller supplies the runner, so the reading of the inspect output
 * and the comparison are testable without a daemon.
 */
import type { AgentNetworkPosture } from "./agentView.js";

/** Run `docker <args>` and return its exit status and output. */
export type DockerRunner = (args: string[]) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type ContainerNetworkFact = {
  id: string;
  container: string;
  /** False when the container could not be inspected (not started yet, already gone, daemon away). */
  measured: boolean;
  /** Every network the container is attached to; `internal` is null when the network could not be inspected. */
  networks: Array<{ name: string; internal: boolean | null }>;
  error?: string;
};

export type NetworkMismatch = {
  id: string;
  kind: "shared-network" | "route-out" | "extra-network";
  detail: string;
};

/** The container name run-agent.sh gives an agent (`NAME="eris-${ERIS_AGENT_ID}"`). */
export function agentContainerName(agentId: string): string {
  return `eris-${agentId}`;
}

/** The per-agent isolation network run-agent.sh creates under ERIS_AGENT_ISOLATE=1. */
export function agentIsolationNetwork(agentId: string): string {
  return `ag-${agentId}`;
}

/** The network names in `docker inspect -f '{{json .NetworkSettings.Networks}}'` output. */
export function parseContainerNetworks(json: string): string[] {
  const parsed = JSON.parse(json) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return [];
  return Object.keys(parsed as Record<string, unknown>);
}

/** `docker network inspect -f '{{.Internal}}'` prints `true` / `false`. */
export function parseInternalFlag(stdout: string): boolean | null {
  const t = stdout.trim();
  return t === "true" ? true : t === "false" ? false : null;
}

/** Ask docker, once per agent, which networks its container is on and whether each is internal. */
export function measureAgentNetworks(
  agentIds: readonly string[],
  docker: DockerRunner,
): ContainerNetworkFact[] {
  const internalByName = new Map<string, boolean | null>();
  const internalOf = (name: string): boolean | null => {
    const cached = internalByName.get(name);
    if (cached !== undefined) return cached;
    const r = docker(["network", "inspect", "-f", "{{.Internal}}", name]);
    const flag = r.status === 0 ? parseInternalFlag(r.stdout) : null;
    internalByName.set(name, flag);
    return flag;
  };
  return agentIds.map((id) => {
    const container = agentContainerName(id);
    const r = docker([
      "inspect",
      "-f",
      "{{json .NetworkSettings.Networks}}",
      container,
    ]);
    if (r.status !== 0)
      return {
        id,
        container,
        measured: false,
        networks: [],
        error: r.stderr.trim().split("\n")[0] || `docker inspect exited ${r.status}`,
      };
    let names: string[];
    try {
      names = parseContainerNetworks(r.stdout);
    } catch (error) {
      return {
        id,
        container,
        measured: false,
        networks: [],
        error: `unreadable inspect output: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      id,
      container,
      measured: true,
      networks: names.map((name) => ({ name, internal: internalOf(name) })),
    };
  });
}

/**
 * Where a measured container disagrees with the posture it was launched under. Only measured
 * containers are judged: one that could not be inspected is reported by the caller as unmeasured,
 * not as wrong. Only an isolated posture has anything to be wrong about -- on a shared network the
 * banner already says so.
 */
export function networkMismatches(
  facts: readonly ContainerNetworkFact[],
  postureOf: (id: string) => AgentNetworkPosture,
): NetworkMismatch[] {
  const out: NetworkMismatch[] = [];
  for (const fact of facts) {
    if (!fact.measured) continue;
    const posture = postureOf(fact.id);
    if (!posture.isolated) continue;
    const own = agentIsolationNetwork(fact.id);
    const names = fact.networks.map((n) => n.name);
    if (!names.includes(own)) {
      out.push({
        id: fact.id,
        kind: "shared-network",
        detail:
          `launched with ERIS_AGENT_ISOLATE=1 but the container is on ${names.length > 0 ? names.join(", ") : "no network"}, not ${own}`,
      });
      continue;
    }
    const extra = names.filter((n) => n !== own);
    if (extra.length > 0)
      out.push({
        id: fact.id,
        kind: "extra-network",
        detail: `attached to ${extra.join(", ")} besides ${own}`,
      });
    if (posture.egress === "closed") {
      const internal = fact.networks.find((n) => n.name === own)?.internal;
      if (internal !== true)
        out.push({
          id: fact.id,
          kind: "route-out",
          detail:
            internal === null || internal === undefined
              ? `launched with ERIS_AGENT_INTERNAL=1 but ${own} could not be inspected`
              : `launched with ERIS_AGENT_INTERNAL=1 but ${own} is not --internal (it has a route out)`,
        });
    }
  }
  return out;
}
