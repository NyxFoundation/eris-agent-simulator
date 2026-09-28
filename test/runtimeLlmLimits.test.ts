// Issue #168: what the reference runtime asks a model for, and how it says a reply was cut.
//
// The operator caps neither input nor output (the proxy forwards the body as written), so the limits
// on a revision call are the model's, the service's, and whatever llm.ts sends. These tests stand a
// local server in for the provider -- through ERIS_INFERENCE_BASE_URL, the proxy route every family
// takes in the competition -- and read what each family actually sent.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  callLlmWithUsage,
  DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_OLLAMA_CONTEXT_TOKENS,
  estimatePromptTokens,
  LlmOutputTruncatedError,
  resolveLlmLimits,
} from "../example/agents/runtime/llm.js";
import { revisionFailedReason } from "../example/agents/runtime/improve.js";

type Call = { path: string; body: Record<string, unknown> };
const calls: Call[] = [];
// What the stand-in provider answers next, by path. Set per test.
let answer: (call: Call) => unknown = () => ({});

let server: http.Server;
before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const call = {
        path: new URL(req.url ?? "/", "http://x").pathname,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      };
      calls.push(call);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer(call)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.ERIS_INFERENCE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  delete process.env.ERIS_LLM_MAX_OUTPUT_TOKENS;
  delete process.env.ERIS_LLM_CONTEXT_TOKENS;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

// A well-formed, complete reply in each family's shape.
function reply(call: Call, text = '{"notes":"ok","executorTs":null}'): unknown {
  if (call.path === "/api/chat")
    return { message: { role: "assistant", content: text }, done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 7 };
  if (call.path === "/v1/chat/completions")
    return { choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 7 } };
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: call.body.model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 7 },
  };
}

const FAMILIES = [
  { family: "ollama", model: "gpt-oss:120b", path: "/api/chat" },
  { family: "openai", model: "openai:gpt-x", path: "/v1/chat/completions" },
  { family: "anthropic", model: "claude-test", path: "/v1/messages" },
] as const;

const request = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  system: "you maintain a strategy",
  messages: [{ role: "user" as const, content: "block: 100" }],
  ...extra,
});

async function sent(model: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  answer = (call) => reply(call);
  calls.length = 0;
  await callLlmWithUsage(request(model, extra));
  assert.equal(calls.length, 1);
  return calls[0].body;
}

test("each family sends the limits prompt.md configured", async () => {
  const limits = { maxOutputTokens: 12_345, contextTokens: 65_536 };
  const ollama = await sent("gpt-oss:120b", limits);
  assert.deepEqual(ollama.options, { num_ctx: 65_536, num_predict: 12_345 });
  assert.equal(ollama.stream, false);
  const openai = await sent("openai:gpt-x", limits);
  assert.equal(openai.max_completion_tokens, 12_345);
  assert.equal("max_tokens" in openai, false, "the deprecated name, refused by the o-series");
  const anthropic = await sent("claude-test", limits);
  assert.equal(anthropic.max_tokens, 12_345);
});

test("without a configured limit: an explicit Ollama context, the model's own output cap, and 16,000 for Claude", async () => {
  const ollama = await sent("gpt-oss:120b");
  // Explicit, so the service's unpublished default never decides what is dropped.
  assert.deepEqual(ollama.options, { num_ctx: DEFAULT_OLLAMA_CONTEXT_TOKENS });
  const openai = await sent("openai:gpt-x");
  assert.equal("max_completion_tokens" in openai, false);
  const anthropic = await sent("claude-test");
  assert.equal(anthropic.max_tokens, DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS);
});

test("the environment supplies limits prompt.md did not set, and prompt.md wins", async () => {
  const env = { ERIS_LLM_MAX_OUTPUT_TOKENS: "9000", ERIS_LLM_CONTEXT_TOKENS: "40000" };
  assert.deepEqual(resolveLlmLimits({}, env), { maxOutputTokens: 9000, contextTokens: 40_000 });
  assert.deepEqual(resolveLlmLimits({ maxOutputTokens: 20_000 }, env), { maxOutputTokens: 20_000, contextTokens: 40_000 });
  assert.throws(() => resolveLlmLimits({}, { ERIS_LLM_MAX_OUTPUT_TOKENS: "lots" }), /ERIS_LLM_MAX_OUTPUT_TOKENS must be a positive integer/);
  process.env.ERIS_LLM_MAX_OUTPUT_TOKENS = "9000";
  try {
    assert.equal((await sent("claude-test")).max_tokens, 9000);
  } finally {
    delete process.env.ERIS_LLM_MAX_OUTPUT_TOKENS;
  }
});

test("the Claude default is above the old 2,048 and inside the SDK's non-streaming bound", async () => {
  assert.ok(DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS > 2048);
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const probe = new Anthropic({ apiKey: "unused" });
  // The SDK's own check for a client with no timeout of its own: it throws past 10 minutes.
  assert.doesNotThrow(() => probe.calculateNonstreamingTimeout(DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS));
  assert.throws(() => probe.calculateNonstreamingTimeout(32_000), /Streaming is required/);
  // The runtime's client carries its own timeout, so a participant who raises the cap past that
  // bound reaches the model's limit rather than the SDK's estimate.
  assert.equal((await sent("claude-test", { maxOutputTokens: 32_000 })).max_tokens, 32_000);
  assert.equal(DEFAULT_CALL_TIMEOUT_MS, 300_000, "the five minutes a call may wait");
});

for (const f of FAMILIES) {
  test(`${f.family}: a reply cut at its output cap is a truncation, not a reply`, async () => {
    answer = (call) => {
      // Mid-code, the way a strategy source is cut: this would fail JSON.parse downstream.
      const cut = reply(call, '{"notes":"rewrite","executorTs":"if (obs.round') as Record<string, unknown>;
      if (f.family === "ollama") return { ...cut, done_reason: "length", eval_count: 4096 };
      if (f.family === "openai")
        return { ...cut, choices: [{ message: { content: '{"notes":"rewrite","executorTs":"if (' }, finish_reason: "length" }], usage: { completion_tokens: 4096 } };
      return { ...cut, stop_reason: "max_tokens", usage: { input_tokens: 12, output_tokens: 4096 } };
    };
    const error = await callLlmWithUsage(request(f.model, { maxOutputTokens: 4096 })).then(
      () => assert.fail("a truncated reply was returned as if complete"),
      (e: unknown) => e,
    );
    assert.ok(error instanceof LlmOutputTruncatedError);
    assert.equal(error.tokens, 4096);
    // What the agent log will say: the count and the fix, under the prefix for a failed call.
    assert.match(revisionFailedReason(error), /^revision failed: output truncated at 4096 tokens \(.+\): raise maxOutputTokens in prompt\.md/);
    assert.doesNotMatch(revisionFailedReason(error), /compile|JSON/);
  });
}

test("usage comes back with the reply", async () => {
  for (const f of FAMILIES) {
    answer = (call) => reply(call);
    const r = await callLlmWithUsage(request(f.model));
    assert.equal(r.text, '{"notes":"ok","executorTs":null}');
    assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 7 }, f.family);
    assert.deepEqual(r.warnings, []);
  }
});

test("an Ollama prompt that cannot fit its context comes back with a warning, not silently", async () => {
  answer = (call) => reply(call);
  const long = request("gpt-oss:120b", { contextTokens: 100 });
  long.messages[0].content = "x".repeat(1_000);
  assert.ok(estimatePromptTokens(long) > 100);
  const r = await callLlmWithUsage(long);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^input truncated: the prompt is ~\d+ tokens .* num_ctx is 100; Ollama evaluated 12\. .*raise contextTokens/);
  // The same prompt in a window it fits is not warned about.
  assert.deepEqual((await callLlmWithUsage({ ...long, contextTokens: 10_000 })).warnings, []);
});
