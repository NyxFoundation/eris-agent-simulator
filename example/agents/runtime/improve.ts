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

// How often the LLM is offered a chance to revise, in blocks, when prompt.md does not say.
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

// What the LLM returns. Three answers, all legitimate:
//   executorTs: "<body>"  install this as the new strategy
//   executorTs: null      leave the strategy alone (how a prompt says "do not touch a winner")
//   revertTo: <version>   go back to an earlier version
//
// Reverting is the model's call rather than the harness's. An automatic "roll back when value went
// down" needs a threshold, and there is no defensible one: the previous implementation's never
// fired in 18 runs, and the obvious opposite (any loss at all) reverts every revision in a regime
// where everyone is losing. The model already sees the PnL since each revision and the notes it
// wrote at the time, so the judgment belongs there -- and prompt.md is where a participant states
// how to make it. Timing is unchanged either way: both fire at a revision opportunity.
export type StrategyRevision = {
  version: number;
  notes: string;
  executorTs: string | null;
  revertTo: number | null;
};

// One installed strategy and what happened after it. Handed to the model so a revert is an informed
// choice rather than a guess, and kept in the log so a run can be read back.
export type StrategyVersion = {
  version: number;
  source: string;
  notes: string;
  installedAtBlock: number;
  valueAtInstall: number | null;
};

export type RevisionOutcome =
  | { kind: "installed"; version: number; notes: string }
  | { kind: "declined"; notes: string }
  | { kind: "rejected"; reason: string }
  | { kind: "reverted"; to: number; from: number; notes: string };

// prompt.md: the improvement policy (ADR 0018 §1, renamed from improve.md in ADR 0018 Amendment 1).
//
// The file name is reused from the retired per-decision prompt, and the two mean opposite things:
// the old one said "given this observation, what do you do", this one says "when, on what evidence,
// and how should the strategy change". Nineteen files of the old kind were deleted in f42fd2a and
// still exist in git history and in every bundle taken before it, so the name alone cannot say which
// contract a file is written against -- and both formats carry the same `name` / `description`
// frontmatter, so that cannot either.
//
// Hence IMPROVE_KIND: the file declares its own contract. Without it, an old prompt.md would be
// loaded as an improvement policy and the model would be handed trading instructions as its brief,
// with nothing anywhere saying so. A missing marker is refused rather than guessed at.
export const IMPROVE_KIND = "improve";

// What a directory says about the improvement loop, before anything is parsed.
//   present  prompt.md is there and the loop applies
//   renamed  only the pre-Amendment-1 improve.md is there -- the participant meant to opt in
//   absent   neither, so the strategy runs unrevised, which is a legitimate agent
export type ImprovePolicyState = "present" | "renamed" | "absent";

/// Distinguish "no improvement policy" from "a policy under the old file name".
///
/// Without the middle case a renamed-away improve.md is simply ignored: the strategy trades, no LLM
/// ever touches it, and nothing in the run says so. Silence is the worst of the three outcomes, so
/// the caller is given enough to refuse.
export function improvePolicyState(agentDir: string): ImprovePolicyState {
  if (existsSync(join(agentDir, "prompt.md"))) return "present";
  if (existsSync(join(agentDir, "improve.md"))) return "renamed";
  return "absent";
}

export function loadImproveAgent(agentDir: string): ImproveAgent {
  const path = join(agentDir, "prompt.md");
  if (!existsSync(path)) throw new Error(`prompt.md not found in ${agentDir}`);
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m)
    throw new Error(
      `${path}: frontmatter (---) is required (kind / name / description mandatory)`,
    );
  const fm = parseYaml(m[1]) as Record<string, unknown> | null;
  if (!fm || typeof fm !== "object")
    throw new Error(`${path}: frontmatter must be a YAML mapping`);
  if (fm.kind !== IMPROVE_KIND)
    throw new Error(
      `${path}: frontmatter "kind: ${IMPROVE_KIND}" is required. A prompt.md without it is the ` +
        "retired per-decision prompt (ADR 0018 removed prompt mode, deleting 19 of them in f42fd2a); " +
        "loading one as an improvement policy would hand the model trading instructions as its brief. " +
        "If this file really is an improvement policy, add the marker — see example/agents/venue-arb/prompt.md",
    );
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
  const revertRaw =
    o.revertTo === null || o.revertTo === undefined ? null : Number(o.revertTo);
  if (revertRaw !== null && !Number.isInteger(revertRaw))
    return { ok: false, reason: "revertTo must be an integer version or null" };
  // Asking for both is ambiguous, and guessing which one was meant is how a model's intent gets
  // silently overridden.
  if (executor !== null && revertRaw !== null)
    return {
      ok: false,
      reason: "give either executorTs or revertTo, not both",
    };
  const version = Number(o.version);
  return {
    ok: true,
    revision: {
      version: Number.isFinite(version) ? version : 0,
      notes: o.notes,
      executorTs: executor,
      revertTo: revertRaw,
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

// The system prompt for a revision. The participant's prompt.md is the policy; this frames what the
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
    `Exactly one JSON object, no prose around it. Three answers are available:`,
    ``,
    "```json",
    `{ "notes": "why", "executorTs": "<new body>" }   // install this as the strategy`,
    `{ "notes": "why", "executorTs": null }           // leave it alone`,
    `{ "notes": "why", "revertTo": 1 }                // go back to an earlier version`,
    "```",
    ``,
    `Leaving it alone is often right: a strategy that is working does not need to be touched, and a`,
    `rewrite that turns out worse costs you a revision to undo.`,
    ``,
    `**Nothing reverts automatically.** If a change you made has hurt, you have to say so — use`,
    `\`revertTo\` with the version you want back. The history below records what each version did.`,
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
  history: StrategyVersion[];
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
  // The history is what makes `revertTo` an informed choice rather than a guess: each version's
  // stated intent, and the value the agent was carrying when it went in.
  if (opts.history.length > 0) {
    lines.push(``, `strategy history (version 0 is the one you were shipped):`);
    for (const v of opts.history) {
      const value =
        v.valueAtInstall === null
          ? "unknown"
          : `${(v.valueAtInstall - opts.initialValueUsdc).toFixed(2)} USDC vs the run start`;
      lines.push(
        `  v${v.version} @ block ${v.installedAtBlock} (value then: ${value}) — ${v.notes}`,
      );
    }
  }
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
