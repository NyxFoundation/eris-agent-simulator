/**
 * prompt.ts: composing a prompt-type agent (a single prompt.md) (ADR 0015 §4).
 *
 * system = JSON mode instructions + <schema>{action JSON Schema}</schema> + environment rules
 *          (fixed text) + prompt.md body
 * user   = latest observation + recent actions and results from agentLog
 *
 * The <schema> format matches the training distribution of ollama-family open models (Hermes JSON
 * mode; NousResearch/Hermes-Function-Calling). <schema> and runtime validation (validateAction) are
 * derived from sdk's single action schema (actionSchema.ts).
 *
 * frontmatter has the same shape as the Agent Skills standard (agentskills.io): name / description
 * required, intervalMs / model optional, unknown fields ignored (forward compatible).
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
// Self-improvement (prompt revision) default = off. Enable via the roster env ERIS_PROMPT_REVISE_EVERY (number of decision cycles).
export const DEFAULT_PROMPT_REVISE_EVERY = 0;

// Read prompt.md and validate its frontmatter. name/description are required (roster display / log header).
export function loadPromptAgent(agentDir: string): PromptAgent {
  const path = join(agentDir, "prompt.md");
  if (!existsSync(path)) throw new Error(`prompt.md not found in ${agentDir}`);
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) {
    throw new Error(
      `${path}: frontmatter (---) is required (name / description mandatory; agentskills.io compatible)`,
    );
  }
  const fm = parseYaml(m[1]) as Record<string, unknown> | null;
  if (!fm || typeof fm !== "object")
    throw new Error(`${path}: frontmatter must be a YAML mapping`);
  if (typeof fm.name !== "string" || fm.name.trim() === "")
    throw new Error(`${path}: frontmatter "name" is required`);
  if (typeof fm.description !== "string" || fm.description.trim() === "")
    throw new Error(`${path}: frontmatter "description" is required`);
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

// Fixed text of the environment rules. The action *format* is owned by <schema> (derived from sdk
// actionSchema), so this only states environment semantics that can only be expressed in natural
// language (how to read the observation, constraints, costs). A PR that changes the shape of
// observation / limits must update this at the same time (ADR 0015 Risks).
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

// Hermes JSON mode system prompt (<schema> + rules + prompt.md body).
// If jsonSchema is passed it is not regenerated (shares the same one bot.ts built for LLM tool use).
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

// One line of recent action history (summarized from agentLog and attached to the user message).
export type RecentAction = {
  round?: number;
  action?: unknown;
  note?: string;
};

// ---------------------------------------------------------------------------
// Self-improvement (prompt revision): every N decision cycles, attach recent actions/results and
// have the LLM rewrite the prompt body itself (the improvement target = the prompt, matching ADR
// 0015's unit of submission). The revision discipline distills the lessons of the old
// self-improvement mechanism (formerly _archive/llm/prompts.ts; removed, see git history).
// ---------------------------------------------------------------------------

export type RevisionStats = {
  cycles: number;
  initialValueUsdc: number | null;
  currentValueUsdc: number | null;
  recentRevertRate?: number;
  recentSampleSize?: number;
};

// System prompt for revision. The output is "only the markdown of the new prompt body" (no frontmatter/fences).
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

// User message for revision (current body + recent actions and results + value trajectory).
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

// user message: latest observation + your own recent actions and results.
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
