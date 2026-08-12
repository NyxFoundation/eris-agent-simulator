// Self-improving agent runtime (ADR 0018).
//
// The guards here exist because the deleted src/llm two-layer machinery lacked or under-used them:
// it lost to frozen strategies on multi-seed validation and its rollback never fired in 18 runs.
// So the tests concentrate on the three things that must not fail open -- generated code that
// cheats, generated code that does not compile, and a cadence a participant can declare freely.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRevisionContext,
  buildRevisionSystem,
  compileExecutor,
  DEFAULT_REVISE_EVERY_BLOCKS,
  effectiveReviseInterval,
  improvePolicyState,
  loadImproveAgent,
  EXECUTOR_TIMEOUT_MS,
  MAX_REVISIONS_PER_RUN,
  parseRevision,
} from "../example/agents/runtime/improve.js";

function agentDir(promptMd: string): string {
  const dir = mkdtempSync(join(tmpdir(), "eris-improve-"));
  writeFileSync(join(dir, "prompt.md"), promptMd);
  return dir;
}

const FRONTMATTER = `---
kind: improve
name: test-agent
description: an agent used by the tests
---

Only rewrite the strategy when it is losing money.`;

test("loadImproveAgent: reads frontmatter and defaults the cadence", () => {
  const agent = loadImproveAgent(agentDir(FRONTMATTER));
  assert.equal(agent.name, "test-agent");
  assert.equal(agent.reviseEveryBlocks, DEFAULT_REVISE_EVERY_BLOCKS);
  assert.match(agent.body, /Only rewrite the strategy/);
});

test("loadImproveAgent: the participant can declare the cadence", () => {
  const agent = loadImproveAgent(
    agentDir(FRONTMATTER.replace("---\n\n", "reviseEveryBlocks: 30\n---\n\n")),
  );
  assert.equal(agent.reviseEveryBlocks, 30);
});

// The file name is reused from the retired per-decision prompt (ADR 0018 Amendment 1), and both
// formats carry the same name/description frontmatter -- so the marker is the only thing that can
// tell them apart. Getting this wrong means handing the reviser trading instructions as its brief.
test("loadImproveAgent: a prompt.md without the marker is refused, not reinterpreted", () => {
  const legacy = `---
name: arb-bot
description: Gap-driven swaps with profit-proportional priority-fee bidding
---

# Mission

You are a gap-driven arbitrage bot. Swap when the gap exceeds 5bps.`;
  assert.throws(() => loadImproveAgent(agentDir(legacy)), /kind: improve/);
  // And the message has to say what the file is, or nobody can act on it.
  assert.throws(() => loadImproveAgent(agentDir(legacy)), /prompt mode/i);
});

test("improvePolicyState: the old file name is a refusal, not silence", () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-improve-"));
  assert.equal(improvePolicyState(dir), "absent");
  writeFileSync(join(dir, "improve.md"), FRONTMATTER);
  // A directory that still uses the old name meant to opt in. Reading it as "absent" would run the
  // strategy unrevised with nothing anywhere saying the LLM was never involved.
  assert.equal(improvePolicyState(dir), "renamed");
  writeFileSync(join(dir, "prompt.md"), FRONTMATTER);
  assert.equal(improvePolicyState(dir), "present");
});

test("loadImproveAgent: a missing name or bad cadence is an explicit error", () => {
  assert.throws(
    () =>
      loadImproveAgent(agentDir("---\nkind: improve\ndescription: x\n---\nbody")),
    /"name" is required/,
  );
  assert.throws(
    () =>
      loadImproveAgent(
        agentDir(
          FRONTMATTER.replace("---\n\n", "reviseEveryBlocks: 0\n---\n\n"),
        ),
      ),
    /must be a positive number/,
  );
});

test("the declared cadence is honored until it would exceed the operator's cap", () => {
  // A co-located run shares one LLM budget, so one participant declaring "every block" must not be
  // able to starve the field -- but a reasonable declaration has to pass through untouched, or the
  // knob is decorative.
  assert.deepEqual(effectiveReviseInterval(60, 360), {
    blocks: 60,
    clamped: false,
  });
  const greedy = effectiveReviseInterval(1, 360);
  assert.ok(greedy.clamped);
  assert.equal(greedy.blocks, Math.ceil(360 / MAX_REVISIONS_PER_RUN));
  // A run with no block target has no total to divide up; the per-run counter caps it instead.
  assert.deepEqual(effectiveReviseInterval(1, 0), {
    blocks: 1,
    clamped: false,
  });
});

test("parseRevision: null or omitted executorTs means 'keep the current strategy'", () => {
  // Not an error case: declining to touch a working strategy is the behavior ADR 0018 wants, and
  // models express it both ways.
  for (const raw of [
    { version: 2, notes: "still working", executorTs: null },
    { version: 2, notes: "still working" },
  ]) {
    const r = parseRevision(raw);
    assert.ok(r.ok);
    assert.equal(r.revision.executorTs, null);
    assert.equal(r.revision.revertTo, null);
  }
});

test("parseRevision: revertTo is how the model undoes its own change", () => {
  // Reverting is the model's judgment, not an automatic threshold: an automatic rule needs a number
  // and there is no defensible one (the previous implementation's never fired; the obvious opposite
  // reverts every revision in a losing regime).
  const r = parseRevision({ notes: "v1 made it worse", revertTo: 0 });
  assert.ok(r.ok);
  assert.equal(r.revision.revertTo, 0);
  assert.equal(r.revision.executorTs, null);
});

test("parseRevision: asking for both a rewrite and a revert is ambiguous", () => {
  // Guessing which one was meant is how a model's intent gets silently overridden.
  const r = parseRevision({
    notes: "x",
    executorTs: "return null;",
    revertTo: 1,
  });
  assert.ok(!r.ok);
  assert.match(r.reason, /not both/);
});

test("parseRevision: a non-integer revertTo is rejected", () => {
  const r = parseRevision({ notes: "x", revertTo: "the good one" });
  assert.ok(!r.ok);
  assert.match(r.reason, /integer version/);
});

test("parseRevision: malformed responses are rejected, not coerced", () => {
  const bad: Array<[unknown, RegExp]> = [
    ["not an object", /JSON object/],
    [{ executorTs: "return null;" }, /notes/],
    [{ notes: "x", executorTs: 42 }, /executorTs must be/],
    [{ notes: "x", executorTs: "   " }, /use null to keep/],
  ];
  for (const [raw, pattern] of bad) {
    const r = parseRevision(raw);
    assert.ok(!r.ok, `expected rejection for ${JSON.stringify(raw)}`);
    assert.match(r.reason, pattern);
  }
});

test("compileExecutor: the action comes back in this realm, not the sandbox's", async () => {
  // An object built inside the vm carries that context's Object.prototype, so it is not
  // `instanceof Object` here and deep-equality against a host object fails. Left alone that shows up
  // far from its cause -- in validation or logging -- so the boundary normalizes it.
  const r = compileExecutor(`return { type: "swap", nested: { a: [1, 2] } };`);
  assert.ok(r.ok);
  const action = (await r.executor({ round: 1 } as never, {} as never)) as object;
  assert.ok(action instanceof Object, "action is not a host-realm object");
  assert.deepEqual(action, { type: "swap", nested: { a: [1, 2] } });
});

test("compileExecutor: a valid body becomes a callable decide", async () => {
  const r = compileExecutor(
    `if (obs.round % 2 === 0) return null;
     return { type: "swap", tokenIn: "USDC", amountIn: "1" };`,
  );
  assert.ok(r.ok);
  const ctx = {} as never;
  assert.equal(await r.executor({ round: 2 } as never, ctx), null);
  assert.deepEqual(await r.executor({ round: 3 } as never, ctx), {
    type: "swap",
    tokenIn: "USDC",
    amountIn: "1",
  });
});

test("compileExecutor: cheatcode calls are refused before installation", () => {
  // An LLM-authored strategy is not trusted code. This is the same check the submission gate runs,
  // applied to generated code -- which is the case the gate cannot see.
  for (const source of [
    `await ctx.publicClient.request({ method: "anvil_setBalance" }); return null;`,
    `await ctx.publicClient.request({ method: "evm_mine" }); return null;`,
    `setEthBalance(ctx.publicClient, ctx.address, 1n); return null;`,
  ]) {
    const r = compileExecutor(source);
    assert.ok(!r.ok, `expected refusal for: ${source}`);
    assert.match(r.reason, /privileged calls/);
  }
});

test("compileExecutor: a syntax error is a rejection, not a crash", () => {
  const r = compileExecutor("return {{{ oops");
  assert.ok(!r.ok);
  assert.match(r.reason, /compile failed/);
});

test("compileExecutor: the sandbox has no module system, process or filesystem", () => {
  // Not a security boundary against a determined attacker -- a boundary against the model reaching
  // for something that is not the trading interface. Reaching for it should fail loudly at call
  // time rather than silently succeeding.
  for (const source of [
    `return require("node:fs").readFileSync("/etc/passwd");`,
    `return process.env.ERIS_AGENT_PRIVATE_KEY;`,
  ]) {
    const r = compileExecutor(source);
    assert.ok(r.ok, "the body compiles; the reference only fails when called");
    assert.rejects(
      async () => await r.executor({ round: 1 } as never, {} as never),
      /is not defined/,
    );
  }
});

test("buildRevisionSystem: the model is told it is not trading, and may decline", () => {
  const agent = loadImproveAgent(agentDir(FRONTMATTER));
  const system = buildRevisionSystem(agent, "return null;");
  assert.match(system, /You are NOT trading/);
  // The participant's own instructions have to reach the model, or prompt.md is decorative.
  assert.match(system, /Only rewrite the strategy when it is losing money/);
  // Declining must read as a legitimate answer, since "do not touch a winner" is the fix for the
  // failure mode the previous implementation had.
  assert.match(system, /executorTs": null|"executorTs": null/);
  assert.match(system, /does not need to be touched/);
  assert.match(system, /return null;/);
});

test("buildRevisionContext: reports PnL since the run and since the last revision", () => {
  const context = buildRevisionContext({
    block: 120,
    valueUsdc: 25_500,
    initialValueUsdc: 25_000,
    sinceLastRevisionUsdc: -80,
    currentVersion: 2,
    history: [],
    recent: [{ round: 118, reason: "no gap" }],
    observation: null,
  });
  assert.match(context, /block: 120/);
  assert.match(context, /strategy version: 2/);
  assert.match(context, /since the run started: 500\.00/);
  // Without this the model cannot tell whether its own last change helped.
  assert.match(context, /since the last revision: -80\.00/);
  assert.match(context, /block 118: no action — no gap/);
});

test("compileExecutor: a strategy that never returns is bounded, not left to wedge the agent", async () => {
  // The Script timeout covers evaluating the function expression, not calling it. Without a bound
  // on the call, a generated body that awaits forever holds the caller's `deciding` guard and the
  // agent stops deciding for the rest of the run while every log still looks healthy.
  const r = compileExecutor(`await new Promise(() => {}); return null;`);
  assert.ok(r.ok);
  const started = Date.now();
  await assert.rejects(
    async () => await r.executor({ round: 1 } as never, {} as never),
    /is not returning/,
  );
  // Bounded near the limit rather than hanging; generous upper bound so a slow machine cannot flake.
  assert.ok(
    Date.now() - started < EXECUTOR_TIMEOUT_MS * 3,
    "the call was not bounded",
  );
});

test("compileExecutor: a fast strategy is not penalised by the timeout", async () => {
  const r = compileExecutor(`return { type: "noop" };`);
  assert.ok(r.ok);
  assert.deepEqual(await r.executor({ round: 1 } as never, {} as never), {
    type: "noop",
  });
});

test("buildRevisionContext: the history is what makes a revert an informed choice", () => {
  // Without it the model can only guess which earlier version to go back to, and `revertTo` becomes
  // a coin flip rather than a judgment.
  const context = buildRevisionContext({
    block: 200,
    valueUsdc: 24_000,
    initialValueUsdc: 25_000,
    sinceLastRevisionUsdc: -900,
    currentVersion: 1,
    history: [
      {
        version: 0,
        source: "return null;",
        notes: "the strategy as submitted",
        installedAtBlock: 0,
        valueAtInstall: 25_000,
      },
      {
        version: 1,
        source: "return {};",
        notes: "widened the entry threshold",
        installedAtBlock: 140,
        valueAtInstall: 24_900,
      },
    ],
    recent: [],
    observation: null,
  });
  assert.match(context, /v0 @ block 0/);
  assert.match(context, /widened the entry threshold/);
  // Values are shown relative to the run start, which is the frame the model reasons in.
  assert.match(context, /v1 @ block 140 \(value then: -100\.00 USDC/);
});

test("buildRevisionSystem: reverting is offered, and said to be manual", () => {
  const agent = loadImproveAgent(agentDir(FRONTMATTER));
  const system = buildRevisionSystem(agent, "return null;");
  assert.match(system, /revertTo/);
  // The model must know nothing will undo a bad change for it.
  assert.match(system, /Nothing reverts automatically/);
});
