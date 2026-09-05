// The inference proxy: the one door between an agent and a model (rules §2.3 "external
// communication", §2.5; ADR 0022 task 3 / memory inference-proxy-design).
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
  // Upstream timeout per call.
  upstreamTimeoutMs?: number;
};

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
  response: unknown;
  error?: string;
  replayed?: boolean;
};

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
  return {
    models: d.models,
    maxCallsPerMinute: d.maxCallsPerMinute ?? 0,
    upstreamTimeoutMs: d.upstreamTimeoutMs ?? 120_000,
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

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
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
    if (body.stream === true)
      return send(res, 400, {
        error: "streaming is not supported: every exchange is recorded whole (rules §2.4)",
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
      return send(res, rec.status, rec.response);
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

    let status = 502;
    let response: unknown = null;
    let error: string | undefined;
    try {
      const r = await fetchImpl(target, {
        method: "POST",
        headers,
        body: JSON.stringify(forwarded),
        signal: AbortSignal.timeout(config.upstreamTimeoutMs ?? 120_000),
      });
      status = r.status;
      const text = await r.text();
      try {
        response = JSON.parse(text);
      } catch {
        response = text;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      response = { error: `upstream failed: ${error}` };
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
      ...(error ? { error } : {}),
    });
    return send(res, status, response);
  });
}
