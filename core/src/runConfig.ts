// 環境(core)側の run config 入口（ADR 0013 / ADR 0015）。
// YAML→SimConfig の共有部は sdk/src/runConfig.ts（agent プロセスも同じものを使う）。ここは
// 環境専用の解決を重ねる: ロスター（inline agents / AGENTS_CONFIG）、stress/vuln イベント拡張、
// CLI フラグ（--seed 等の一回限り上書き）、退役 env の警告。
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

// 設定ファイルの解決順: --config > ERIS_CONFIG > config/local.yaml > config/example.yaml。
// 最初に存在するものを返す（無ければ undefined）。
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

// YAML 設定ファイルを読み、RealtimeConfig + ロスターへ解決する。
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
  // ロスター: inline `agents:` があればそれを、無ければ AGENTS_CONFIG のファイルを読む。
  // （backtest の --agents 差し替えは、backtest CLI が roster を実効 regime YAML の inline
  // agents へ焼き込むことで実現する = ここに優先順位の分岐を足さない。ADR 0016）
  const agents = Array.isArray(doc.agents)
    ? validateAgentsFile({ agents: doc.agents }, path)
    : loadAgents(realtimeConfig.agentsConfigPath);
  return { config: realtimeConfig, agents, configPath, source };
}

// 解決される設定ファイルパス（存在すれば）。--config > ERIS_CONFIG > config/local.yaml >
// config/example.yaml の順。
export function currentConfigPath(
  argv: string[] = process.argv,
): string | undefined {
  return resolveConfigPathOrUndefined(argv);
}

// ツールが自分のセクションを読むための raw YAML doc。YAML が無ければ空オブジェクト。
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

// `--key value` / `--key=value` / `--flag` を拾う軽量パーサ（env の代わりに一回限りの上書きに使う）。
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

// 退役した代表的な「設定 env」が残っていたら警告する（silent に既定動作へ落ちる事故を防ぐ）。
// これらはもう読まれない。設定は YAML（config/local.yaml / --config）へ、ツール params は CLI フラグへ。
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
  // relay モードは撤去済み（ADR 0015 §5）。設定してもロールバックにはならない。
  "ERIS_AGENT_DIRECT_TX",
] as const;
let warnedRetired = false;
function warnRetiredConfigEnv(): void {
  if (warnedRetired) return;
  const found = RETIRED_CONFIG_ENV.filter((k) => process.env[k] !== undefined);
  if (found.length === 0) return;
  warnedRetired = true;
  process.stderr.write(
    `[config] 警告: 設定 env は退役しました（無視されます）: ${found.join(", ")}。` +
      ` 設定は config/local.yaml / --config、ツール params は CLI フラグ（--seed 等）で指定してください。\n`,
  );
}

// 一回限りの上書き用 CLI エイリアス（env の代替）。`--seed 1 --protocols uniswap,balancer` のように使う。
// 値は YAML と同じ設定キーへマップして overrides に積む（YAML を編集せず run ごとに変えられる）。
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

// CLI/coordinator 用の入口。設定は YAML 一本化（env config 読取は廃止）。解決順は
// --config > ERIS_CONFIG > config/local.yaml > config/example.yaml。いずれも無ければ
// 明示エラー（env へはフォールバックしない）。CLI エイリアス（--seed 等）と programmatic
// overrides を YAML の上に重ねる（overrides が最優先）。
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
        `(または --config <path> を指定)。設定は YAML 一本化済み（env からの設定読取は廃止）。`,
    );
  const merged = { ...cliOverrides(argv), ...overrides };
  const r = loadRunConfig(path, merged);
  return { config: r.config, agents: r.agents, configPath: r.configPath };
}
