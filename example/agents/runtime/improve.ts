// Self-improving agent: the LLM rewrites the strategy, it does not make the trades (ADR 0018).
//
// The trading loop stays where it was -- `decide(obs, ctx)` on every block, at rule-agent speed.
// Out of band, an LLM is periodically handed the current executor source plus how it has been doing,
// and may return a replacement. That is the whole difference from the retired prompt mode, where the
// LLM was in the trade path and a decision cost one round trip: measured at 8-28 blocks per decision
// and 1/64 the actions of the same strategy in rule mode (ADR 0017 §5 B1).
//
// Three guards, all of them there because the deleted `src/llm` two-layer machinery lacked or
// under-used them (it lost to frozen strategies on multi-seed validation and its rollback never
// fired in 18 runs):
//
//   1. Generated code passes the cheatcode static check before it is installed. An LLM-authored
//      strategy is not trusted code.
//   2. A revision that fails to compile, or throws on its first call, is not installed at all.
//   3. A revision that performs worse than what it replaced is rolled back, and every accept,
//      reject and rollback is written to the agent log so "did self-improvement do anything" is
//      answerable from a single run rather than from a study.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, Script } from "node:vm";
import { parse as parseYaml } from "yaml";
import { findCheatcodeUsage } from "@eris/sdk/strategyStaticCheck.js";
import type { AgentContext } from "@eris/sdk/agent.js";
import type { AgentAction, AgentObservation } from "@eris/sdk/types.js";

// How often the LLM is offered a chance to revise, in blocks, when improve.md does not say.
export const DEFAULT_REVISE_EVERY_BLOCKS = 60;
// Wall-clock bound on one call into a generated strategy. Blocks are 2 s in production, so a
// strategy that has not answered in this long has already missed its block.
export const EXECUTOR_TIMEOUT_MS = 2000;
// Ceiling the operator puts on the participant's declaration. A co-located run shares one LLM
// budget, so "revise every block" from one participant would starve the field; a declaration below
// this is honored as-is, above it is clamped and the clamp is recorded.
export const MAX_REVISIONS_PER_RUN = 12;

export type ImproveAgent = {
  name: string;
  description: string;
  // Blocks between revision opportunities. The participant's lever over cadence -- declarative, so
  // it costs no LLM call to evaluate (ADR 0018 §4).
  reviseEveryBlocks: number;
  model?: string;
  body: string;
};

// What the LLM returns. `executorTs` is the body of a decide function; `null` means "leave the
// strategy alone", which is how a prompt expresses "do not touch a winning strategy".
export type StrategyRevision = {
  version: number;
  notes: string;
  executorTs: string | null;
};

export type RevisionOutcome =
  | { kind: "installed"; version: number; notes: string }
  | { kind: "declined"; notes: string }
  | { kind: "rejected"; reason: string }
  | { kind: "rolled-back"; version: number; before: number; after: number };

// improve.md: the improvement prompt. Not a renamed prompt.md -- prompt.md said "given this
// observation, what do you do", improve.md says "when, on what evidence, and how should the strategy
// change" (ADR 0018 §1).
export function loadImproveAgent(agentDir: string): ImproveAgent {
  const path = join(agentDir, "improve.md");
  if (!existsSync(path)) throw new Error(`improve.md not found in ${agentDir}`);
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m)
    throw new Error(
      `${path}: frontmatter (---) is required (name / description mandatory)`,
    );
  const fm = parseYaml(m[1]) as Record<string, unknown> | null;
  if (!fm || typeof fm !== "object")
    throw new Error(`${path}: frontmatter must be a YAML mapping`);
  if (typeof fm.name !== "string" || fm.name.trim() === "")
    throw new Error(`${path}: frontmatter "name" is required`);
  if (typeof fm.description !== "string" || fm.description.trim() === "")
    throw new Error(`${path}: frontmatter "description" is required`);

  const declared =
    fm.reviseEveryBlocks === undefined
      ? DEFAULT_REVISE_EVERY_BLOCKS
      : Number(fm.reviseEveryBlocks);
  if (!(Number.isFinite(declared) && declared > 0))
    throw new Error(`${path}: reviseEveryBlocks must be a positive number`);

  return {
    name: fm.name,
    description: fm.description,
    reviseEveryBlocks: Math.floor(declared),
    model: typeof fm.model === "string" ? fm.model : undefined,
    body: m[2].trim(),
  };
}

// The participant's declared cadence, clamped so one agent cannot consume the shared LLM budget.
// Returns the effective interval and whether it was clamped, so the caller can record the clamp
// rather than silently overriding what the participant asked for.
export function effectiveReviseInterval(
  declaredBlocks: number,
  runBlocks: number,
  maxRevisions = MAX_REVISIONS_PER_RUN,
): { blocks: number; clamped: boolean } {
  // runBlocks 0 means "run until the time limit", so there is no total to divide up; honor the
  // declaration and let the per-run counter do the capping.
  if (runBlocks <= 0) return { blocks: declaredBlocks, clamped: false };
  const floor = Math.ceil(runBlocks / maxRevisions);
  return declaredBlocks >= floor
    ? { blocks: declaredBlocks, clamped: false }
    : { blocks: floor, clamped: true };
}

export type ParseResult =
  { ok: true; revision: StrategyRevision } | { ok: false; reason: string };

// Parse the LLM's reply. Deliberately strict: a malformed revision is rejected rather than coerced,
// because the alternative is installing something the model did not mean.
export function parseRevision(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, reason: "response must be a JSON object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.notes !== "string" || o.notes.trim() === "")
    return { ok: false, reason: "notes must be a non-empty string" };
  // Both an explicit null and an omitted field mean "no change" -- models express it either way.
  const executor =
    o.executorTs === null || o.executorTs === undefined ? null : o.executorTs;
  if (executor !== null && typeof executor !== "string")
    return { ok: false, reason: "executorTs must be a string or null" };
  if (executor !== null && executor.trim() === "")
    return {
      ok: false,
      reason: "executorTs was empty; use null to keep the current strategy",
    };
  const version = Number(o.version);
  return {
    ok: true,
    revision: {
      version: Number.isFinite(version) ? version : 0,
      notes: o.notes,
      executorTs: executor,
    },
  };
}

// A compiled executor: the same shape as a rule agent's decide, so the trading loop does not care
// which one it is holding.
export type Executor = (
  obs: AgentObservation,
  ctx: AgentContext,
) => Promise<AgentAction | null | undefined> | AgentAction | null | undefined;

export type CompileResult =
  { ok: true; executor: Executor } | { ok: false; reason: string };

// Compile generated source into a callable inside a vm context.
//
// Be clear about what this does and does not contain. The vm removes *ambient* capability: there is
// no require, no process, no fs, no fetch in scope. It does not sandbox the agent from the chain,
// because `ctx` is passed in and carries publicClient / walletClient -- generated code can trade
// exactly as freely as the hand-written strategy it replaces. That is intentional (it is the same
// capability, not an escalation), but it means the vm is a guard against a model reaching for
// something outside the trading interface, not a containment boundary. The cheatcode check below is
// the part that addresses intent, and it is what stops generated code from calling the privileged
// RPCs that a participant's own code is also forbidden from calling.
export function compileExecutor(source: string): CompileResult {
  const findings = findCheatcodeUsage(source);
  if (findings.length > 0)
    return {
      ok: false,
      reason:
        `generated code uses privileged calls: ` +
        findings
          .map((f) => `${f.rule} "${f.match}" (line ${f.line})`)
          .join("; "),
    };

  try {
    // The source is the *body* of decide(obs, ctx). Wrapping it here rather than asking the model to
    // emit a complete module keeps the contract small and means there is no import syntax to parse.
    const wrapped = `(async function decide(obs, ctx) {\n${source}\n})`;
    const script = new Script(wrapped, { filename: "generated-executor.js" });
    // Only what a strategy legitimately needs. No require, no process, no fs.
    const sandbox = createContext({
      Math,
      JSON,
      Number,
      String,
      Boolean,
      Array,
      Object,
      BigInt,
      Map,
      Set,
      isFinite,
      isNaN,
      parseFloat,
      parseInt,
    });
    const fn = script.runInContext(sandbox, { timeout: 1000 }) as Executor;
    if (typeof fn !== "function")
      return { ok: false, reason: "compiled value is not a function" };

    // Bring the action back into this realm before anyone downstream touches it. An object built
    // inside the vm has that context's Object.prototype, so it is not `instanceof Object` here and
    // deep-equality against a host object fails -- exactly the kind of difference that shows up far
    // from its cause, in validation or logging, rather than at the boundary. Actions are plain data
    // by contract, so a structural clone loses nothing; anything unclonable was not a valid action.
    //
    // The Script timeout above covers only *evaluating* the function expression, not calling it, so
    // a generated body that loops or awaits forever would wedge the agent permanently: the caller's
    // `deciding` guard blocks every later decision and the process never exits. Racing the call
    // bounds that. It does not kill the runaway work -- vm cannot interrupt an async body -- but it
    // frees the loop, and the throw is recorded as a decide error.
    const normalized: Executor = async (obs, ctx) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        Promise.resolve(fn(obs, ctx)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `executor exceeded ${EXECUTOR_TIMEOUT_MS}ms; the strategy is not returning`,
                ),
              ),
            EXECUTOR_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (result === null || result === undefined) return null;
      try {
        return structuredClone(result);
      } catch (error) {
        throw new Error(
          `executor returned a value that is not plain data: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };
    return { ok: true, executor: normalized };
  } catch (error) {
    return {
      ok: false,
      reason: `compile failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// The system prompt for a revision. The participant's improve.md is the policy; this frames what the
// model is being asked to produce and what it is allowed to see.
export function buildRevisionSystem(
  agent: ImproveAgent,
  currentExecutor: string,
): string {
  return [
    `You maintain the trading strategy of an autonomous agent in a DeFi simulation.`,
    ``,
    `You are NOT trading. The strategy below runs on every block by itself. Your job is to decide`,
    `whether to rewrite it, and if so, to return a better version.`,
    ``,
    `## The operator's instructions (written by the agent's author)`,
    ``,
    agent.body,
    ``,
    `## Current strategy`,
    ``,
    `It is the body of \`async function decide(obs, ctx)\`. It returns one action object, or null to`,
    `do nothing this block. \`ctx.log({ reason })\` records why.`,
    ``,
    "```js",
    currentExecutor,
    "```",
    ``,
    `## What to return`,
    ``,
    `Exactly one JSON object, no prose around it:`,
    ``,
    "```json",
    `{ "version": <n>, "notes": "why you did or did not change it", "executorTs": "<new body>" | null }`,
    "```",
    ``,
    `Return \`"executorTs": null\` to keep the current strategy. Doing that is often right: a strategy`,
    `that is working does not need to be touched, and a rewrite that performs worse than what it`,
    `replaced will be rolled back automatically.`,
    ``,
    `The body may use only: obs, ctx, and the standard JavaScript built-ins. There is no require,`,
    `no import, no process, no network. Privileged RPC calls (anvil_*, evm_*, hardhat_*) are`,
    `rejected before installation.`,
  ].join("\n");
}

// The performance context handed to the model alongside the prompt. Deliberately small: the recent
// decisions and how value has moved, not the whole history, so the model reasons about the current
// regime rather than pattern-matching the run.
export function buildRevisionContext(opts: {
  block: number;
  valueUsdc: number;
  initialValueUsdc: number;
  sinceLastRevisionUsdc: number | null;
  currentVersion: number;
  recent: Array<{ round: number; reason?: string; action?: unknown }>;
  observation: AgentObservation | null;
}): string {
  const pnl = opts.valueUsdc - opts.initialValueUsdc;
  const lines = [
    `block: ${opts.block}`,
    `strategy version: ${opts.currentVersion}`,
    `PnL since the run started: ${pnl.toFixed(2)} USDC`,
  ];
  if (opts.sinceLastRevisionUsdc !== null)
    lines.push(
      `PnL since the last revision: ${opts.sinceLastRevisionUsdc.toFixed(2)} USDC`,
    );
  lines.push(
    ``,
    `recent decisions (newest last):`,
    ...opts.recent
      .slice(-12)
      .map(
        (r) =>
          `  block ${r.round}: ${r.action ? JSON.stringify(r.action) : "no action"}` +
          (r.reason ? ` — ${r.reason}` : ""),
      ),
  );
  if (opts.observation)
    lines.push(``, `latest observation:`, JSON.stringify(opts.observation));
  return lines.join("\n");
}
