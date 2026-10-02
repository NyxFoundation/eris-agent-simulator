// The inference proxy (rules §2.3 / §2.5 / §2.4): allowed paths, the model list, per-agent tokens,
// keys that stay on this side, and a record that replays.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
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

type Seen = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
};

// What the upstream answers. The default is a whole JSON answer; the streaming tests bring their own.
type Upstream = (seen: Seen) => Response | Promise<Response>;

const jsonAnswer: Upstream = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function withProxy<T>(
  opts: Partial<ProxyOptions> & { upstream?: Upstream },
  fn: (base: string, seen: Seen[]) => Promise<T>,
): Promise<T> {
  const { upstream = jsonAnswer, ...proxyOpts } = opts;
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Seen = {
      url: String(url),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      ...(init?.signal ? { signal: init.signal } : {}),
    };
    seen.push(call);
    return upstream(call);
  }) as typeof fetch;
  const server = createInferenceProxy({
    config,
    fetchImpl,
    env: { UP_KEY: "sk-upstream", ANT_KEY: "sk-ant" },
    ...proxyOpts,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(base, seen);
  } finally {
    // A test that walked away from a response leaves its socket open; close() would wait it out.
    server.closeAllConnections();
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

test("stored or previous references are refused, naming the key", async () => {
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

// ---- streaming (issue #166) ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// An upstream stream the test drives: each chunk is sent after its gate opens (a gate that never
// opens is an upstream that goes quiet), and the stream errors when the proxy aborts the request --
// what undici does to a real response body.
function streamed(
  seen: Seen,
  contentType: string,
  chunks: Array<{ text: string; after?: Promise<unknown> }>,
  opts: { close?: boolean } = {},
): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      seen.signal?.addEventListener("abort", () => controller.error(seen.signal?.reason));
      try {
        for (const c of chunks) {
          if (c.after) await c.after;
          controller.enqueue(enc.encode(c.text));
        }
        if (opts.close !== false) controller.close();
      } catch {
        // Already errored by the abort above.
      }
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

// A promise and its resolver: a gate the test opens.
function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  assert.equal(done, false);
  return new TextDecoder().decode(value);
}

async function waitFor(cond: () => boolean, what: string, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const recorded = (dir: string, agent: string) =>
  existsSync(join(dir, `${agent}.jsonl`))
    ? readFileSync(join(dir, `${agent}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];

const unlimited = { ...config, maxCallsPerMinute: 0 };

const STREAM_CASES = [
  {
    provider: "ollama",
    path: "/api/chat",
    // No `stream` at all: Ollama's default is to stream, and the proxy relays it as the NDJSON it is
    // rather than handing a client that never asked for a stream one text blob.
    body: { model: "local-z", messages: [{ role: "user", content: "hi" }] },
    contentType: "application/x-ndjson",
    chunks: [
      '{"message":{"role":"assistant","content":"{\\"ok\\""},"done":false}\n',
      '{"message":{"role":"assistant","content":":true}"},"done":true,"done_reason":"stop"}\n',
    ],
  },
  {
    provider: "openai",
    path: "/v1/chat/completions",
    body: { model: "gpt-x", stream: true, messages: [{ role: "user", content: "hi" }] },
    contentType: "text/event-stream; charset=utf-8",
    chunks: [
      'data: {"choices":[{"delta":{"content":"{\\"ok\\""}}]}\n\n',
      'data: {"choices":[{"delta":{"content":":true}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ],
  },
  {
    provider: "anthropic",
    path: "/v1/messages",
    body: { model: "claude-y", stream: true, max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
    contentType: "text/event-stream; charset=utf-8",
    chunks: [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    ],
  },
] as const;

for (const c of STREAM_CASES) {
  test(`${c.provider}: a streamed answer is relayed chunk by chunk under the upstream's status and content type`, { timeout: 10_000 }, async () => {
    // The upstream holds the second chunk until the agent has read the first. A proxy that buffered
    // the answer would deadlock here instead of passing.
    const second = gate();
    await withProxy(
      {
        config: unlimited,
        upstream: (seen) =>
          streamed(seen, c.contentType, [
            { text: c.chunks[0] },
            { text: c.chunks[1], after: second.opened },
          ]),
      },
      async (base) => {
        const r = await post(base, c.path, c.body, { "x-eris-agent": "alice" });
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("content-type"), c.contentType);
        const reader = r.body!.getReader();
        const first = await readChunk(reader);
        assert.equal(first, c.chunks[0]);
        second.open();
        let rest = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          rest += new TextDecoder().decode(value);
        }
        assert.equal(first + rest, c.chunks.join(""));
      },
    );
  });
}

test("a streamed call is recorded as one record with its text and content type, and replays as the same stream", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-proxy-stream-"));
  const sse = STREAM_CASES[1];
  const whole = sse.chunks.join("");
  await withProxy(
    { recordDir: dir, config: unlimited, upstream: (seen) => streamed(seen, sse.contentType, sse.chunks.map((text) => ({ text }))) },
    async (base) => {
      const r = await post(base, sse.path, sse.body, { "x-eris-agent": "alice" });
      assert.equal(await r.text(), whole);
      await waitFor(() => recorded(dir, "alice").length === 1, "the record");
      const [rec] = recorded(dir, "alice");
      assert.equal(rec.seq, 1);
      assert.equal(rec.status, 200);
      assert.equal(rec.stream, true);
      assert.equal(rec.contentType, sse.contentType);
      assert.equal(rec.response, whole, "the whole stream, not its first chunk");
      assert.equal(rec.error, undefined);
      assert.deepEqual(rec.request, sse.body);
    },
  );
  await withProxy({ replayDir: dir, config: unlimited }, async (base, seen) => {
    const r = await post(base, sse.path, sse.body, { "x-eris-agent": "alice" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), sse.contentType);
    assert.equal(await r.text(), whole);
    assert.equal(seen.length, 0, "replay never calls an upstream");
  });
});

test("a streamed call is cut by silence, not by its length", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-proxy-idle-"));
  // Both bounds are 150 ms. The first stream runs well past that in total and is never quiet for
  // that long; the second sends one chunk and goes quiet.
  const quick = { ...unlimited, upstreamTimeoutMs: 150, streamIdleTimeoutMs: 150 };
  const sse = STREAM_CASES[1];
  let call = 0;
  await withProxy(
    {
      recordDir: dir,
      config: quick,
      upstream: (seen) =>
        ++call === 1
          ? streamed(
              seen,
              sse.contentType,
              Array.from({ length: 6 }, (_, i) => ({ text: `data: ${i}\n\n`, after: sleep(60 * (i + 1)) })),
            )
          : streamed(seen, sse.contentType, [{ text: "data: 0\n\n" }], { close: false }),
    },
    async (base) => {
      const long = await post(base, sse.path, sse.body, { "x-eris-agent": "alice" });
      assert.equal(await long.text(), Array.from({ length: 6 }, (_, i) => `data: ${i}\n\n`).join(""));

      const stalled = await post(base, sse.path, sse.body, { "x-eris-agent": "alice" });
      assert.equal(stalled.status, 200);
      const reader = stalled.body!.getReader();
      assert.equal(await readChunk(reader), "data: 0\n\n");
      // The cut arrives as a broken stream -- the only way left once the headers are out.
      await assert.rejects(reader.read());

      await waitFor(() => recorded(dir, "alice").length === 2, "both records");
      const [ok, cut] = recorded(dir, "alice");
      assert.equal(ok.error, undefined);
      assert.match(cut.error, /went quiet for 150 ms/);
      assert.equal(cut.stream, true);
      assert.equal(cut.response, "data: 0\n\n", "what had arrived is kept");
    },
  );
  // Replay breaks off at the same place.
  await withProxy({ replayDir: dir, config: quick }, async (base) => {
    await (await post(base, sse.path, sse.body, { "x-eris-agent": "alice" })).text();
    const r = await post(base, sse.path, sse.body, { "x-eris-agent": "alice" });
    const reader = r.body!.getReader();
    assert.equal(await readChunk(reader), "data: 0\n\n");
    await assert.rejects(reader.read());
  });
});

test("an agent that stops waiting aborts the upstream request, streamed or not", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-proxy-leave-"));
  const sse = STREAM_CASES[1];
  await withProxy(
    {
      recordDir: dir,
      config: unlimited,
      upstream: (seen) =>
        seen.body.stream === true
          ? streamed(seen, sse.contentType, [{ text: "data: 0\n\n" }], { close: false })
          : // A whole answer that is never ready: it ends only when the request is aborted.
            new Promise<Response>((_, reject) =>
              seen.signal?.addEventListener("abort", () => reject(seen.signal?.reason)),
            ),
    },
    async (base, seen) => {
      const streaming = new AbortController();
      const r = await fetch(`${base}${sse.path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-eris-agent": "alice" },
        body: JSON.stringify(sse.body),
        signal: streaming.signal,
      });
      assert.equal(await readChunk(r.body!.getReader()), "data: 0\n\n");
      streaming.abort();
      await waitFor(() => seen[0].signal?.aborted === true, "the streamed upstream request to be aborted");

      const waiting = new AbortController();
      const pending = fetch(`${base}${sse.path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-eris-agent": "alice" },
        body: JSON.stringify({ ...sse.body, stream: false }),
        signal: waiting.signal,
      }).catch(() => undefined);
      await waitFor(() => seen.length === 2, "the second call to reach the upstream");
      waiting.abort();
      await pending;
      await waitFor(() => seen[1].signal?.aborted === true, "the whole-answer upstream request to be aborted");

      await waitFor(() => recorded(dir, "alice").length === 2, "both records");
      const [s, w] = recorded(dir, "alice");
      assert.equal(s.error, "client disconnected");
      assert.equal(s.response, "data: 0\n\n");
      assert.equal(w.error, "client disconnected");
      assert.equal(w.status, 499);
    },
  );
});

test("an agent that reads slowly is not buffered for: the proxy stops pulling from the upstream", { timeout: 20_000 }, async () => {
  // 400 chunks of 64 KiB (25 MiB), produced only as fast as they are pulled.
  const CHUNK = 64 * 1024;
  const TOTAL = 400;
  let pulled = 0;
  await withProxy(
    {
      config: unlimited,
      upstream: () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (pulled === TOTAL) return controller.close();
                pulled++;
                controller.enqueue(new Uint8Array(CHUNK).fill(0x61));
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    },
    async (base) => {
      const r = await post(base, "/v1/chat/completions", { model: "gpt-x", stream: true, messages: [] });
      // The agent reads nothing for a while. A proxy that ignored backpressure would have pulled all
      // 25 MiB into memory by now; one that waits for `drain` stops at what the socket holds.
      await sleep(500);
      assert.ok(pulled < TOTAL / 2, `pulled ${pulled} of ${TOTAL} chunks while the agent read nothing`);
      let received = 0;
      const reader = r.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
      }
      assert.equal(received, TOTAL * CHUNK, "and all of it arrives once the agent reads");
    },
  );
});

test("a stream past maxStreamBytes is cut, and recorded and replayed with the same cut", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-proxy-size-"));
  const small = { ...unlimited, maxStreamBytes: 100 };
  const chunk = `data: ${"x".repeat(52)}\n\n`; // 60 bytes
  await withProxy(
    {
      recordDir: dir,
      config: small,
      upstream: (seen) => streamed(seen, "text/event-stream", [{ text: chunk }, { text: chunk }, { text: chunk }]),
    },
    async (base, seen) => {
      const r = await post(base, "/v1/chat/completions", { model: "gpt-x", stream: true, messages: [] }, { "x-eris-agent": "alice" });
      const reader = r.body!.getReader();
      assert.equal(await readChunk(reader), chunk);
      await assert.rejects(reader.read());
      await waitFor(() => seen[0].signal?.aborted === true, "the upstream request to be aborted");
      await waitFor(() => recorded(dir, "alice").length === 1, "the record");
      const [rec] = recorded(dir, "alice");
      assert.equal(rec.error, "stream exceeded 100 bytes");
      assert.equal(rec.response, chunk);
    },
  );
});

test("the proxy's timeouts default to the five-minute wait and are validated", () => {
  const d = loadProxyConfig({ models: config.models });
  assert.equal(d.upstreamTimeoutMs, 300_000);
  assert.equal(d.streamIdleTimeoutMs, 300_000, "idle defaults to the non-streamed bound");
  assert.equal(loadProxyConfig({ models: config.models, upstreamTimeoutMs: 90_000 }).streamIdleTimeoutMs, 90_000);
  assert.throws(() => loadProxyConfig({ models: config.models, streamIdleTimeoutMs: 0 }), /streamIdleTimeoutMs/);
  assert.equal(d.maxStreamBytes, 32 * 1024 * 1024);
  assert.throws(() => loadProxyConfig({ models: config.models, maxStreamBytes: -1 }), /maxStreamBytes/);
});

// ---- the record is bounded, and its failure is not the proxy's (issue #215) ----

// A request whose record is a known size, so a cap can be set in records rather than guessed.
const bigBody = (content: string) => ({ model: "gpt-x", messages: [{ role: "user", content }] });
const KIB = "x".repeat(1024);

test("a record that cannot be written is reported and counted; the call is served and the next one too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-proxy-nowrite-"));
  // alice's file is a directory, so every append to it fails (EISDIR) the way a full disk fails
  // every append (ENOSPC): the same message each time.
  mkdirSync(join(dir, "alice.jsonl"));
  const lines: string[] = [];
  await withProxy({ recordDir: dir, config: unlimited, log: (l) => lines.push(l) }, async (base, seen) => {
    const h = { "x-eris-agent": "alice" };
    assert.equal((await post(base, "/v1/chat/completions", bigBody("1"), h)).status, 200);
    assert.equal((await post(base, "/v1/chat/completions", bigBody("2"), h)).status, 200);
    assert.equal(seen.length, 2, "both calls reached the upstream");
    // Said once per agent for the same failure; counted every time.
    assert.equal(lines.length, 1);
    assert.match(lines[0], /record for alice not written \(the call was served\): EISDIR/);
    const health = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; recording: { failures: number; calls: number } };
    assert.equal(health.ok, true);
    assert.equal(health.recording.failures, 2);
    assert.equal(health.recording.calls, 0);
    // Another agent's record is unaffected.
    await post(base, "/v1/chat/completions", bigBody("3"), { "x-eris-agent": "bob" });
    assert.equal(recorded(dir, "bob").length, 1);
  });
});

test("recording stops at the agent's cap with a note in its file; its calls still pass and others still record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-proxy-cap-"));
  // One record is a little over 1 KiB (the body plus ~300 bytes of envelope); 2.75 KiB holds two.
  const config = { ...unlimited, maxRecordBytesPerAgent: 2816 };
  const lines: string[] = [];
  await withProxy({ recordDir: dir, config, log: (l) => lines.push(l) }, async (base, seen) => {
    const h = { "x-eris-agent": "alice" };
    for (let i = 1; i <= 4; i++)
      assert.equal((await post(base, "/v1/chat/completions", bigBody(KIB), h)).status, 200, `call ${i}`);
    assert.equal(seen.length, 4, "every call reached the upstream");
    const file = recorded(dir, "alice");
    assert.deepEqual(file.map((l) => l.seq), [1, 2, 3], "two records and the note");
    assert.equal(file[2].event, "recording_capped");
    assert.equal(file[2].scope, "agent");
    assert.equal(file[2].cap, 2816);
    assert.ok(file[2].recordedBytes > 2048 && file[2].recordedBytes <= 2816, `recordedBytes ${file[2].recordedBytes}`);
    assert.equal(file[2].response, undefined, "the note is not a call");
    // Said once, when it happened; the fourth call added nothing.
    assert.equal(lines.length, 1);
    assert.match(lines[0], /recording stopped for alice at call #3: its 2816 bytes \(maxRecordBytesPerAgent\) are used up; its calls are still served/);
    // bob has his own cap.
    await post(base, "/v1/chat/completions", bigBody(KIB), { "x-eris-agent": "bob" });
    assert.equal(recorded(dir, "bob").length, 1);
    const health = (await (await fetch(`${base}/healthz`)).json()) as { recording: { calls: number; cappedAgents: number; totalCapped: boolean } };
    assert.equal(health.recording.calls, 3);
    assert.equal(health.recording.cappedAgents, 1);
    assert.equal(health.recording.totalCapped, false);
  });
  // Replay skips the note and serves the two recorded calls, then 409 like any run that asks for
  // more calls than were recorded.
  await withProxy({ replayDir: dir, config }, async (base, seen) => {
    const h = { "x-eris-agent": "alice" };
    assert.equal((await post(base, "/v1/chat/completions", bigBody(KIB), h)).status, 200);
    assert.equal((await post(base, "/v1/chat/completions", bigBody(KIB), h)).status, 200);
    assert.equal((await post(base, "/v1/chat/completions", bigBody(KIB), h)).status, 409);
    assert.equal(seen.length, 0);
  });
});

test("the proxy's total cap stops recording for everyone, each file ending with the note", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eris-proxy-total-"));
  const config = { ...unlimited, maxRecordBytesTotal: 2816 };
  const lines: string[] = [];
  await withProxy({ recordDir: dir, config, log: (l) => lines.push(l) }, async (base, seen) => {
    const alice = { "x-eris-agent": "alice" };
    const bob = { "x-eris-agent": "bob" };
    await post(base, "/v1/chat/completions", bigBody(KIB), alice);
    await post(base, "/v1/chat/completions", bigBody(KIB), alice);
    // The third record of any agent crosses the proxy's total.
    assert.equal((await post(base, "/v1/chat/completions", bigBody(KIB), bob)).status, 200);
    assert.equal((await post(base, "/v1/chat/completions", bigBody(KIB), alice)).status, 200);
    assert.equal(seen.length, 4);
    const a = recorded(dir, "alice");
    const b = recorded(dir, "bob");
    assert.deepEqual(a.map((l) => l.event ?? "call"), ["call", "call", "recording_capped"]);
    assert.deepEqual(b.map((l) => l.event ?? "call"), ["recording_capped"]);
    assert.equal(a[2].scope, "total");
    assert.equal(a[2].seq, 3);
    assert.equal(b[0].scope, "total");
    assert.equal(b[0].seq, 1);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /recording stopped for bob at call #1: the proxy's 2816 bytes \(maxRecordBytesTotal\)/);
    const health = (await (await fetch(`${base}/healthz`)).json()) as { recording: { cappedAgents: number; totalCapped: boolean } };
    assert.equal(health.recording.totalCapped, true);
    assert.equal(health.recording.cappedAgents, 2);
  });
});

test("a handler that throws is that call's 500, not the process's exit, and the next call is served", async () => {
  // A clock that breaks once stands in for any bug on the request path.
  let broken = true;
  const lines: string[] = [];
  await withProxy(
    {
      config: unlimited,
      log: (l) => lines.push(l),
      now: () => {
        if (broken) {
          broken = false;
          throw new Error("clock broke");
        }
        return Date.now();
      },
    },
    async (base) => {
      const h = { "x-eris-agent": "alice" };
      const r = await post(base, "/v1/chat/completions", bigBody("1"), h);
      assert.equal(r.status, 500);
      assert.deepEqual(await r.json(), { error: "proxy internal error" });
      assert.equal(lines.length, 1);
      assert.match(lines[0], /POST \/v1\/chat\/completions from alice failed in the proxy: Error: clock broke/);
      assert.equal((await post(base, "/v1/chat/completions", bigBody("2"), h)).status, 200);
      const health = (await (await fetch(`${base}/healthz`)).json()) as { handlerErrors: number };
      assert.equal(health.handlerErrors, 1);
    },
  );
});

test("the record caps default to 256 MiB per agent and 8 GiB in all, and cannot be unlimited", () => {
  const d = loadProxyConfig({ models: config.models });
  assert.equal(d.maxRecordBytesPerAgent, 256 * 1024 * 1024);
  assert.equal(d.maxRecordBytesTotal, 8 * 1024 * 1024 * 1024);
  assert.equal(loadProxyConfig({ models: config.models, maxRecordBytesPerAgent: 1024 }).maxRecordBytesPerAgent, 1024);
  assert.throws(() => loadProxyConfig({ models: config.models, maxRecordBytesPerAgent: 0 }), /maxRecordBytesPerAgent/);
  assert.throws(() => loadProxyConfig({ models: config.models, maxRecordBytesTotal: -1 }), /maxRecordBytesTotal/);
});
