// Environment (core) side run config entry point (ADR 0013 / ADR 0015).
// The shared YAML->SimConfig part lives in sdk/src/runConfig.ts (the agent process uses the same one).
// Here we layer on environment-only resolution: the roster (inline agents / AGENTS_CONFIG), the
// stress/vuln event extensions, CLI flags (one-off overrides like --seed), and warnings for retired env.
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  buildSource,
  DEFAULT_CONFIG_PATH,
  EXAMPLE_CONFIG_PATH,
  loadYamlConfig,
  SECRET_ENV_KEYS,
  toEnvString,
} from "@eris/sdk/runConfig.js";
import type { AgentSpec } from "@eris/sdk/types.js";
import {
  loadAgents,
  validateAgentsFile,
  type RealtimeConfig,
} from "./config.js";
import { parseStressEvents } from "./realtime/events.js";
import { parseVulnEvents } from "./realtime/vulnEvents.js";

export {
  buildSource,
  DEFAULT_CONFIG_PATH,
  EXAMPLE_CONFIG_PATH,
  SECRET_ENV_KEYS,
  toEnvString,
};

// Config file resolution order: --config > ERIS_CONFIG > config/local.yaml > config/example.yaml.
// Returns the first one that exists (undefined if none).
function resolveConfigPathOrUndefined(argv: string[]): string | undefined {
  const i = argv.indexOf("--config");
  const explicit = i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  const candidates = [
    explicit,
    process.env.ERIS_CONFIG,
    DEFAULT_CONFIG_PATH,
    EXAMPLE_CONFIG_PATH,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return candidates.find((p) => existsSync(p));
}

export type RunConfigResult = {
  config: RealtimeConfig;
  agents: AgentSpec[];
  configPath: string;
  source: NodeJS.ProcessEnv;
};

// Read the YAML config file and resolve it into a RealtimeConfig + roster.
export function loadRunConfig(
  path = DEFAULT_CONFIG_PATH,
  overrides: Record<string, string | number | boolean> = {},
): RunConfigResult {
  const { config, doc, configPath, source } = loadYamlConfig(path, overrides);
  const realtimeConfig: RealtimeConfig = {
    ...config,
    stressEvents: parseStressEvents(source.ERIS_STRESS_EVENTS),
    vulnEvents: parseVulnEvents(source.ERIS_VULN_EVENTS),
  };
  // Roster: use inline `agents:` if present, otherwise read the AGENTS_CONFIG file.
  // (backtest's --agents replacement is realized by the backtest CLI baking the roster into the
  // effective regime YAML's inline agents = don't add a priority branch here. ADR 0016)
  const agents = Array.isArray(doc.agents)
    ? validateAgentsFile({ agents: doc.agents }, path)
    : loadAgents(realtimeConfig.agentsConfigPath);
  return { config: realtimeConfig, agents, configPath, source };
}

// The resolved config file path (if it exists). Order: --config > ERIS_CONFIG > config/local.yaml >
// config/example.yaml.
export function currentConfigPath(
  argv: string[] = process.argv,
): string | undefined {
  return resolveConfigPathOrUndefined(argv);
}

// The raw YAML doc, for tools to read their own section. Empty object if there's no YAML.
export function loadConfigDoc(
  argv: string[] = process.argv,
): Record<string, unknown> {
  const path = currentConfigPath(argv);
  if (!path) return {};
  const doc = parseYaml(readFileSync(path, "utf8"));
  return doc && typeof doc === "object" && !Array.isArray(doc)
    ? (doc as Record<string, unknown>)
    : {};
}

// Lightweight parser for `--key value` / `--key=value` / `--flag` (used for one-off overrides in place of env).
export function parseCliFlags(
  argv: string[] = process.argv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) out[body.slice(0, eq)] = body.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--"))
      out[body] = argv[++i];
    else out[body] = "1";
  }
  return out;
}

// Warn if a representative retired "config env" is still set (prevents silently falling back to default behavior).
// These are no longer read. Config goes in YAML (config/local.yaml / --config), tool params in CLI flags.
const RETIRED_CONFIG_ENV = [
  "ENABLED_PROTOCOLS",
  "AGENTS_CONFIG",
  "SEED",
  "ERIS_RUN_BLOCKS",
  "ERIS_RUN_SECONDS",
  "ERIS_ECONOMIC_GAS",
  "REGIMES",
  "REPLICATIONS",
  "ROUNDS",
  "GATE_MODE",
  "INITIAL_WETH_WEI",
  // relay mode has been removed (ADR 0015 §5). Setting it does not roll anything back.
  "ERIS_AGENT_DIRECT_TX",
] as const;
let warnedRetired = false;
function warnRetiredConfigEnv(): void {
  if (warnedRetired) return;
  const found = RETIRED_CONFIG_ENV.filter((k) => process.env[k] !== undefined);
  if (found.length === 0) return;
  warnedRetired = true;
  process.stderr.write(
    `[config] warning: config env is retired (ignored): ${found.join(", ")}.` +
      ` Specify config via config/local.yaml / --config, and tool params via CLI flags (--seed, etc.).\n`,
  );
}

// CLI aliases for one-off overrides (a replacement for env). Used like `--seed 1 --protocols uniswap,balancer`.
// Values map to the same config keys as YAML and are pushed onto overrides (changeable per run without editing YAML).
const CLI_ALIAS: Record<string, string> = {
  seed: "SEED",
  blocks: "ERIS_RUN_BLOCKS",
  seconds: "ERIS_RUN_SECONDS",
  protocols: "ENABLED_PROTOCOLS",
  agents: "AGENTS_CONFIG",
  "economic-gas": "ERIS_ECONOMIC_GAS",
  "local-deploy": "ERIS_LOCAL_DEPLOY",
};
function cliOverrides(argv: string[]): Record<string, string> {
  const flags = parseCliFlags(argv);
  const out: Record<string, string> = {};
  for (const [alias, key] of Object.entries(CLI_ALIAS))
    if (flags[alias] !== undefined) out[key] = flags[alias];
  return out;
}

// Entry point for CLI/coordinator. Config is unified in YAML (reading config from env is dropped).
// Resolution order: --config > ERIS_CONFIG > config/local.yaml > config/example.yaml. If none exist,
// an explicit error (no fallback to env). CLI aliases (--seed, etc.) and programmatic overrides are
// layered on top of the YAML (overrides take highest priority).
export function resolveRunInputs(
  argv: string[] = process.argv,
  overrides: Record<string, string | number | boolean> = {},
): {
  config: RealtimeConfig;
  agents: AgentSpec[];
  configPath?: string;
} {
  warnRetiredConfigEnv();
  const path = resolveConfigPathOrUndefined(argv);
  if (!path)
    throw new Error(
      `no config file found. cp ${EXAMPLE_CONFIG_PATH} ${DEFAULT_CONFIG_PATH} ` +
        `(or pass --config <path>). Config is unified in YAML (reading config from env is dropped).`,
    );
  const merged = { ...cliOverrides(argv), ...overrides };
  const r = loadRunConfig(path, merged);
  return { config: r.config, agents: r.agents, configPath: r.configPath };
}
