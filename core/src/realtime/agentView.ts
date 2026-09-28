/**
 * agentView.ts: what the environment hands an agent it launches, and nothing else.
 *
 * An agent used to be given the coordinator's own config file (`ERIS_CONFIG`), and a containerised
 * agent had the whole run directory mounted into it. Both carried more than an agent needs: the
 * config file held the run seed (and a backtest named the file after its regime and seed), and the
 * run directory held the coordinator's records and every other agent's logs.
 *
 * The contract is now a per-agent directory the coordinator prepares under the run directory:
 *
 *   runs/<runId>/agent-view/<agentId>/
 *     config.yaml      the agent's config: the fields the runtime reads, resolved by the coordinator
 *     run-start.json   the run's first block (sdk/src/runStart.ts), written once counting starts
 *
 * Every launched agent gets `ERIS_CONFIG=<view>/config.yaml` and `ERIS_AGENT_VIEW_DIR=<view>`. A
 * docker agent in image mode mounts the view directory read-only as its run directory, plus its own
 * log files (infra/docker-agent/run-agent.sh). Its logs stay at runs/<runId>/agents/<agentId>.jsonl,
 * where the dashboard and the post-run checks read them.
 *
 * The config is built from an allowlist rather than by deleting known secrets from the full file:
 * a field added to the regime YAML later reaches an agent only when someone decides it should.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { SimConfig } from "@eris/sdk/config.js";

/** Directory under the run directory holding one subdirectory per launched agent. */
export const AGENT_VIEW_DIR = "agent-view";
/** The agent's config file inside its view directory. */
export const AGENT_CONFIG_FILE = "config.yaml";
/** Env var naming the agent's view directory (a host path; run-agent.sh mounts it). */
export const AGENT_VIEW_DIR_ENV = "ERIS_AGENT_VIEW_DIR";

/**
 * The SimConfig fields an agent's config carries. Everything else loads as its default in the agent
 * process. `test/agentView.test.ts` checks that every SimConfig field is either here or explicitly
 * environment-only, so a new field has to be placed on one side.
 */
export const AGENT_CONFIG_FIELDS = [
  "runBlocks",
  "runSeconds",
  "blockTimeSec",
  "enabledProtocols",
  "economicGas",
  "localDeploy",
  "chainMode",
  "chainId",
  "intervalBlocks",
  "defaultPriorityFeeWei",
  "maxPriorityFeeWei",
  "lstSimulatedSecondsPerBlock",
  "agentMarkets",
  "maxTxGas",
  "maxAgentBlockGas",
] as const satisfies ReadonlyArray<keyof SimConfig>;

type AgentConfigDoc = {
  run: Record<string, unknown>;
  fees: Record<string, string>;
  lst: Record<string, number>;
  agentMarkets: Record<string, unknown>;
};

/**
 * The agent's config as a YAML document in the nested schema (sdk/src/runConfig.ts). Built from the
 * coordinator's resolved config, so a CLI override (`--blocks`, `--protocols`) and a date-stated run
 * end (`run.endsAt`, already converted to blocks) reach the agent as the value the coordinator runs
 * with. Carries no seed of any kind, no stress, vuln, market, flow or funding section, and no roster.
 */
export function agentConfigDoc(config: SimConfig): AgentConfigDoc {
  return {
    run: {
      blocks: config.runBlocks,
      seconds: config.runSeconds,
      blockTimeSec: config.blockTimeSec,
      protocols: [...config.enabledProtocols],
      economicGas: config.economicGas,
      localDeploy: config.localDeploy,
      chainMode: config.chainMode,
      chainId: config.chainId,
      intervalBlocks: config.intervalBlocks,
    },
    fees: {
      priorityFeeWei: config.defaultPriorityFeeWei.toString(),
      maxPriorityFeeWei: config.maxPriorityFeeWei.toString(),
    },
    lst: { simulatedSecondsPerBlock: config.lstSimulatedSecondsPerBlock },
    agentMarkets: {
      enabled: config.agentMarkets,
      maxTxGas: config.maxTxGas.toString(),
      maxAgentBlockGas: config.maxAgentBlockGas.toString(),
    },
  };
}

/** The file text: a short header, then the document. Identical for every agent in a run. */
export function renderAgentConfig(config: SimConfig): string {
  return (
    "# Written by the coordinator for the agents it launches (core/src/realtime/agentView.ts).\n" +
    "# The fields the agent runtime reads, as this run resolved them. Do not edit by hand.\n" +
    stringifyYaml(agentConfigDoc(config))
  );
}

// An agent id is joined onto a path and, in run-agent.sh, into a `docker -v src:dst` argument.
// Refused rather than rewritten, like the state directory (agentState.ts): a sanitised id could
// point two agents at one directory.
function assertViewSegment(id: string): void {
  if (id === "" || id === "." || id === ".." || /[\\/:,]/.test(id))
    throw new Error(
      `agent id ${JSON.stringify(id)} cannot be used as an agent view directory name`,
    );
}

/** runs/<runId>/agent-view/<agentId>, absolute (the container wrapper mounts it by host path). */
export function agentViewDir(runDir: string, agentId: string): string {
  assertViewSegment(agentId);
  return resolve(runDir, AGENT_VIEW_DIR, agentId);
}

/** Create the agent's view directory and write its config. Returns both paths, absolute. */
export function prepareAgentView(
  runDir: string,
  agentId: string,
  configText: string,
): { dir: string; configPath: string } {
  const dir = agentViewDir(runDir, agentId);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, AGENT_CONFIG_FILE);
  writeFileSync(configPath, configText);
  return { dir, configPath };
}

// ---- the network a docker agent is given (infra/docker-agent/run-agent.sh, ISOLATION.md) ----

/** How run-agent.sh will place one agent's container, read from the env it will see. */
export type AgentNetworkPosture = {
  /** `per-agent` under ERIS_AGENT_ISOLATE=1; otherwise the docker network the container joins. */
  network: string;
  /** Per-agent networks: the agent reaches only the hub(s) its network is joined to. */
  isolated: boolean;
  /** Whether the container has a route out (closed only on an --internal per-agent network). */
  egress: "open" | "closed";
  /** ERIS_AGENT_BINDMOUNT=1: the repository is mounted into the container. */
  bindMount: boolean;
};

export function agentNetworkPosture(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): AgentNetworkPosture {
  const isolated = env.ERIS_AGENT_ISOLATE === "1";
  return {
    // run-agent.sh's own defaults: host networking, except on macOS where Docker Desktop has no
    // host namespace to share and the wrapper falls back to the default bridge.
    network: isolated
      ? "per-agent"
      : env.ERIS_AGENT_NET || (platform === "darwin" ? "bridge" : "host"),
    isolated,
    egress: isolated && env.ERIS_AGENT_INTERNAL === "1" ? "closed" : "open",
    bindMount: env.ERIS_AGENT_BINDMOUNT === "1",
  };
}

/** The settings the live week's agent containers run with (ISOLATION.md). */
export const LIVE_WEEK_AGENT_NETWORK =
  "ERIS_AGENT_ISOLATE=1 ERIS_AGENT_INTERNAL=1 ERIS_AGENT_RPC_URL=<the RPC gateway> " +
  "ERIS_INFERENCE_HUB=<proxy container> ERIS_INFERENCE_BASE_URL=<proxy URL>";

export type AgentSandboxWarning = {
  /** Agents on a shared network (host, bridge, or a named one): they can reach this host's services. */
  sharedNetwork: Array<{ id: string; network: string }>;
  /** Agents on per-agent networks that still have a route out. */
  openEgress: string[];
  /** Agents in bind-mount mode, which mounts the repository. */
  bindMount: string[];
  /** Image-mode agents in a segmented period, whose container mounts the period directory. */
  periodDirectory: string[];
};

/**
 * Which docker agents run without the isolation the live week uses, or null when none do. Read per
 * agent because the switches can be set per roster entry as well as for the whole run.
 */
export function agentSandboxWarning(
  agents: ReadonlyArray<{ id: string; env: Record<string, string | undefined> }>,
  opts: { segmented?: boolean; platform?: NodeJS.Platform } = {},
): AgentSandboxWarning | null {
  const warning: AgentSandboxWarning = {
    sharedNetwork: [],
    openEgress: [],
    bindMount: [],
    periodDirectory: [],
  };
  for (const agent of agents) {
    const posture = agentNetworkPosture(agent.env, opts.platform);
    if (!posture.isolated)
      warning.sharedNetwork.push({ id: agent.id, network: posture.network });
    else if (posture.egress === "open") warning.openEgress.push(agent.id);
    if (posture.bindMount) warning.bindMount.push(agent.id);
    else if (opts.segmented) warning.periodDirectory.push(agent.id);
  }
  return warning.sharedNetwork.length > 0 ||
    warning.openEgress.length > 0 ||
    warning.bindMount.length > 0 ||
    warning.periodDirectory.length > 0
    ? warning
    : null;
}

/** The stderr banner for a warning: said at startup and again when the run completes. */
export function agentSandboxBanner(warning: AgentSandboxWarning): string {
  const ids = (list: string[]) =>
    list.length > 6
      ? `${list.slice(0, 6).join(", ")} and ${list.length - 6} more`
      : list.join(", ");
  const lines = [
    "WARNING: docker agents are running without the live week's isolation.",
  ];
  if (warning.sharedNetwork.length > 0) {
    const networks = [...new Set(warning.sharedNetwork.map((a) => a.network))];
    lines.push(
      `  network ${networks.join(" / ")} (${ids(warning.sharedNetwork.map((a) => a.id))}): these ` +
        "agents can reach services on this host directly, not only the RPC endpoint they were given.",
    );
  }
  if (warning.openEgress.length > 0)
    lines.push(
      `  per-agent networks with a route out (${ids(warning.openEgress)}): ERIS_AGENT_INTERNAL is not ` +
        "set, so these agents can open outbound connections.",
    );
  if (warning.bindMount.length > 0)
    lines.push(
      `  bind-mount mode (${ids(warning.bindMount)}): the repository is mounted into the container; ` +
        "this mode is not an isolation boundary.",
    );
  if (warning.periodDirectory.length > 0)
    lines.push(
      `  segmented period (${ids(warning.periodDirectory)}): the container mounts the period ` +
        "directory, not only the agent's own view and logs.",
    );
  lines.push(
    `  The live week runs with: ${LIVE_WEEK_AGENT_NETWORK}`,
    "  (infra/docker-agent/ISOLATION.md). Not fatal: this run continues.",
  );
  const rule = "=".repeat(78);
  return [rule, ...lines, rule].map((l) => `[run] ${l}`).join("\n");
}
