// YAML を設定の単一ソースにする run config ローダの共有部（ADR 0013 / ADR 0015）。
//
// 方針:
//   - ユーザー設定値（run ノブ / funding / limits / flow / stress / vuln）を 1 つの YAML
//     （既定 `config/local.yaml`）で管理する。YAML のキーは既存の env 名と同一にし、
//     型変換（bool→"1"/"0"、文字列/数値配列→CSV、object→JSON）して loadConfig が読む source map に
//     流し込む。これで loadConfig の全パーサ（bigintEnv/intEnv 等）を無改修で再利用できる。
//   - **秘密情報のみ env(.env) のまま**（コミットされる YAML に秘密を入れない。外部 SDK が env を
//     直読みするため）。SECRET_ENV_KEYS だけ process.env から source へ持ち込む。
//   - agent サブプロセスへの IPC（ERIS_AGENT_* 等）は coordinator が別途 env で渡す（YAML 対象外）。
//     子は設定ファイルパス ERIS_CONFIG を受け取り、この loadYamlConfig で同じ YAML から config を
//     再構築する（環境と agent が同一の設定断面を共有する = 本ファイルが sdk に在る理由）。
//   - ロスター解決・CLI フラグは環境の仕事なので core/src/runConfig.ts 側にある。
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { loadConfig, unitSuffixFor, type SimConfig } from "./config.js";
import { tokenInfo } from "./markets.js";

// .env に残す秘密 / RPC（YAML には入れない）。これらは process.env から source へ持ち込む。
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

// 設定は config/ ディレクトリで管理する。ローカルの実ファイルは config/local.yaml（gitignore）、
// コミット済みの雛形・シナリオは config/example.yaml 等。
export const DEFAULT_CONFIG_PATH = "config/local.yaml";
// config/local.yaml が無いときの zero-config 既定（env config 読取は廃止したため env ではなくこれへ）。
export const EXAMPLE_CONFIG_PATH = "config/example.yaml";

// YAML 値 → env 文字列。loadConfig の各パーサが受け取る形へ正規化する。
//   boolean        → "1" / "0"（loadConfig は `=== "1"` で真偽判定）
//   string/num 配列 → CSV（ENABLED_PROTOCOLS / FLOW_BOT_ARGS 等）
//   object / object配列 → JSON（ERIS_STRESS_EVENTS 等）
//   その他         → String(v)
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

// ネスト lowercase スキーマ（人が書く形）→ 内部 env 名（loadConfig が読む形）の対応表。
// 例: `run.protocols` → ENABLED_PROTOCOLS。全大文字 env 名を表に出さないための薄い変換層。
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
  "run.agentsConfig": "AGENTS_CONFIG", // inline agents が無いときのロスターファイルパス
  "run.agentsDir": "ERIS_AGENTS_DIR", // agent ディレクトリ規約のルート（ADR 0015 §6）
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
  "flow.seed": "FLOW_SEED",
  "flow.botCommand": "FLOW_BOT_COMMAND",
  "flow.botArgs": "FLOW_BOT_ARGS",
  // stress
  "stress.events": "ERIS_STRESS_EVENTS",
  "stress.victimCount": "ERIS_STRESS_VICTIM_COUNT",
  "stress.victimHf0": "ERIS_STRESS_VICTIM_HF0",
  "stress.victimWethWei": "ERIS_STRESS_VICTIM_WETH_WEI",
  // vuln（ADR 0014: 脆弱性発生イベント）
  "vuln.events": "ERIS_VULN_EVENTS",
  "vuln.poolLiquidityUsdcUnits": "ERIS_VULN_POOL_LIQUIDITY_USDC_UNITS",
  "vuln.poolFeeBps": "ERIS_VULN_POOL_FEE_BPS",
  "vuln.llm": "ERIS_VULN_LLM",
};
// per-base マップ（`{WBTC: 値}` → `<prefix>_<SYM>[_<infix>]_<unit>`。unit は decimals 由来）。
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

// ネスト doc を内部 env 名 source へ展開する。未知キーは警告（typo 検出）。
function applyDoc(
  doc: Record<string, unknown>,
  source: NodeJS.ProcessEnv,
): void {
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(doc)) {
    if (k === "agents") continue; // ロスターは環境側（core/src/runConfig.ts）が扱う
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
          // FLOW_BOT_ARGS だけは空白区切り（config.ts が /\s+/ で split）。
          source[env] =
            env === "FLOW_BOT_ARGS" && Array.isArray(sv)
              ? sv.map((x) => String(x)).join(" ")
              : toEnvString(sv);
        } else {
          unknown.push(path);
        }
      }
    } else if (/^[A-Z]/.test(k)) {
      source[k] = toEnvString(v); // 後方互換: 大文字キーは env 名としてそのまま通す
    } else {
      unknown.push(k);
    }
  }
  if (unknown.length > 0)
    process.stderr.write(
      `[config] 警告: 未知の設定キー（無視）: ${unknown.join(", ")}。スキーマは sdk/src/runConfig.ts の SCHEMA を参照。\n`,
    );
}

// YAML から source map を組む（秘密 env → YAML → overrides の順で重ねる）。
export function buildSource(
  doc: Record<string, unknown>,
  overrides: Record<string, string | number | boolean> = {},
  configPath?: string,
): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = {};
  for (const k of SECRET_ENV_KEYS)
    if (process.env[k] !== undefined) source[k] = process.env[k];
  applyDoc(doc, source);
  // overrides は内部 env 名キー（CLI エイリアスが既に env 名へマップ済み）で最優先。
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

// YAML 設定ファイルを読み、SimConfig へ解決する（ロスターは含まない = agent プロセスからも安全に
// 呼べる）。環境側は core/src/runConfig.ts の loadRunConfig（ロスター + stress/vuln 拡張）を使う。
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
