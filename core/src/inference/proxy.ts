// The inference proxy: the one door between an agent and a model (rules §2.3 "external
// communication", §2.5; ADR 0023 task 3 / memory inference-proxy-design).
//
// An agent's process may not reach the outside network. Its strategy revisions still need a model,
// so the operator runs this proxy on the agents' network and the agent talks to it instead of to
// the provider. The proxy does four things and deliberately nothing more:
//
//   1. allowed paths only      /api/chat (Ollama), /v1/chat/completions (OpenAI-compatible),
//                              /v1/messages (Anthropic). Everything else is 404 -- a provider's Files
//                              API, stored prompts or fine-tune endpoints on the same host would
//                              otherwise be a dead-drop for a human to feed a frozen agent.
//   2. models from a list      the request's `model` must be in models.yaml, and the list is what
//                              §2.5 publishes. A reference the operator cannot pin (a stored prompt
//                              id, a previous response, a container) is refused.
//   3. keys stay here          the agent authenticates with a per-agent token (HMAC of its id under a
//                              secret only the coordinator and this proxy hold); the upstream key is
//                              attached here, from the proxy's own environment.
//   4. every exchange recorded  request and response, retries included, one JSON line per call under
//                              <recordDir>/<agentId>.jsonl (rules §2.4: replay is deterministic
//                              because it replays these). `replayDir` serves them back in order
//                              without touching an upstream.
//
// The request body is forwarded as the agent wrote it (model name aside). Rebuilding it would fight
// the self-improvement design, where the model's brief is the agent's own prompt.md (ADR 0018).
//
// Streaming (issue #166). A streamed response (SSE from the OpenAI-compatible and Anthropic paths,
// NDJSON from Ollama) is relayed chunk by chunk as it arrives, under the upstream's status and
// content type, and recorded as one record once it ends: the whole text, with its content type, so
// a replay serves back the same stream. It used to be refused, and that capped every call at one
// wait for a whole answer -- which Node's fetch cuts at 300 s of waiting for response headers, and a
// non-streamed answer's headers arrive only when the answer is complete. A streamed call is bounded
// by silence instead (`streamIdleTimeoutMs`, re-armed on every chunk), and in total by the epoch:
// when the agent is stopped its connection closes, and a client that goes away aborts the upstream
// request, since the participant pays for the tokens (rules §2.5).

import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

export type Provider = "ollama" | "openai" | "anthropic";

export type ModelEntry = {
  // The name agents use (and the name published under §2.5).
  name: string;
  provider: Provider;
  // Base URL of the provider's API: https://ollama.com/api, https://api.openai.com/v1,
  // https://api.anthropic.com/v1, or a self-hosted equivalent.
  upstream: string;
  // Environment variable (of the proxy's process) holding the upstream key. Optional for a local
  // Ollama.
  apiKeyEnv?: string;
  // Name to send upstream when it differs from the published one.
  upstreamModel?: string;
};

export type ProxyConfig = {
  models: ModelEntry[];
  // Per agent, sliding minute. 0 / absent = unlimited.
  maxCallsPerMinute?: number;
  // A call that is not streamed: the whole wait, request to last byte. Values above 300,000 do not
  // lengthen it: Node's fetch gives up after 300 s without response headers, and a non-streamed
  // answer's headers arrive only once the whole answer is ready.
  upstreamTimeoutMs?: number;
  // A streamed call: the longest silence allowed -- before the first byte, and between chunks. There
  // is no total; the epoch is one. Defaults to upstreamTimeoutMs, so a streamed call is never cut
  // sooner than the same call not streamed would be.
  streamIdleTimeoutMs?: number;
  // A streamed call's size. With no bound on its length, this is what keeps one call's record (held
  // whole, written as one line) finite. Defaults to MAX_STREAM_BYTES.
  maxStreamBytes?: number;
};

// The wait participants are told a call may take (issue #166): five minutes.
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 300_000;
// 32 MiB: far beyond any answer a model gives, and eight times the cap on a request body.
export const MAX_STREAM_BYTES = 32 * 1024 * 1024;

export type ProxyOptions = {
  config: ProxyConfig;
  // HMAC secret shared with the coordinator. Absent = no authentication (single-operator local use).
  secret?: string;
  recordDir?: string;
  replayDir?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

export type RecordedCall = {
  ts: string;
  agentId: string;
  // 1-based per agent, in arrival order. A retry by the agent is simply the next call.
  seq: number;
  path: string;
  model: string;
  provider: Provider;
  durationMs: number;
  status: number;
  request: unknown;
  // For a streamed call, the whole stream as text (SSE events or NDJSON lines, as sent).
  response: unknown;
  // The upstream's content type. Replay serves the response back under it.
  contentType?: string;
  // The response was relayed as a stream rather than read whole.
  stream?: boolean;
  error?: string;
  replayed?: boolean;
};

// Client closed the request (nginx's code): the agent stopped waiting before an answer existed.
const CLIENT_CLOSED = 499;

const STREAM_CONTENT_TYPE = /^\s*(text\/event-stream|application\/x-ndjson)\b/i;
function isStreamContentType(contentType: string | undefined): boolean {
  return contentType !== undefined && STREAM_CONTENT_TYPE.test(contentType);
}

// Whether the agent asked for a stream, which decides how its wait is timed before a byte arrives.
// Ollama's /api/chat streams unless told `stream: false`; the other two only when told `stream: true`.
function asksForStream(provider: Provider, body: Record<string, unknown>): boolean {
  return provider === "ollama" ? body.stream !== false : body.stream === true;
}

const PATHS: Record<string, Provider> = {
  "/api/chat": "ollama",
  "/v1/chat/completions": "openai",
  "/v1/messages": "anthropic",
};

// Body keys that name something stored on the provider's side or otherwise outside what the
// operator can pin at the freeze: refused, with the key named, so the reason is visible.
const REJECTED_KEYS: Record<Provider, string[]> = {
  openai: [
    "previous_response_id",
    "prompt",
    "prompt_cache_key",
    "store",
    "metadata",
    "file_ids",
    "attachments",
    "tools",
    "tool_resources",
  ],
  anthropic: ["container", "mcp_servers", "tools"],
  ollama: [],
};

export function agentToken(secret: string, agentId: string): string {
  return createHmac("sha256", secret).update(agentId).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function loadProxyConfig(doc: unknown): ProxyConfig {
  const d = doc as Partial<ProxyConfig> | null;
  if (!d || !Array.isArray(d.models) || d.models.length === 0)
    throw new Error("models.yaml must contain a non-empty `models` list");
  for (const m of d.models) {
    if (typeof m.name !== "string" || !m.name)
      throw new Error("every model needs a name");
    if (!["ollama", "openai", "anthropic"].includes(m.provider))
      throw new Error(`model ${m.name}: provider must be ollama | openai | anthropic`);
    if (typeof m.upstream !== "string" || !/^https?:\/\//.test(m.upstream))
      throw new Error(`model ${m.name}: upstream must be an http(s) URL`);
  }
  for (const key of ["upstreamTimeoutMs", "streamIdleTimeoutMs", "maxStreamBytes"] as const) {
    const v = d[key];
    if (v !== undefined && !(Number.isFinite(v) && v > 0))
      throw new Error(`${key} must be a positive number`);
  }
  const upstreamTimeoutMs = d.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  return {
    models: d.models,
    maxCallsPerMinute: d.maxCallsPerMinute ?? 0,
    upstreamTimeoutMs,
    streamIdleTimeoutMs: d.streamIdleTimeoutMs ?? upstreamTimeoutMs,
    maxStreamBytes: d.maxStreamBytes ?? MAX_STREAM_BYTES,
  };
}

function readJsonBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  contentType = "application/json",
): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": contentType });
  res.end(text);
}

// Serve a recorded stream back as the agent saw it: whole, or -- when it broke off (it went quiet,
// or the agent itself left) -- cut after what had arrived, so the replayed call fails the same way.
function replayStream(res: http.ServerResponse, rec: RecordedCall): void {
  res.writeHead(rec.status, {
    "content-type": rec.contentType ?? "text/event-stream",
    "cache-control": "no-cache",
  });
  const text = typeof rec.response === "string" ? rec.response : "";
  if (rec.error === undefined) {
    res.end(text);
    return;
  }
  res.flushHeaders();
  if (text === "") res.destroy();
  else res.write(text, () => res.destroy());
}

class Replay {
  private readonly queues = new Map<string, RecordedCall[]>();
  constructor(private readonly dir: string) {}
  next(agentId: string): RecordedCall | undefined {
    let q = this.queues.get(agentId);
    if (!q) {
      const path = join(this.dir, `${agentId}.jsonl`);
      q = existsSync(path)
        ? readFileSync(path, "utf8")
            .split("\n")
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as RecordedCall)
        : [];
      this.queues.set(agentId, q);
    }
    return q.shift();
  }
}

export function createInferenceProxy(opts: ProxyOptions): http.Server {
  const { config } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => Date.now());
  const byName = new Map(config.models.map((m) => [m.name, m]));
  const replay = opts.replayDir ? new Replay(opts.replayDir) : null;
  const seq = new Map<string, number>();
  const recent = new Map<string, number[]>();
  if (opts.recordDir) mkdirSync(opts.recordDir, { recursive: true });

  const record = (entry: RecordedCall): void => {
    if (!opts.recordDir) return;
    appendFileSync(
      join(opts.recordDir, `${entry.agentId}.jsonl`),
      `${JSON.stringify(entry)}\n`,
    );
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://proxy");
    if (req.method === "GET" && url.pathname === "/healthz")
      return send(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/v1/models")
      return send(res, 200, {
        object: "list",
        data: config.models.map((m) => ({
          id: m.name,
          object: "model",
          provider: m.provider,
        })),
      });
    const provider = PATHS[url.pathname];
    if (req.method !== "POST" || !provider)
      return send(res, 404, {
        error: "path not allowed",
        allowed: Object.keys(PATHS),
      });

    // ---- who is calling ----
    const agentHeader = req.headers["x-eris-agent"];
    const agentId = (Array.isArray(agentHeader) ? agentHeader[0] : agentHeader) ?? "";
    if (opts.secret) {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!agentId || !token || !safeEqual(token, agentToken(opts.secret, agentId)))
        return send(res, 401, {
          error: "unauthorized: x-eris-agent and a per-agent bearer token are required",
        });
    }
    const who = agentId || "anonymous";

    // ---- the body ----
    let raw: string;
    try {
      raw = await readJsonBody(req);
    } catch (error) {
      return send(res, 413, { error: error instanceof Error ? error.message : String(error) });
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    } catch {
      return send(res, 400, { error: "body must be a JSON object" });
    }
    const model = typeof body.model === "string" ? body.model : "";
    const entry = byName.get(model);
    if (!entry || entry.provider !== provider)
      return send(res, 403, {
        error: `model not allowed on ${url.pathname}`,
        model,
        allowed: config.models
          .filter((m) => m.provider === provider)
          .map((m) => m.name),
      });
    const rejected = REJECTED_KEYS[provider].filter((k) => k in body);
    if (rejected.length > 0)
      return send(res, 403, {
        error:
          "request names something the operator cannot pin at the freeze (a stored prompt, a " +
          "previous response, tools, a container); send the whole conversation in the body instead",
        rejected,
      });

    // ---- rate limit ----
    const limit = config.maxCallsPerMinute ?? 0;
    if (limit > 0) {
      const t = now();
      const list = (recent.get(who) ?? []).filter((x) => t - x < 60_000);
      if (list.length >= limit) {
        recent.set(who, list);
        return send(res, 429, {
          error: `rate limit: ${limit} calls per minute per agent`,
          retryAfterMs: 60_000 - (t - list[0]),
        });
      }
      list.push(t);
      recent.set(who, list);
    }

    const n = (seq.get(who) ?? 0) + 1;
    seq.set(who, n);
    const started = now();

    // ---- replay ----
    if (replay) {
      const rec = replay.next(who);
      if (!rec)
        return send(res, 409, {
          error: `replay exhausted for ${who}: no recorded response for call #${n}`,
        });
      record({ ...rec, ts: new Date(started).toISOString(), replayed: true });
      if (rec.stream) return replayStream(res, rec);
      return send(res, rec.status, rec.response, rec.contentType);
    }

    // ---- forward ----
    const upstream = entry.upstream.replace(/\/$/, "");
    const target =
      provider === "ollama"
        ? `${upstream}/chat`
        : provider === "openai"
          ? `${upstream}/chat/completions`
          : `${upstream}/messages`;
    const key = entry.apiKeyEnv ? env[entry.apiKeyEnv] : undefined;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (provider === "anthropic") {
      if (key) headers["x-api-key"] = key;
      headers["anthropic-version"] =
        (req.headers["anthropic-version"] as string | undefined) ?? "2023-06-01";
    } else if (key) headers.authorization = `Bearer ${key}`;
    const forwarded = { ...body, model: entry.upstreamModel ?? entry.name };

    // ---- how long to wait ----
    // One abort for everything that ends the call early: the timer below, and the agent going away.
    // Whichever comes first names the reason, so the record says which it was.
    const totalMs = config.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    const idleMs = config.streamIdleTimeoutMs ?? totalMs;
    const maxBytes = config.maxStreamBytes ?? MAX_STREAM_BYTES;
    const upstreamAbort = new AbortController();
    let stopReason: string | undefined;
    const stop = (reason: string): void => {
      if (stopReason !== undefined) return;
      stopReason = reason;
      upstreamAbort.abort(new Error(reason));
    };
    let timer: NodeJS.Timeout | undefined;
    const arm = (ms: number, reason: string): void => {
      clearTimeout(timer);
      timer = setTimeout(() => stop(reason), ms);
    };
    if (asksForStream(provider, body)) arm(idleMs, `upstream sent nothing for ${idleMs} ms`);
    else arm(totalMs, `upstream timed out after ${totalMs} ms`);
    // The participant pays for the tokens (rules §2.5), so an agent that stops waiting -- its own
    // timeout, or the epoch ending and the agent being stopped -- stops the generation as well.
    res.on("close", () => {
      if (!res.writableFinished) stop("client disconnected");
    });

    let status = 502;
    let response: unknown = null;
    let contentType: string | undefined;
    let relayed = false;
    let error: string | undefined;
    try {
      const r = await fetchImpl(target, {
        method: "POST",
        headers,
        body: JSON.stringify(forwarded),
        signal: upstreamAbort.signal,
      });
      status = r.status;
      contentType = r.headers.get("content-type") ?? undefined;
      if (r.body && isStreamContentType(contentType)) {
        // Chunk by chunk as it arrives. Every chunk re-arms the idle timer: an answer that keeps
        // coming is never cut however long it runs, and one that stalls is.
        relayed = true;
        res.writeHead(status, { "content-type": contentType as string, "cache-control": "no-cache" });
        res.flushHeaders();
        const decoder = new TextDecoder();
        let text = "";
        let bytes = 0;
        try {
          const reader = r.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) {
              stop(`stream exceeded ${maxBytes} bytes`);
              throw new Error(stopReason);
            }
            arm(idleMs, `upstream stream went quiet for ${idleMs} ms`);
            text += decoder.decode(value, { stream: true });
            if (!res.destroyed && !res.write(value)) {
              // The agent reads slower than the model writes. Stop pulling until it catches up
              // rather than buffering the difference here -- and time the agent while waiting, not
              // the upstream, which is not the one that went quiet.
              arm(idleMs, `client stopped reading for ${idleMs} ms`);
              await new Promise<void>((resume) => {
                const go = (): void => {
                  res.off("drain", go);
                  res.off("close", go);
                  upstreamAbort.signal.removeEventListener("abort", go);
                  resume();
                };
                res.on("drain", go);
                res.on("close", go);
                upstreamAbort.signal.addEventListener("abort", go);
              });
              if (stopReason !== undefined) throw new Error(stopReason);
              arm(idleMs, `upstream stream went quiet for ${idleMs} ms`);
            }
          }
          text += decoder.decode();
        } finally {
          // Kept when the stream breaks off too: what the agent had already received is part of
          // what happened, and replay serves it back before breaking off the same way.
          response = text;
        }
      } else {
        const text = await r.text();
        try {
          response = JSON.parse(text);
        } catch {
          response = text;
        }
      }
    } catch (e) {
      error = stopReason ?? (e instanceof Error ? e.message : String(e));
      if (!relayed) {
        response = { error: `upstream failed: ${error}` };
        contentType = undefined;
        if (stopReason === "client disconnected") status = CLIENT_CLOSED;
      }
    } finally {
      clearTimeout(timer);
    }
    if (relayed) {
      // Headers are out, so a failure can no longer be a status: the stream is cut instead, which
      // is how the agent's client learns it is incomplete. Cut by ending the socket, not destroying
      // it: a destroy drops what was written and not yet sent, and the record says the agent got it.
      if (error === undefined) res.end();
      else if (res.socket && !res.socket.destroyed) res.socket.end();
      else res.destroy();
    }
    record({
      ts: new Date(started).toISOString(),
      agentId: who,
      seq: n,
      path: url.pathname,
      model,
      provider,
      durationMs: now() - started,
      status,
      request: body,
      response,
      ...(contentType ? { contentType } : {}),
      ...(relayed ? { stream: true } : {}),
      ...(error ? { error } : {}),
    });
    if (relayed) return;
    return send(res, status, response, contentType);
  });
}
