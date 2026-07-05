// Shared part of the run-config loader that makes YAML the single source of config (ADR 0013 / ADR 0015).
//
// Policy:
//   - Manage user config values (run knobs / funding / limits / flow / stress / vuln) in a single YAML
//     (default `config/local.yaml`). YAML keys match the existing env names; convert types
//     (bool→"1"/"0", string/number array→CSV, object→JSON) and feed the source map that loadConfig
//     reads. This reuses all of loadConfig's parsers (bigintEnv/intEnv, etc.) unchanged.
//   - **Only secrets stay in env (.env)** (do not put secrets in committed YAML, because external SDKs
//     read env directly). Only SECRET_ENV_KEYS are brought from process.env into source.
//   - IPC to the agent subprocess (ERIS_AGENT_* etc.) is passed separately via env by the coordinator
//     (not covered by YAML). The child receives the config file path ERIS_CONFIG and rebuilds config
//     from the same YAML via this loadYamlConfig (environment and agent share the same config
//     cross-section = the reason this file lives in the sdk).
//   - Roster resolution and CLI flags are the environment's job, so they live in core/src/runConfig.ts.
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { loadConfig, unitSuffixFor, type SimConfig } from "./config.js";
import { tokenInfo } from "./markets.js";

// Secrets / RPC that stay in .env (not put in YAML). These are brought from process.env into source.
export const SECRET_ENV_KEYS = [
  "ARB_RPC_URL",
  "FORK_BLOCK_NUMBER",
  "ANVIL_RPC_URL",
  "ANTHROPIC_API_KEY",
  "OLLAMA_API_KEY",
  "ERIS_OLLAMA_API_KEY",
  "ADMIN_PRIVATE_KEY",
  "KEEPER_PRIVATE_KEY",
  "SETUP_PRIVATE_KEY",
  "FLOW_UNINFORMED_PRIVATE_KEY",
  "FLOW_INFORMED_PRIVATE_KEY",
  "AGENT0_PRIVATE_KEY",
  "AGENT1_PRIVATE_KEY",
  "AGENT2_PRIVATE_KEY",
  "AGENT3_PRIVATE_KEY",
  "AGENT4_PRIVATE_KEY",
  "AGENT5_PRIVATE_KEY",
  "AGENT6_PRIVATE_KEY",
] as const;

// Config is managed under the config/ directory. The local real file is config/local.yaml (gitignored),
// and committed templates/scenarios are config/example.yaml etc.
export const DEFAULT_CONFIG_PATH = "config/local.yaml";
// The zero-config default when config/local.yaml is absent (env config reading was retired, so this instead of env).
export const EXAMPLE_CONFIG_PATH = "config/example.yaml";

// YAML value → env string. Normalizes into the shape each loadConfig parser expects.
//   boolean          → "1" / "0" (loadConfig decides truth via `=== "1"`)
//   string/num array → CSV (ENABLED_PROTOCOLS / FLOW_BOT_ARGS, etc.)
//   object / object array → JSON (ERIS_STRESS_EVENTS, etc.)
//   otherwise        → String(v)
export function toEnvString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string" || typeof v === "number"))
      return value.map((v) => String(v)).join(",");
    return JSON.stringify(value);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Mapping from the nested lowercase schema (the human-authored form) to the internal env names (the
// form loadConfig reads). E.g. `run.protocols` → ENABLED_PROTOCOLS. A thin translation layer that keeps the all-caps env names out of sight.
const SCHEMA: Record<string, string> = {
  // run
  "run.seed": "SEED",
  "run.blocks": "ERIS_RUN_BLOCKS",
  "run.seconds": "ERIS_RUN_SECONDS",
  "run.blockTimeSec": "ERIS_BLOCK_TIME_SEC",
  "run.protocols": "ENABLED_PROTOCOLS",
  "run.economicGas": "ERIS_ECONOMIC_GAS",
  "run.localDeploy": "ERIS_LOCAL_DEPLOY",
  "run.skipReset": "ERIS_SKIP_RESET",
  "run.prewarmBlocks": "ERIS_PREWARM_BLOCKS",
  "run.reportDir": "REPORT_DIR",
  "run.flashArb": "ERIS_FLASH_ARB",
  "run.localSnapshotFile": "ERIS_LOCAL_SNAPSHOT_FILE",
  "run.agentTimeoutMs": "AGENT_TIMEOUT_MS",
  "run.agentsConfig": "AGENTS_CONFIG", // roster file path when there are no inline agents
  "run.agentsDir": "ERIS_AGENTS_DIR", // root of the agent directory convention (ADR 0015 §6)
  // funding
  "funding.ethWei": "INITIAL_ETH_WEI",
  "funding.wethWei": "INITIAL_WETH_WEI",
  "funding.usdcUnits": "INITIAL_USDC_UNITS",
  "funding.flowEthWei": "ERIS_FLOW_ETH_WEI",
  "funding.flowWethWei": "FLOW_WETH_WEI",
  // limits
  "limits.agentWethWei": "MAX_AGENT_WETH_IN_WEI",
  "limits.agentUsdcUnits": "MAX_AGENT_USDC_IN_UNITS",
  "limits.lpWethWei": "MAX_LP_WETH_WEI",
  "limits.lpUsdcUnits": "MAX_LP_USDC_UNITS",
  "limits.bundleActions": "MAX_BUNDLE_ACTIONS",
  "limits.openPositions": "MAX_OPEN_POSITIONS",
  "limits.gmxSizeUsd": "MAX_GMX_SIZE_USD",
  "limits.aaveSupplyWethWei": "MAX_AAVE_SUPPLY_WETH_WEI",
  "limits.aaveBorrowUsdcUnits": "MAX_AAVE_BORROW_USDC_UNITS",
  "limits.priorityFeeWei": "DEFAULT_PRIORITY_FEE_WEI",
  "limits.maxPriorityFeeWei": "MAX_PRIORITY_FEE_WEI",
  // flow
  "flow.uninformedMaxWethWei": "UNINFORMED_FLOW_MAX_WETH_WEI",
  "flow.uninformedCount": "UNINFORMED_FLOW_COUNT",
  "flow.uninformedPersistBlocks": "UNINFORMED_FLOW_PERSIST_BLOCKS",
  "flow.informedMaxWethWei": "INFORMED_FLOW_MAX_WETH_WEI",
  "flow.balancerMaxWethWei": "BALANCER_FLOW_MAX_WETH_WEI",
  "flow.curveMaxWethWei": "CURVE_FLOW_MAX_WETH_WEI",
  "flow.gmxMaxSizeUsd": "GMX_FLOW_MAX_SIZE_USD",
  "flow.gmxActivityProb": "GMX_FLOW_ACTIVITY_PROB",
  "flow.gmxMaxBurst": "GMX_FLOW_MAX_BURST",
  "flow.aaveMaxWethWei": "AAVE_FLOW_MAX_WETH_WEI",
  "flow.aaveActivityProb": "AAVE_FLOW_ACTIVITY_PROB",
  "flow.aaveActorCount": "AAVE_FLOW_ACTOR_COUNT",
  "flow.informedArbFeeBps": "ERIS_INFORMED_ARB_FEE_BPS",
  "flow.uninformedArrivalRate": "ERIS_UNINFORMED_ARRIVAL_RATE",
  "flow.uninformedSizeSigma": "ERIS_UNINFORMED_SIZE_SIGMA",
  "flow.gmxArrivalRate": "ERIS_GMX_ARRIVAL_RATE",
  "flow.gmxSizeSigma": "ERIS_GMX_SIZE_SIGMA",
  "flow.aaveActorSizeSigma": "ERIS_AAVE_ACTOR_SIZE_SIGMA",
  "flow.seed": "FLOW_SEED",
  "flow.botCommand": "FLOW_BOT_COMMAND",
  "flow.botArgs": "FLOW_BOT_ARGS",
  // stress
  "stress.events": "ERIS_STRESS_EVENTS",
  "stress.victimCount": "ERIS_STRESS_VICTIM_COUNT",
  "stress.victimHf0": "ERIS_STRESS_VICTIM_HF0",
  "stress.victimWethWei": "ERIS_STRESS_VICTIM_WETH_WEI",
  // vuln (ADR 0014: vulnerability-occurrence events)
  "vuln.events": "ERIS_VULN_EVENTS",
  "vuln.poolLiquidityUsdcUnits": "ERIS_VULN_POOL_LIQUIDITY_USDC_UNITS",
  "vuln.poolFeeBps": "ERIS_VULN_POOL_FEE_BPS",
  "vuln.llm": "ERIS_VULN_LLM",
};
// per-base map (`{WBTC: value}` → `<prefix>_<SYM>[_<infix>]_<unit>`. unit is derived from decimals).
const BASE_SECTIONS: Record<string, { prefix: string; infix?: string }> = {
  "funding.base": { prefix: "INITIAL" },
  "funding.flowBase": { prefix: "FLOW_BASE" },
  "limits.agentBase": { prefix: "MAX_AGENT", infix: "IN" },
  "limits.lpBase": { prefix: "MAX_LP" },
  "limits.aaveSupplyBase": { prefix: "MAX_AAVE_SUPPLY" },
  "flow.baseMax": { prefix: "FLOW_MAX" },
};
const SECTIONS = ["run", "funding", "limits", "flow", "stress", "vuln"];

function baseEnvName(prefix: string, sym: string, infix?: string): string {
  const unit = unitSuffixFor(tokenInfo(sym).decimals);
  return [prefix, sym, infix, unit].filter(Boolean).join("_");
}

// Expand the nested doc into the internal env-name source. Unknown keys are warned about (typo detection).
function applyDoc(
  doc: Record<string, unknown>,
  source: NodeJS.ProcessEnv,
): void {
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(doc)) {
    if (k === "agents") continue; // the roster is handled on the environment side (core/src/runConfig.ts)
    if (
      SECTIONS.includes(k) &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        const path = `${k}.${sk}`;
        const baseDef = BASE_SECTIONS[path];
        if (baseDef) {
          if (sv && typeof sv === "object" && !Array.isArray(sv))
            for (const [sym, amt] of Object.entries(
              sv as Record<string, unknown>,
            ))
              source[baseEnvName(baseDef.prefix, sym, baseDef.infix)] =
                toEnvString(amt);
        } else if (SCHEMA[path]) {
          const env = SCHEMA[path];
          // FLOW_BOT_ARGS is the only one that is space-separated (config.ts splits on /\s+/).
          source[env] =
            env === "FLOW_BOT_ARGS" && Array.isArray(sv)
              ? sv.map((x) => String(x)).join(" ")
              : toEnvString(sv);
        } else {
          unknown.push(path);
        }
      }
    } else if (/^[A-Z]/.test(k)) {
      source[k] = toEnvString(v); // backward compatible: pass uppercase keys through as-is as env names
    } else {
      unknown.push(k);
    }
  }
  if (unknown.length > 0)
    process.stderr.write(
      `[config] warning: unknown config keys (ignored): ${unknown.join(", ")}. See SCHEMA in sdk/src/runConfig.ts for the schema.\n`,
    );
}

// Build the source map from YAML (layered in order: secret env → YAML → overrides).
export function buildSource(
  doc: Record<string, unknown>,
  overrides: Record<string, string | number | boolean> = {},
  configPath?: string,
): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = {};
  for (const k of SECRET_ENV_KEYS)
    if (process.env[k] !== undefined) source[k] = process.env[k];
  applyDoc(doc, source);
  // overrides use internal env-name keys (CLI aliases are already mapped to env names) and take top priority.
  for (const [k, v] of Object.entries(overrides)) source[k] = toEnvString(v);
  if (configPath) source.ERIS_CONFIG = configPath;
  return source;
}

export type YamlConfigResult = {
  config: SimConfig;
  doc: Record<string, unknown>;
  configPath: string;
  source: NodeJS.ProcessEnv;
};

// Read a YAML config file and resolve it into a SimConfig (roster not included = safe to call from
// the agent process too). The environment side uses loadRunConfig in core/src/runConfig.ts (roster + stress/vuln extensions).
export function loadYamlConfig(
  path = DEFAULT_CONFIG_PATH,
  overrides: Record<string, string | number | boolean> = {},
): YamlConfigResult {
  if (!existsSync(path)) throw new Error(`config file not found: ${path}`);
  const doc = parseYaml(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  > | null;
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new Error(`${path} must be a YAML mapping`);

  const source = buildSource(doc, overrides, path);
  const config = loadConfig(source);
  return { config, doc, configPath: path, source };
}
