// The inference proxy (rules §2.3 / §2.5 / §2.4): allowed paths, the model list, per-agent tokens,
// keys that stay on this side, and a record that replays.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  agentToken,
  createInferenceProxy,
  loadProxyConfig,
  type ProxyOptions,
} from "../core/src/inference/proxy.js";

const config = loadProxyConfig({
  maxCallsPerMinute: 2,
  models: [
    { name: "gpt-x", provider: "openai", upstream: "https://up.example/v1", apiKeyEnv: "UP_KEY", upstreamModel: "gpt-x-2026" },
    { name: "claude-y", provider: "anthropic", upstream: "https://ant.example/v1", apiKeyEnv: "ANT_KEY" },
    { name: "local-z", provider: "ollama", upstream: "http://ollama.local/api" },
  ],
});

type Seen = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

async function withProxy<T>(
  opts: Partial<ProxyOptions>,
  fn: (base: string, seen: Seen[]) => Promise<T>,
): Promise<T> {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const server = createInferenceProxy({
    config,
    fetchImpl,
    env: { UP_KEY: "sk-upstream", ANT_KEY: "sk-ant" },
    ...opts,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(base, seen);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("only the three inference paths exist; everything else is 404", async () => {
  await withProxy({}, async (base) => {
    assert.equal((await post(base, "/v1/files", { model: "gpt-x" })).status, 404);
    assert.equal((await post(base, "/v1/responses", { model: "gpt-x" })).status, 404);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const models = (await (await fetch(`${base}/v1/models`)).json()) as { data: { id: string }[] };
    assert.deepEqual(models.data.map((m) => m.id), ["gpt-x", "claude-y", "local-z"]);
  });
});

test("a model outside the list, or on the wrong provider's path, is refused with the allowed names", async () => {
  await withProxy({}, async (base) => {
    const r = await post(base, "/v1/chat/completions", { model: "gpt-secret", messages: [] });
    assert.equal(r.status, 403);
    assert.deepEqual(((await r.json()) as { allowed: string[] }).allowed, ["gpt-x"]);
    assert.equal((await post(base, "/api/chat", { model: "gpt-x", messages: [] })).status, 403);
  });
});

test("stored or previous references and streaming are refused, naming the key", async () => {
  await withProxy({}, async (base) => {
    const r = await post(base, "/v1/chat/completions", {
      model: "gpt-x",
      messages: [],
      previous_response_id: "resp_123",
    });
    assert.equal(r.status, 403);
    assert.deepEqual(((await r.json()) as { rejected: string[] }).rejected, ["previous_response_id"]);
    assert.equal(
      (await post(base, "/v1/messages", { model: "claude-y", messages: [], container: "c1" })).status,
      403,
    );
    assert.equal(
      (await post(base, "/v1/chat/completions", { model: "gpt-x", messages: [], stream: true })).status,
      400,
    );
  });
});

test("with a secret, the caller needs its own token; the upstream sees the operator's key and the pinned model", async () => {
  const secret = "s3cret";
  await withProxy({ secret, config: { ...config, maxCallsPerMinute: 0 } }, async (base, seen) => {
    assert.equal((await post(base, "/v1/chat/completions", { model: "gpt-x", messages: [] })).status, 401);
    const wrong = { "x-eris-agent": "alice", authorization: `Bearer ${agentToken(secret, "bob")}` };
    assert.equal((await post(base, "/v1/chat/completions", { model: "gpt-x", messages: [] }, wrong)).status, 401);
    const ok = { "x-eris-agent": "alice", authorization: `Bearer ${agentToken(secret, "alice")}` };
    const r = await post(base, "/v1/chat/completions", { model: "gpt-x", messages: [{ role: "user", content: "hi" }] }, ok);
    assert.equal(r.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://up.example/v1/chat/completions");
    assert.equal(seen[0].headers.authorization, "Bearer sk-upstream");
    assert.equal(seen[0].body.model, "gpt-x-2026");
    // Anthropic gets x-api-key and a version header, not a bearer.
    await post(base, "/v1/messages", { model: "claude-y", messages: [] }, ok);
    assert.equal(seen[1].headers["x-api-key"], "sk-ant");
    assert.equal(seen[1].headers["anthropic-version"], "2023-06-01");
    assert.equal(seen[1].headers.authorization, undefined);
  });
});

test("every call is recorded per agent with a sequence number, and a recording replays without an upstream", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-proxy-"));
  const unlimited = { ...config, maxCallsPerMinute: 0 };
  await withProxy({ recordDir: dir, config: unlimited }, async (base, seen) => {
    const h = { "x-eris-agent": "alice" };
    await post(base, "/v1/chat/completions", { model: "gpt-x", messages: [{ role: "user", content: "1" }] }, h);
    await post(base, "/v1/chat/completions", { model: "gpt-x", messages: [{ role: "user", content: "2" }] }, h);
    assert.equal(seen.length, 2);
    const lines = readFileSync(join(dir, "alice.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.seq), [1, 2]);
    assert.equal(lines[0].model, "gpt-x");
    assert.equal(lines[0].status, 200);
    assert.deepEqual(lines[1].request.messages, [{ role: "user", content: "2" }]);
    assert.ok(!existsSync(join(dir, "anonymous.jsonl")));
  });
  await withProxy({ replayDir: dir, config: unlimited }, async (base, seen) => {
    const h = { "x-eris-agent": "alice" };
    const r1 = await post(base, "/v1/chat/completions", { model: "gpt-x", messages: [] }, h);
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { choices: [{ message: { content: "{\"ok\":true}" } }] });
    await post(base, "/v1/chat/completions", { model: "gpt-x", messages: [] }, h);
    const r3 = await post(base, "/v1/chat/completions", { model: "gpt-x", messages: [] }, h);
    assert.equal(r3.status, 409);
    assert.equal(seen.length, 0, "replay never calls an upstream");
  });
});

test("the per-agent rate limit is a sliding minute", async () => {
  let t = 1_000_000;
  await withProxy({ now: () => t }, async (base) => {
    const h = { "x-eris-agent": "alice" };
    assert.equal((await post(base, "/v1/chat/completions", { model: "gpt-x", messages: [] }, h)).status, 200);
    assert.equal((await post(base, "/v1/chat/completions", { model: "gpt-x", messages: [] }, h)).status, 200);
    assert.equal((await post(base, "/v1/chat/completions", { model: "gpt-x", messages: [] }, h)).status, 429);
    // another agent has its own budget
    assert.equal((await post(base, "/v1/chat/completions", { model: "gpt-x", messages: [] }, { "x-eris-agent": "bob" })).status, 200);
    t += 61_000;
    assert.equal((await post(base, "/v1/chat/completions", { model: "gpt-x", messages: [] }, h)).status, 200);
  });
});
