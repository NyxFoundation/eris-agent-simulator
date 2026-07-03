/**
 * prompt.ts: プロンプト型 agent（prompt.md 1 枚）の合成（ADR 0015 §4）。
 *
 * system = JSON mode 指示 + <schema>{action の JSON Schema}</schema> + 環境ルール（固定文）
 *          + prompt.md 本文
 * user   = 最新 observation + agentLog 由来の直近の行動と結果
 *
 * <schema> 形式は ollama 系オープンモデルの学習分布（Hermes JSON mode。
 * NousResearch/Hermes-Function-Calling）に合わせたもの。<schema> と実行時検証
 * （validateAction）は sdk の同一 action スキーマ（actionSchema.ts）から導出する。
 *
 * frontmatter は Agent Skills 標準（agentskills.io）と同じ形: name / description 必須、
 * intervalMs / model は任意、未知フィールドは無視（前方互換）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { actionJsonSchema } from "@eris/sdk/actionSchema.js";
import { safeStringify } from "@eris/sdk/logger.js";
import type { AgentObservation, ProtocolId } from "@eris/sdk/types.js";

export type PromptAgent = {
  name: string;
  description: string;
  intervalMs?: number;
  model?: string;
  body: string;
};

export const DEFAULT_PROMPT_INTERVAL_MS = 5000;
export const DEFAULT_PROMPT_MODEL = "gpt-oss:120b";
// 自己改善（prompt 改訂）の既定 = off。ロスターの env ERIS_PROMPT_REVISE_EVERY（判断サイクル数）で有効化。
export const DEFAULT_PROMPT_REVISE_EVERY = 0;

// prompt.md を読み frontmatter を検証する。name/description は必須（ロスター表示・ログヘッダ）。
export function loadPromptAgent(agentDir: string): PromptAgent {
  const path = join(agentDir, "prompt.md");
  if (!existsSync(path)) throw new Error(`prompt.md not found in ${agentDir}`);
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) {
    throw new Error(
      `${path}: frontmatter (---) が必要です（name / description は必須。agentskills.io 互換）`,
    );
  }
  const fm = parseYaml(m[1]) as Record<string, unknown> | null;
  if (!fm || typeof fm !== "object")
    throw new Error(`${path}: frontmatter must be a YAML mapping`);
  if (typeof fm.name !== "string" || fm.name.trim() === "")
    throw new Error(`${path}: frontmatter "name" は必須です`);
  if (typeof fm.description !== "string" || fm.description.trim() === "")
    throw new Error(`${path}: frontmatter "description" は必須です`);
  const intervalMs =
    fm.intervalMs === undefined ? undefined : Number(fm.intervalMs);
  if (
    intervalMs !== undefined &&
    !(Number.isFinite(intervalMs) && intervalMs > 0)
  )
    throw new Error(`${path}: intervalMs must be a positive number`);
  return {
    name: fm.name,
    description: fm.description,
    intervalMs,
    model: typeof fm.model === "string" ? fm.model : undefined,
    body: m[2].trim(),
  };
}

// 環境ルールの固定文。action の**形式**は <schema>（sdk actionSchema 由来）が正なので、
// ここには自然言語でしか言えない環境の意味論だけを書く（observation の読み方・制約・費用）。
// observation / limits の形が変わる PR ではここも同時更新する（ADR 0015 Risks）。
const ENV_RULES = `# Environment rules

You are one trading agent among several competing on a simulated DeFi market
(Uniswap v3 / Balancer / Curve spot, GMX perp, Aave v3 lending — only the venues
listed in observation.enabledProtocols are live this run).

## Observation (the user message contains the latest one as JSON)
- fairPriceUsdcPerWeth: the environment's fair price for WETH in USDC. Venue prices
  that deviate from it tend to revert toward it.
- fairPricesUsd / baseBalances / baseDecimals: per-asset data when more bases (e.g. WBTC) trade.
- protocols.uniswap.pool.priceUsdcPerWeth, protocols.balancer.priceUsdcPerWeth,
  protocols.curve.priceUsdcPerWeth: current venue prices. gap = fair/price - 1.
- balances: your wallet (decimal integer strings; WETH wei 1e18, USDC units 1e6).
- limits: hard caps enforced by the validator. Any action beyond them is rejected
  before reaching the chain (the cycle is wasted).
- competition: priority-fee auction feedback (maxCompetitorPriorityFeeWei etc.).
  Blocks order transactions by priority fee, descending.

## Action rules
- Output exactly ONE action object per decision cycle, as JSON matching the schema.
- Amounts are decimal integer strings in base units (wei / USDC units). Never use floats.
- swap.amountIn must be <= limits.maxWethInWei / maxUsdcInUnits AND <= your balance.
- priority fee (maxPriorityFeePerGasWei) is burned ETH: bid just above
  competition.maxCompetitorPriorityFeeWei when you must win ordering, never more than
  the trade's expected profit. It must be <= limits.maxPriorityFeePerGasWei.
- Reverted transactions still pay gas. If the edge is small or uncertain, emit
  {"type":"noop","reason":"..."} instead.
- Fees/slippage: venue swap fees and slippage come out of your PnL. A gap smaller than
  ~2x total costs is usually not worth taking.`;

// Hermes JSON mode の system prompt（<schema> + ルール + prompt.md 本文）。
// jsonSchema を渡すと再生成しない（bot.ts が LLM tool use 用に作った同じものを共有する）。
export function buildSystemPrompt(
  agent: PromptAgent,
  enabledProtocols?: ProtocolId[],
  jsonSchema?: Record<string, unknown>,
): string {
  const schema = safeStringify(
    jsonSchema ?? actionJsonSchema(enabledProtocols),
  );
  return `You are "${agent.name}" — ${agent.description}.
You are a function-calling trading agent. For each decision cycle, respond with a single
JSON object that conforms to the JSON schema below. Do not output anything else: no prose,
no markdown fences, no explanations outside the JSON.
<schema>
${schema}
</schema>

${ENV_RULES}

# Strategy (written by the participant)
${agent.body}`;
}

// 直近の行動履歴 1 行（agentLog から要約して user message に添える）。
export type RecentAction = {
  round?: number;
  action?: unknown;
  note?: string;
};

// ---------------------------------------------------------------------------
// 自己改善（prompt 改訂）: N 判断サイクルごとに、直近の行動・結果を添えて LLM に
// prompt 本文そのものを書き直させる（改善対象 = プロンプト。ADR 0015 の提出単位と一致）。
// 改訂の規律は旧自己改善機構（_archive/llm/prompts.ts）の教訓を凝縮したもの。
// ---------------------------------------------------------------------------

export type RevisionStats = {
  cycles: number;
  initialValueUsdc: number | null;
  currentValueUsdc: number | null;
  recentRevertRate?: number;
  recentSampleSize?: number;
};

// 改訂用 system prompt。出力は「新しい prompt 本文の markdown だけ」（frontmatter/fence 不要）。
export function buildRevisionSystem(agent: PromptAgent): string {
  return `You are improving the strategy prompt of the trading agent "${agent.name}" (${agent.description}).
You will receive the current strategy prompt body and the agent's recent decisions and results.
Rewrite the strategy prompt body to make the agent measurably better.

Revision discipline:
- Preserve the strategy class and proven profitable behavior; improve the measured weakness.
- Ground every change in the evidence given (recent actions, skips, reverts, value trajectory).
  Never invent a bug or an opportunity the data does not show.
- Reverts, fees and churn are direct costs. If results show over-trading, prefer higher
  thresholds / cooldowns over more aggression.
- Keep the prompt concrete: numeric thresholds, sizing rules, bidding rules, explicit noop rules.
- Total value moves are dominated by price drift (beta); judge changes by trade edge, not equity.

Output ONLY the new prompt body as plain markdown. No frontmatter, no code fences, no commentary.`;
}

// 改訂用 user message（現行本文 + 直近の行動と結果 + 価値推移）。
export function buildRevisionUser(
  body: string,
  recent: RecentAction[],
  stats: RevisionStats,
): string {
  const recentText =
    recent.length === 0
      ? "(none)"
      : recent
          .map(
            (r) =>
              `- round=${r.round ?? "?"} action=${safeStringify(r.action ?? null)}${r.note ? ` note=${r.note}` : ""}`,
          )
          .join("\n");
  const value =
    stats.initialValueUsdc !== null && stats.currentValueUsdc !== null
      ? `${stats.initialValueUsdc.toFixed(2)} -> ${stats.currentValueUsdc.toFixed(2)} USDC (includes price drift beta you do NOT control)`
      : "(not yet observed)";
  const revert =
    stats.recentSampleSize !== undefined && stats.recentSampleSize > 0
      ? `${((stats.recentRevertRate ?? 0) * 100).toFixed(0)}% over last ${stats.recentSampleSize} txs`
      : "(no included txs yet)";
  return `## Current strategy prompt body
${body}

## Evidence (${stats.cycles} decision cycles so far)
- Portfolio value: ${value}
- Recent revert rate: ${revert}
- Recent decisions (most recent last):
${recentText}

Rewrite the strategy prompt body now. Output only the new body.`;
}

// user message: 最新 observation + 直近の自分の行動と結果。
export function buildUserMessage(
  obs: AgentObservation,
  recent: RecentAction[],
): string {
  const recentText =
    recent.length === 0
      ? "(none yet)"
      : recent
          .map(
            (r) =>
              `- round=${r.round ?? "?"} action=${safeStringify(r.action ?? null)}${r.note ? ` note=${r.note}` : ""}`,
          )
          .join("\n");
  return `## Latest observation (round ${obs.round})
${safeStringify(obs)}

## Your recent actions (most recent last)
${recentText}

Respond with exactly one JSON action.`;
}
