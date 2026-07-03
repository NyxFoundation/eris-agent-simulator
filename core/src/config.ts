// 環境(core)側の設定レイヤ（ADR 0015）。
//   - SimConfig / loadConfig は sdk（両プロセス共有の契約）から re-export
//   - stress/vuln イベントのスケジュール定義は環境専用なので RealtimeConfig として拡張する
//   - agent ロスター（AgentSpec の検証・wallet 解決）は環境の仕事なのでここに置く
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { keccak256, stringToBytes, type Hex } from "viem";
import { loadConfig, unitSuffixFor, type SimConfig } from "@eris/sdk/config.js";
import type { AgentSpec, AgentsFile } from "@eris/sdk/types.js";
import {
  parseStressEvents,
  type StressEventConfig,
} from "./realtime/events.js";
import {
  parseVulnEvents,
  type VulnEventConfig,
} from "./realtime/vulnEvents.js";

export { loadConfig, unitSuffixFor };
export type { SimConfig };

// 環境デーモンだけが読む設定（stress/vuln イベント定義）を SimConfig に重ねた型。
// SimContext.config は SimConfig のままなので adapter / agent ランタイムへは露出しない。
export type RealtimeConfig = SimConfig & {
  // 市場ストレスイベント(ADR 0009)。OU の base price に重ねる決定論オーバーレイ。
  // ERIS_STRESS_EVENTS の JSON 配列(レンジ指定)で spike/crash を与える。空(既定)なら従来 run と一致。
  stressEvents: StressEventConfig[];
  // 脆弱性発生イベント(ADR 0014)。SEED 由来で N 個の新規プール(正直/rigged 混在)を run 中に
  // deploy・資金供給する。ERIS_VULN_EVENTS の JSON 配列(レンジ指定)。空(既定)なら従来 run と一致。
  vulnEvents: VulnEventConfig[];
};

export function loadRealtimeConfig(env = process.env): RealtimeConfig {
  return {
    ...loadConfig(env),
    stressEvents: parseStressEvents(env.ERIS_STRESS_EVENTS),
    vulnEvents: parseVulnEvents(env.ERIS_VULN_EVENTS),
  };
}

const NAMED_AGENT_WALLETS = [
  "AGENT0_PRIVATE_KEY",
  "AGENT1_PRIVATE_KEY",
  "AGENT2_PRIVATE_KEY",
  "AGENT3_PRIVATE_KEY",
  "AGENT4_PRIVATE_KEY",
  "AGENT5_PRIVATE_KEY",
  "AGENT6_PRIVATE_KEY",
] as const;
const SUPPORTED_AGENT_WALLETS = [...NAMED_AGENT_WALLETS, "AUTO"] as const;

export function loadAgents(path: string): AgentSpec[] {
  if (!existsSync(path)) return defaultAgents();
  const text = readFileSync(path, "utf8");
  // ADR 0013: ロスターは JSON / YAML どちらも可（拡張子で判定）。
  const parsed =
    path.endsWith(".yaml") || path.endsWith(".yml")
      ? parseYaml(text)
      : JSON.parse(text);
  return validateAgentsFile(parsed, path);
}

export function privateKeyForWalletName(
  config: SimConfig,
  wallet: string,
  agentId: string,
): Hex {
  switch (wallet) {
    case "AGENT0_PRIVATE_KEY":
      return config.privateKeys.agent0;
    case "AGENT1_PRIVATE_KEY":
      return config.privateKeys.agent1;
    case "AGENT2_PRIVATE_KEY":
      return config.privateKeys.agent2;
    case "AGENT3_PRIVATE_KEY":
      return config.privateKeys.agent3;
    case "AGENT4_PRIVATE_KEY":
      return config.privateKeys.agent4;
    case "AGENT5_PRIVATE_KEY":
      return config.privateKeys.agent5;
    case "AGENT6_PRIVATE_KEY":
      return config.privateKeys.agent6;
    case "AUTO":
      return deriveAutoPrivateKey(config.seed, agentId);
    default:
      throw new Error(`Unsupported wallet binding: ${wallet}`);
  }
}

function deriveAutoPrivateKey(seed: number, agentId: string): Hex {
  return keccak256(stringToBytes(`auto-wallet:${seed}:${agentId}`));
}

// ディレクトリ規約（ADR 0015 §6）: command 省略時は id が <agentsDir>/<id>/ を指す。
function defaultAgents(): AgentSpec[] {
  return validateAgentsFile(
    {
      agents: [
        { id: "noop", wallet: "AGENT0_PRIVATE_KEY" },
        { id: "random", wallet: "AGENT1_PRIVATE_KEY" },
        { id: "simple-rule", wallet: "AGENT2_PRIVATE_KEY" },
      ],
    },
    "default agents",
  );
}

export function validateAgentsFile(parsed: unknown, path: string): AgentSpec[] {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${path} must be a JSON object`);
  }
  const file = parsed as AgentsFile;
  if (!Array.isArray(file.agents) || file.agents.length === 0) {
    throw new Error(`${path} must contain a non-empty "agents" array`);
  }
  const seenIds = new Set<string>();
  const seenNamedWallets = new Set<string>();
  return file.agents.map((agent, index) => {
    const label = `${path} agents[${index}]`;
    if (!agent || typeof agent !== "object")
      throw new Error(`${label} must be an object`);
    if (typeof agent.id !== "string" || agent.id.trim() === "")
      throw new Error(`${label}.id must be a non-empty string`);
    if (seenIds.has(agent.id))
      throw new Error(`${path} contains duplicate agent id: ${agent.id}`);
    seenIds.add(agent.id);
    // ADR 0015 §6: command/args は省略可（規約解決 = <agentsDir>/<id>/ を runtime/bot.ts が駆動）。
    // 明示 command は完全自前 agent（他言語等）の override として残す。
    if (
      agent.command !== undefined &&
      (typeof agent.command !== "string" || agent.command.trim() === "")
    )
      throw new Error(
        `${label}.command must be a non-empty string when present`,
      );
    if (
      agent.args !== undefined &&
      (!Array.isArray(agent.args) ||
        !agent.args.every((arg) => typeof arg === "string"))
    ) {
      throw new Error(`${label}.args must be an array of strings`);
    }
    if (agent.args !== undefined && agent.command === undefined) {
      throw new Error(`${label}.args requires an explicit command`);
    }
    if (!isSupportedAgentWallet(agent.wallet)) {
      throw new Error(
        `${label}.wallet must be one of ${SUPPORTED_AGENT_WALLETS.join(", ")}`,
      );
    }
    if (agent.wallet !== "AUTO") {
      if (seenNamedWallets.has(agent.wallet)) {
        throw new Error(
          `${path} reuses named wallet ${agent.wallet}; use "AUTO" for additional agents`,
        );
      }
      seenNamedWallets.add(agent.wallet);
    }
    if (
      agent.description !== undefined &&
      typeof agent.description !== "string"
    ) {
      throw new Error(`${label}.description must be a string when present`);
    }
    if (agent.baseline !== undefined && typeof agent.baseline !== "boolean") {
      throw new Error(`${label}.baseline must be a boolean when present`);
    }
    if (agent.env !== undefined) {
      if (
        !agent.env ||
        typeof agent.env !== "object" ||
        Array.isArray(agent.env)
      ) {
        throw new Error(`${label}.env must be an object of string key/values`);
      }
      for (const [k, v] of Object.entries(agent.env)) {
        if (typeof k !== "string" || typeof v !== "string") {
          throw new Error(
            `${label}.env must contain only string keys and string values (offending key: ${k})`,
          );
        }
      }
    }
    return {
      id: agent.id,
      command: agent.command,
      args: agent.args,
      wallet: agent.wallet,
      description: agent.description,
      env: agent.env,
      baseline: agent.baseline,
    };
  });
}

function isSupportedAgentWallet(
  wallet: unknown,
): wallet is (typeof SUPPORTED_AGENT_WALLETS)[number] {
  return (
    typeof wallet === "string" &&
    SUPPORTED_AGENT_WALLETS.includes(
      wallet as (typeof SUPPORTED_AGENT_WALLETS)[number],
    )
  );
}
