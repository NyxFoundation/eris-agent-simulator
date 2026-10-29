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
 * Two more things are read for an `--internal` posture, because `--internal` alone does not keep the
 * host out (measured 2026-10-29, Docker Engine 29.8.1): the network still puts the host's address on
 * its bridge -- a service on 0.0.0.0 answered a plain connect to it -- and a container that keeps
 * CAP_NET_RAW builds its own packets to addresses it has no route to: a TCP handshake to a service on
 * docker0's address, where the live week's anvil listens with anvil_* / evm_* open, completed from an
 * internal network. run-agent.sh creates the network in docker's `isolated` gateway mode (no host
 * address) and drops NET_RAW; this is where the coordinator checks that both held.
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

/** One network as `docker network inspect` describes it; every field null when it could not be inspected. */
export type NetworkFact = {
  name: string;
  internal: boolean | null;
  /** `com.docker.network.bridge.gateway_mode_ipv4`: "" for docker's default, "isolated" for no host address. */
  gatewayMode: string | null;
  /** The host's address on the network's bridge (the IPAM gateway), or null when it has none. */
  hostAddress: string | null;
};

export type ContainerNetworkFact = {
  id: string;
  container: string;
  /** False when the container could not be inspected (not started yet, already gone, daemon away). */
  measured: boolean;
  /** Every network the container is attached to. */
  networks: NetworkFact[];
  /** Whether the container can open raw / packet sockets: it kept CAP_NET_RAW or runs privileged. */
  rawSockets?: boolean;
  error?: string;
};

export type NetworkMismatch = {
  id: string;
  kind:
    | "shared-network"
    | "route-out"
    | "extra-network"
    | "host-reachable"
    | "raw-socket";
  detail: string;
};

// One `docker inspect` per container answers both questions: where it is and what it may do there.
const CONTAINER_FORMAT =
  '{"networks":{{json .NetworkSettings.Networks}},"capAdd":{{json .HostConfig.CapAdd}},' +
  '"capDrop":{{json .HostConfig.CapDrop}},"privileged":{{json .HostConfig.Privileged}}}';
// And one `docker network inspect` per network.
const NETWORK_FORMAT =
  '{{.Internal}}|{{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}|{{json .IPAM.Config}}';

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

/** Whether a container keeps CAP_NET_RAW, read from the capabilities `docker inspect` reports. */
export function keepsNetRaw(host: {
  capAdd?: readonly string[] | null;
  capDrop?: readonly string[] | null;
  privileged?: boolean | null;
}): boolean {
  // Docker reports `CAP_NET_RAW` for `--cap-drop NET_RAW`; either spelling and ALL are read alike.
  const names = (list?: readonly string[] | null) =>
    new Set((list ?? []).map((c) => c.toUpperCase().replace(/^CAP_/, "")));
  if (host.privileged === true) return true;
  const added = names(host.capAdd);
  if (added.has("ALL") || added.has("NET_RAW")) return true;
  const dropped = names(host.capDrop);
  // NET_RAW is in docker's default set, so a container keeps it unless it was dropped.
  return !(dropped.has("ALL") || dropped.has("NET_RAW"));
}

/** The container inspect output (CONTAINER_FORMAT): its networks and whether it keeps CAP_NET_RAW. */
export function parseContainerInspect(json: string): {
  networks: string[];
  rawSockets: boolean;
} {
  const parsed = JSON.parse(json) as {
    networks?: unknown;
    capAdd?: string[] | null;
    capDrop?: string[] | null;
    privileged?: boolean | null;
  };
  return {
    networks: parseContainerNetworks(JSON.stringify(parsed.networks ?? null)),
    rawSockets: keepsNetRaw(parsed),
  };
}

/**
 * The network inspect output (NETWORK_FORMAT). Output that does not read whole is a network that
 * could not be inspected (every field null), never one with no host address.
 */
export function parseNetworkInspect(
  name: string,
  stdout: string,
): NetworkFact {
  const unread: NetworkFact = {
    name,
    internal: null,
    gatewayMode: null,
    hostAddress: null,
  };
  const parts = stdout.trim().split("|");
  if (parts.length !== 3) return unread;
  const [internal, gatewayMode, ipam] = parts;
  let config: Array<{ Gateway?: string }> | null;
  try {
    config = JSON.parse(ipam) as Array<{ Gateway?: string }> | null;
  } catch {
    return unread;
  }
  return {
    name,
    internal: parseInternalFlag(internal),
    gatewayMode,
    hostAddress: config?.find((c) => c.Gateway)?.Gateway ?? null,
  };
}

/**
 * Whether the host holds an address on this network, i.e. whether a container on it can reach the
 * host's services. Only docker's `isolated` gateway mode with no IPAM gateway says no.
 */
export function hostReachable(net: NetworkFact): boolean {
  return net.gatewayMode !== "isolated" || net.hostAddress !== null;
}

/** Ask docker, once per agent, which networks its container is on and whether each is internal. */
export function measureAgentNetworks(
  agentIds: readonly string[],
  docker: DockerRunner,
): ContainerNetworkFact[] {
  const factByName = new Map<string, NetworkFact>();
  const networkOf = (name: string): NetworkFact => {
    const cached = factByName.get(name);
    if (cached !== undefined) return cached;
    const r = docker(["network", "inspect", "-f", NETWORK_FORMAT, name]);
    const fact =
      r.status === 0
        ? parseNetworkInspect(name, r.stdout)
        : { name, internal: null, gatewayMode: null, hostAddress: null };
    factByName.set(name, fact);
    return fact;
  };
  return agentIds.map((id) => {
    const container = agentContainerName(id);
    const r = docker(["inspect", "-f", CONTAINER_FORMAT, container]);
    if (r.status !== 0)
      return {
        id,
        container,
        measured: false,
        networks: [],
        error: r.stderr.trim().split("\n")[0] || `docker inspect exited ${r.status}`,
      };
    let inspected: { networks: string[]; rawSockets: boolean };
    try {
      inspected = parseContainerInspect(r.stdout);
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
      networks: inspected.networks.map(networkOf),
      rawSockets: inspected.rawSockets,
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
      const net = fact.networks.find((n) => n.name === own);
      const internal = net?.internal;
      if (internal !== true)
        out.push({
          id: fact.id,
          kind: "route-out",
          detail:
            internal === null || internal === undefined
              ? `launched with ERIS_AGENT_INTERNAL=1 but ${own} could not be inspected`
              : `launched with ERIS_AGENT_INTERNAL=1 but ${own} is not --internal (it has a route out)`,
        });
      else if (net && hostReachable(net))
        out.push({
          id: fact.id,
          kind: "host-reachable",
          detail:
            `launched with ERIS_AGENT_INTERNAL=1 but ${own} gives the host an address ` +
            `(${net.hostAddress ?? `gateway mode ${net.gatewayMode || "default"}`}): the host's services ` +
            "are reachable from the container, anvil on docker0 included",
        });
      // With egress open the host is reachable by plain routing anyway, so raw sockets add nothing
      // there; with it closed they are what reaches past the routing.
      if (fact.rawSockets !== false)
        out.push({
          id: fact.id,
          kind: "raw-socket",
          detail:
            "launched with ERIS_AGENT_INTERNAL=1 but the container keeps CAP_NET_RAW: it can build " +
            "its own packets to addresses it has no route to (a TCP handshake to anvil on docker0 " +
            "completes that way)",
        });
    }
  }
  return out;
}
