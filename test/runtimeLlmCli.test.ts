import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeCliArgs,
  buildCodexCliArgs,
  extractJsonObject,
  flattenMessages,
  resolveLlmProvider,
  runCli,
} from "../example/agents/runtime/llm.js";

// ---- provider routing (model name → provider) ----

test("resolveLlmProvider: routes model names to providers", () => {
  assert.deepEqual(resolveLlmProvider("gpt-oss:120b"), { kind: "ollama" });
  assert.deepEqual(resolveLlmProvider("claude-sonnet-5"), {
    kind: "anthropic",
  });
  assert.deepEqual(resolveLlmProvider("codex"), { kind: "codex" });
  assert.deepEqual(resolveLlmProvider("codex:gpt-5"), {
    kind: "codex",
    model: "gpt-5",
  });
  assert.deepEqual(resolveLlmProvider("claude-cli"), { kind: "claude-cli" });
  assert.deepEqual(resolveLlmProvider("claude-cli:haiku"), {
    kind: "claude-cli",
    model: "haiku",
  });
});

test("resolveLlmProvider: empty model after the prefix falls back to the CLI default", () => {
  assert.deepEqual(resolveLlmProvider("codex:"), { kind: "codex" });
  assert.deepEqual(resolveLlmProvider("claude-cli: "), { kind: "claude-cli" });
});

test("resolveLlmProvider: claude-cli wins over the anthropic claude prefix", () => {
  // "claude-cli..." also starts with "claude"; the CLI prefix must be checked first.
  const p = resolveLlmProvider("claude-cli:sonnet");
  assert.equal(p.kind, "claude-cli");
});

// ---- message flattening (stateless CLI one-shot) ----

test("flattenMessages: a single message passes through verbatim", () => {
  assert.equal(
    flattenMessages([{ role: "user", content: "observation here" }]),
    "observation here",
  );
});

test("flattenMessages: a retry conversation folds into labeled sections", () => {
  const text = flattenMessages([
    { role: "user", content: "obs" },
    { role: "assistant", content: '{"type":"broken"' },
    { role: "user", content: "fix it" },
  ]);
  assert.match(text, /\[user\]\nobs/);
  assert.match(text, /\[your previous response\]\n\{"type":"broken"/);
  assert.match(text, /\[user\]\nfix it/);
});

// ---- JSON extraction from CLI chatter ----

test("extractJsonObject: pulls the first balanced object out of surrounding prose", () => {
  const out = 'Sure! Here is the action:\n{"type":"noop","reason":"ok"}\nDone.';
  assert.deepEqual(extractJsonObject(out), { type: "noop", reason: "ok" });
});

test("extractJsonObject: respects braces and escapes inside strings", () => {
  const inner = '{"type":"swap","note":"gap {wide} \\" quote","amount":"12"}';
  assert.deepEqual(extractJsonObject(`prefix ${inner} suffix`), {
    type: "swap",
    note: 'gap {wide} " quote',
    amount: "12",
  });
});

test("extractJsonObject: returns null when there is no complete object", () => {
  assert.equal(extractJsonObject("no json here"), null);
  assert.equal(extractJsonObject('{"unterminated": true'), null);
});

// ---- CLI arg building ----

test("buildClaudeCliArgs: print mode with system append and all tools disallowed", () => {
  const args = buildClaudeCliArgs("sonnet", "SYS", "PROMPT");
  assert.equal(args[0], "-p");
  assert.equal(args[1], "PROMPT");
  assert.ok(args.includes("--model") && args.includes("sonnet"));
  assert.ok(args.includes("--append-system-prompt") && args.includes("SYS"));
  assert.ok(args.includes("--disallowed-tools"));
  assert.ok(args.includes("Bash")); // tool-use hang guard: built-ins are disallowed
});

test("buildClaudeCliArgs: omits --model when unspecified (CLI default)", () => {
  const args = buildClaudeCliArgs(undefined, "SYS", "PROMPT");
  assert.ok(!args.includes("--model"));
});

test("buildCodexCliArgs: exec in a read-only sandbox; model optional", () => {
  const withModel = buildCodexCliArgs("gpt-5", "PROMPT");
  assert.deepEqual(withModel.slice(0, 2), ["exec", "PROMPT"]);
  assert.ok(withModel.includes("--sandbox") && withModel.includes("read-only"));
  assert.ok(withModel.includes("--model") && withModel.includes("gpt-5"));
  assert.ok(!buildCodexCliArgs(undefined, "PROMPT").includes("--model"));
});

// ---- runCli process handling (real subprocesses via `node -e`) ----

test("runCli: resolves stdout on success", async () => {
  const out = await runCli(
    process.execPath,
    ["-e", 'process.stdout.write(\'{"type":"noop"}\')'],
    { ...process.env },
    10_000,
  );
  assert.equal(out, '{"type":"noop"}');
});

test("runCli: rejects on non-zero exit with the stderr snippet", async () => {
  await assert.rejects(
    runCli(
      process.execPath,
      ["-e", 'process.stderr.write("boom"); process.exit(3)'],
      { ...process.env },
      10_000,
    ),
    /exited 3: boom/,
  );
});

test("runCli: rejects when the binary does not exist", async () => {
  await assert.rejects(
    runCli("definitely-not-a-real-binary", [], { ...process.env }, 10_000),
    /spawn definitely-not-a-real-binary failed/,
  );
});

test("runCli: kills and rejects on timeout", async () => {
  await assert.rejects(
    runCli(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      { ...process.env },
      300,
    ),
    /timed out after 300ms/,
  );
});
