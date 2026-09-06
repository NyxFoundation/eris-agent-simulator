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
//   3. Every accept, decline, rejection and revert is written to the agent log, so "did
//      self-improvement do anything" is answerable from a single run rather than from a study.
//      Note what this is *not*: nothing rolls back on its own. An automatic "revert when value went
//      down" needs a threshold and there is no defensible one (ADR 0018 §5) -- the previous
//      implementation's never fired in 18 runs. Reverting is the model's call, via `revertTo`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, Script } from "node:vm";
import { parse as parseYaml } from "yaml";
import { DECIDE_TIMEOUT_MS } from "./decideTimeout.js";
import { findCheatcodeUsage } from "@eris/sdk/strategyStaticCheck.js";
import {
  digestMarketHistory,
  digestTrades,
  type MarketSample,
  type TradeAggregate,
} from "./evidence.js";
import { clampMemory } from "./state.js";
import { ACTION_TYPES_BY_PROTOCOL } from "@eris/sdk/action.js";
import type { AgentContext } from "@eris/sdk/agent.js";
import type {
  AgentAction,
  AgentObservation,
  ProtocolId,
} from "@eris/sdk/types.js";

// How often the LLM is offered a chance to revise, in blocks, when prompt.md does not say.
export const DEFAULT_REVISE_EVERY_BLOCKS = 60;
// The bound on one call into a generated strategy is the rules' per-decision bound (§2.3), owned
// by decideTimeout.ts. bot.ts applies it to every decide(); it is applied here as well so a compiled
// executor is bounded wherever it is called from, not only from the block loop.
// There is no per-run ceiling on revisions. One existed (12 per run, clamping the declared cadence
// up to runBlocks/12) while every agent in a co-located run drew on one shared LLM budget.
// Participants now bring their own inference credentials (rules §2.5), so the cadence
// (`reviseEveryBlocks` in prompt.md, rules appendix A) is theirs to set and theirs to pay for.

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
  // Issue #77: a note the model writes to its next self, carried across the epoch boundary next to
  // the versions. Cheap, and it gives the model somewhere to put "what I concluded last epoch" that
  // is not code -- a conclusion that has to be re-derived from the source every epoch mostly is not.
  memory: string | null;
};

// One installed strategy and what happened after it. Handed to the model so a revert is an informed
// choice rather than a guess, and kept in the log so a run can be read back.
export type StrategyVersion = {
  version: number;
  source: string;
  notes: string;
  installedAtBlock: number;
  valueAtInstall: number | null;
  // The epoch this version was installed in (issue #77). Absent means this run, which is what every
  // version looked like before agent state survived an epoch. With it, "this version has now lost
  // two epochs in a row" is visible rather than inferred.
  epochId?: string;
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
  // Optional, and a non-string is dropped rather than refused: a model that puts an object here
  // has still given a usable revision, and rejecting the whole reply over a note would throw away
  // the strategy with it.
  // Bounded here rather than at persist time: an unbounded note is fed straight back into the next
  // revision context, so the model would inflate its own context for the rest of the epoch and only
  // meet the limit after a restart.
  const memory =
    typeof o.memory === "string" && o.memory.trim() !== ""
      ? clampMemory(o.memory)
      : null;
  const version = Number(o.version);
  return {
    ok: true,
    revision: {
      version: Number.isFinite(version) ? version : 0,
      notes: o.notes,
      executorTs: executor,
      revertTo: revertRaw,
      memory,
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
                  `executor exceeded ${DECIDE_TIMEOUT_MS}ms; the strategy is not returning`,
                ),
              ),
            DECIDE_TIMEOUT_MS,
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
  // The venues this run actually has, taken from the latest observation. Listing the vocabulary
  // matters most for the strategies that need an action they have never emitted: a shipped
  // `lp-provider` only ever mints and collects, so without this the model's only evidence about
  // what a swap is called is a strategy that never swaps -- and an invented name is rejected before
  // it is installed. Measured: under USDC-only funding it sat out 18 of 18 scenarios for want of one
  // (docs/scoring-metric-measurements.md §5.8 (f)).
  enabledProtocols: readonly ProtocolId[] = [],
): string {
  const vocabulary = enabledProtocols
    .filter((id) => ACTION_TYPES_BY_PROTOCOL[id]?.length)
    .map((id) => `  ${id}: ${ACTION_TYPES_BY_PROTOCOL[id].join(", ")}`);
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
    `Any of the three may also carry \`"memory": "..."\` — a short note to your next self. It is`,
    `kept next to the version history and handed back to you at the next revision, including in a`,
    `later epoch, so it is where a conclusion goes that is not worth re-deriving from the source.`,
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
    ...(vocabulary.length > 0
      ? [
          ``,
          `## Actions available in this run`,
          ``,
          `The strategy above may use only some of these. An action type not listed here does not`,
          `exist and is rejected before it reaches the chain.`,
          ``,
          ...vocabulary,
          ``,
          `Plus \`bundle\` (several of the above in one transaction) and \`noop\`. Sizes and limits`,
          `are in \`obs.limits\`; what you hold is in \`obs.balances\`. **Holding none of an asset is`,
          `not a reason to do nothing** — buying it is an action, with a cost, and whether that cost`,
          `is worth paying is a judgement the strategy is allowed to make.`,
        ]
      : []),
  ].join("\n");
}

// How many recent decisions the context carries. Twelve was the number when a decision was an
// action and a reason and nothing else; with an outcome attached to each one there is more to read
// per line, and the three faults behind "the arbitrage does not win" only separate over a run of
// them.
export const RECENT_DECISIONS_SHOWN = 24;

// The performance context handed to the model alongside the prompt.
//
// Before issue #76 this was a snapshot: two PnL numbers, twelve bare decisions and the latest
// observation. A model asked "why did you lose money during the depeg" could see that it had lost
// money and that DAI is 0.99 *now* -- not when the window opened, not what it bought at, not
// whether its transactions were even getting into blocks. Every bundled prompt answered "leave it
// alone", which was the right answer to the evidence it had.
//
// So the context now carries the interval as well as the instant: what the market did since the
// last revision (a digest, not the rows), what the agent's own transactions did (aggregates), and
// each decision annotated with the fate of the transaction it produced. It is still deliberately
// small -- context size is the participant's inference cost (rules §2.5) -- and it is still the
// same clause of the rules: "the trading records so far, and the PnL".
export function buildRevisionContext(opts: {
  block: number;
  valueUsdc: number;
  initialValueUsdc: number;
  sinceLastRevisionUsdc: number | null;
  currentVersion: number;
  history: StrategyVersion[];
  recent: Array<{ round: number; reason?: string; action?: unknown }>;
  observation: AgentObservation | null;
  // The block the last revision happened on, so the interval can be named rather than implied.
  sinceBlock?: number | null;
  // One sample per observed block of the interval (issue #76). Digested here rather than by the
  // caller so there is one place that decides what the model is shown.
  market?: MarketSample[];
  trades?: TradeAggregate | null;
  // Decision block -> what the transactions decided on that block did. The join that turns "swap"
  // into "swap, included two blocks late at index 7, value -3.20 after 3b".
  outcomes?: Map<number, string[]> | null;
  // Issue #77. `epochs` is every epoch this agent has run, oldest first, when its state survives
  // between them; `memory` is the note it left itself last time.
  epochs?: string[];
  memory?: string | null;
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
  // Issue #77: the epoch count is the frame for everything below it. The PnL and the history are
  // this epoch's; the versions and the memory are not, and a model that reads them as one run will
  // attribute an epoch's loss to a version that was installed two epochs ago.
  if (opts.epochs && opts.epochs.length > 0)
    lines.push(
      `epochs this agent has run: ${opts.epochs.length} (this one is ${
        opts.epochs[opts.epochs.length - 1]
      }). The PnL above is this epoch only; the strategy history below spans all of them.`,
    );
  if (opts.memory)
    lines.push(``, `your note from the last revision:`, opts.memory);
  // The history is what makes `revertTo` an informed choice rather than a guess: each version's
  // stated intent, and the value the agent was carrying when it went in.
  if (opts.history.length > 0) {
    // Epoch ids are run ids -- timestamps. Printing one next to a version tells the model when, not
    // how long ago, and "this version has now lost two epochs in a row" is a count. So the ordinal
    // is what is shown, with the id after it for anyone reading the log alongside.
    const ordinalOf = (epochId: string | undefined): string => {
      if (!epochId) return "";
      const at = opts.epochs?.indexOf(epochId) ?? -1;
      return at >= 0
        ? ` in epoch ${at + 1} of ${opts.epochs!.length} (${epochId})`
        : ` in epoch ${epochId}`;
    };
    lines.push(``, `strategy history (version 0 is the one you were shipped):`);
    for (const v of opts.history) {
      const value =
        v.valueAtInstall === null
          ? "unknown"
          : `${(v.valueAtInstall - opts.initialValueUsdc).toFixed(2)} USDC vs the run start`;
      lines.push(
        `  v${v.version} @ block ${v.installedAtBlock}${ordinalOf(v.epochId)}` +
          ` (value then: ${value}) — ${v.notes}`,
      );
    }
  }

  // ---- since the last revision (issue #76) ----
  const interval =
    opts.sinceBlock === undefined || opts.sinceBlock === null
      ? `since the run started`
      : `since the last revision at block ${opts.sinceBlock}`;
  if (opts.trades) lines.push(``, ...digestTrades(opts.trades));
  const market = digestMarketHistory(opts.market ?? []);
  if (market.length > 0) lines.push(``, ...market);
  if (opts.trades || market.length > 0)
    lines.push(
      `(the two sections above cover ${interval}. A gap that never opened is not a threshold ` +
        `problem; a gap that opened and was not traded is.)`,
    );

  lines.push(``, `recent decisions (newest last):`);
  for (const r of opts.recent.slice(-RECENT_DECISIONS_SHOWN)) {
    const outcome = opts.outcomes?.get(r.round);
    lines.push(
      `  block ${r.round}: ${r.action ? JSON.stringify(r.action) : "no action"}` +
        (r.reason ? ` — ${r.reason}` : "") +
        (outcome && outcome.length > 0 ? ` [${outcome.join("; ")}]` : ""),
    );
  }
  if (opts.observation)
    lines.push(``, `latest observation:`, JSON.stringify(opts.observation));
  return lines.join("\n");
}
