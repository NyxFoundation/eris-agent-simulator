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
// The record is bounded and its failure is not the proxy's (issue #215). This proxy is the only
// outbound path an agent has in the official competition, so a disk that fills or a write that
// fails must cost the record, never the call: a record that cannot be written is reported on stderr
// and counted, and the call is served regardless. One call's record is bounded only by the request
// (4 MiB) and the response (`maxStreamBytes`), so at `maxCallsPerMinute` 30 one agent could write
// about a gibibyte a minute; `maxRecordBytesPerAgent` and `maxRecordBytesTotal` stop recording the
// bodies -- not serving -- past a cumulative size, and the agent's file gets a line that says so
// (`event: "recording_capped"`).
//
// Past that cap a call still leaves a line (issue #218). Writing nothing there had put §2.4's audit
// up for sale: 4 MiB of messages 64 times is the 256 MiB per-agent default -- two minutes at
// `maxCallsPerMinute` 30 -- and every revision after it was served with no trace that it happened.
// "My calls are not in the record" is not something padding may buy. So the cap drops the bodies and
// not the call: a stub of fixed size keeps when, which path, which model, the status, and each body's
// length and sha256 (`truncated: true`), which is what it takes to say that a call was made and to
// check a kept copy against it. A stub is ~400 bytes against a 4 MiB record, so the cap still cuts
// the write rate by four orders of magnitude; what it no longer cuts is the evidence. Replay reads
// stubs too and answers 409 at one, rather than serving the next call's answer in its place.
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

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
  // Cumulative size of what is written under recordDir, per agent and for the whole proxy process,
  // past which that agent's (or everyone's) calls are still served but no longer recorded. Defaults
  // to MAX_RECORD_BYTES_PER_AGENT / MAX_RECORD_BYTES_TOTAL; neither can be unlimited.
  maxRecordBytesPerAgent?: number;
  maxRecordBytesTotal?: number;
};

// The wait participants are told a call may take (issue #166): five minutes.
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 300_000;
// 32 MiB: far beyond any answer a model gives, and eight times the cap on a request body.
export const MAX_STREAM_BYTES = 32 * 1024 * 1024;
// 256 MiB per agent: at the reference runtime's ~10k-token context and a whole-strategy reply, a
// record is tens of KiB, so this is thousands of revisions -- a week of them at the default cadence.
// 8 GiB for the process: a few hundred agents at the tens of MiB a week of revising actually costs
// one. It is not the per-agent ceiling times a field -- 8 GiB is 32 agents at 256 MiB -- so the first
// 32 agents to reach their own ceiling spend everyone's: an operator who wants the per-agent cap to
// be the only one that ever binds sets the total to it times the size of the field. What the shared
// ceiling costs the rest is their bodies, not their calls, which keep leaving stubs (issue #218).
// Both are ceilings on an accident, not budgets to fill.
export const MAX_RECORD_BYTES_PER_AGENT = 256 * 1024 * 1024;
export const MAX_RECORD_BYTES_TOTAL = 8 * 1024 * 1024 * 1024;

export type ProxyOptions = {
  config: ProxyConfig;
  // HMAC secret shared with the coordinator. Absent = no authentication (single-operator local use).
  secret?: string;
  recordDir?: string;
  replayDir?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  // Where what an agent cannot see is reported: a record that was not written, a cap reached, a
  // handler that threw. Defaults to this process's stderr.
  log?: (line: string) => void;
  // The operator's token for GET /admin/recording. Absent = that path does not exist. It is not an
  // agent token and must not be derived from `secret`: agents hold HMAC(secret, their own id).
  statsToken?: string;
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

// The line that ends an agent's file when recording stops for it (issue #215). Every call after it
// was served and not recorded. Replay skips it, then answers 409 at the first call it has no record
// for -- the same honest divergence as a run that asks for more calls than were recorded.
export type RecordingNote = {
  ts: string;
  agentId: string;
  event: "recording_capped";
  // "agent": this agent's own cap. "total": the proxy's, reached by everyone together.
  scope: "agent" | "total";
  recordedBytes: number;
  cap: number;
  // The first call that went unrecorded.
  seq: number;
};

// What a call leaves once recording is capped for its agent (issue #218): the same identity and
// outcome a record has, with each body replaced by its length and digest. Keeping nothing here would
// have let an agent pad requests until the cap and then revise unrecorded, so the cap takes the
// bodies and leaves the fact. The digests are of the JSON the record would have held (`JSON.stringify`
// of its `request` / `response` field), so a kept copy is checked against a stub exactly as it would
// be against a full record. Every field is bounded, so the line's size does not follow the request's.
export type TruncatedCall = {
  ts: string;
  agentId: string;
  seq: number;
  path: string;
  model: string;
  provider: Provider;
  durationMs: number;
  status: number;
  // The discriminator: this line records that a call happened, not what was said.
  truncated: true;
  requestBytes: number;
  requestSha256: string;
  responseBytes: number;
  responseSha256: string;
  contentType?: string;
  stream?: boolean;
  error?: string;
  replayed?: boolean;
};

// What the recording stats say. They are not on /healthz (issue #218): this proxy joins every agent's
// network -- that is what lets an agent with no route out reach a model -- so every agent can reach
// every unauthenticated path on it, and `calls` or `cappedAgents` there reads out how often the rest
// of the field is revising. They sit behind the operator's own token instead. No per-agent breakdown
// even there: the operator has the files.
export type RecordingStats = {
  enabled: boolean;
  bytes: number;
  calls: number;
  // Records that could not be written (the calls were served).
  failures: number;
  cappedAgents: number;
  totalCapped: boolean;
  // Calls kept as a stub because recording was capped, and what those stubs cost.
  truncatedCalls: number;
  truncatedBytes: number;
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

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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
  for (const key of [
    "upstreamTimeoutMs",
    "streamIdleTimeoutMs",
    "maxStreamBytes",
    "maxRecordBytesPerAgent",
    "maxRecordBytesTotal",
  ] as const) {
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
    maxRecordBytesPerAgent: d.maxRecordBytesPerAgent ?? MAX_RECORD_BYTES_PER_AGENT,
    maxRecordBytesTotal: d.maxRecordBytesTotal ?? MAX_RECORD_BYTES_TOTAL,
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
  private readonly queues = new Map<string, (RecordedCall | TruncatedCall)[]>();
  constructor(private readonly dir: string) {}
  next(agentId: string): RecordedCall | TruncatedCall | undefined {
    let q = this.queues.get(agentId);
    if (!q) {
      const path = join(this.dir, `${agentId}.jsonl`);
      q = existsSync(path)
        ? readFileSync(path, "utf8")
            .split("\n")
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as RecordedCall | RecordingNote | TruncatedCall)
            // The note marking where the bodies stopped is not a call; the stubs after it are. They
            // stay in the queue so the call numbers keep lining up with the live run's, and each one
            // answers 409 instead of letting a later call's answer stand in for one not kept.
            .filter((r): r is RecordedCall | TruncatedCall => !("event" in r))
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
  const log =
    opts.log ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  if (opts.recordDir) mkdirSync(opts.recordDir, { recursive: true });

  // ---- the record (issue #215) ----
  // Bytes written per agent and in all, over this process's life; which agents are no longer
  // recorded; and what went wrong, counted for /healthz and said once on stderr.
  const perAgentCap = config.maxRecordBytesPerAgent ?? MAX_RECORD_BYTES_PER_AGENT;
  const totalCap = config.maxRecordBytesTotal ?? MAX_RECORD_BYTES_TOTAL;
  const recordedBytes = new Map<string, number>();
  const capped = new Set<string>();
  const lastFailure = new Map<string, string>();
  let totalBytes = 0;
  let totalCapped = false;
  let recordedCalls = 0;
  let recordFailures = 0;
  let handlerErrors = 0;
  let truncatedCalls = 0;
  let truncatedBytes = 0;
  const stats = (): RecordingStats => ({
    enabled: opts.recordDir !== undefined,
    bytes: totalBytes,
    calls: recordedCalls,
    failures: recordFailures,
    cappedAgents: capped.size,
    totalCapped,
    truncatedCalls,
    truncatedBytes,
  });

  // The one place a record touches the disk. A failure is this call's record lost, reported and
  // counted; it is never the proxy's exit (it used to be: an async handler's throw is an unhandled
  // rejection, and Node exits on those). A full disk fails every call the same way, so stderr gets
  // one line per agent per distinct message and the count lives on /healthz.
  const append = (agentId: string, line: string): boolean => {
    try {
      appendFileSync(join(opts.recordDir!, `${agentId}.jsonl`), line);
      return true;
    } catch (error) {
      recordFailures++;
      const message = error instanceof Error ? error.message : String(error);
      if (lastFailure.get(agentId) !== message) {
        lastFailure.set(agentId, message);
        log(
          `[inference-proxy] record for ${agentId} not written (the call was served): ${message}`,
        );
      }
      return false;
    }
  };

  // Stop recording an agent and say so, in its file and on stderr. The note's own bytes are not
  // counted: it is one bounded line per agent, and it is the line that explains the gap after it.
  const stopRecording = (agentId: string, scope: RecordingNote["scope"], seq: number): void => {
    capped.add(agentId);
    const note: RecordingNote = {
      ts: new Date(now()).toISOString(),
      agentId,
      event: "recording_capped",
      scope,
      recordedBytes: scope === "agent" ? (recordedBytes.get(agentId) ?? 0) : totalBytes,
      cap: scope === "agent" ? perAgentCap : totalCap,
      seq,
    };
    append(agentId, `${JSON.stringify(note)}\n`);
    log(
      `[inference-proxy] recording stopped for ${agentId} at call #${seq}: ` +
        (scope === "agent"
          ? `its ${perAgentCap} bytes (maxRecordBytesPerAgent) are used up`
          : `the proxy's ${totalCap} bytes (maxRecordBytesTotal) are used up`) +
        `; its calls are still served`,
    );
  };

  // What a call leaves once the bodies have stopped (issue #218). Every field is bounded, so no
  // request makes this line longer, and the ~400 bytes it costs is what §2.4 needs to say that this
  // agent made this call at this time against this model, and to check a kept copy of it by digest.
  const appendStub = (entry: RecordedCall): void => {
    // The same text the record's own `request` / `response` field would have held, so a full line and
    // a stub are verified against a kept copy the same way.
    const request = JSON.stringify(entry.request ?? null);
    const response = JSON.stringify(entry.response ?? null);
    const stub: TruncatedCall = {
      ts: entry.ts,
      agentId: entry.agentId,
      seq: entry.seq,
      path: entry.path,
      model: entry.model,
      provider: entry.provider,
      durationMs: entry.durationMs,
      status: entry.status,
      truncated: true,
      requestBytes: Buffer.byteLength(request),
      requestSha256: sha256(request),
      responseBytes: Buffer.byteLength(response),
      responseSha256: sha256(response),
      ...(entry.contentType ? { contentType: entry.contentType } : {}),
      ...(entry.stream ? { stream: true } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.replayed ? { replayed: true } : {}),
    };
    const line = `${JSON.stringify(stub)}\n`;
    if (!append(entry.agentId, line)) return;
    truncatedBytes += Buffer.byteLength(line);
    truncatedCalls++;
  };

  const record = (entry: RecordedCall): void => {
    if (!opts.recordDir) return;
    // Past a cap the bodies stop and the stub takes over -- including for the very call that reached
    // the cap, which would otherwise be the one call with no trace at all. The stubs' own bytes are
    // not counted against either cap: a cap on them would reopen, one level down, the hole they
    // close, and they cannot be grown on purpose.
    if (capped.has(entry.agentId)) return appendStub(entry);
    const line = `${JSON.stringify(entry)}\n`;
    const bytes = Buffer.byteLength(line);
    if (totalCapped || totalBytes + bytes > totalCap) {
      totalCapped = true;
      stopRecording(entry.agentId, "total", entry.seq);
      return appendStub(entry);
    }
    const mine = recordedBytes.get(entry.agentId) ?? 0;
    if (mine + bytes > perAgentCap) {
      stopRecording(entry.agentId, "agent", entry.seq);
      return appendStub(entry);
    }
    if (!append(entry.agentId, line)) return;
    recordedBytes.set(entry.agentId, mine + bytes);
    totalBytes += bytes;
    recordedCalls++;
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://proxy");
    // Liveness, and only that (issue #218). Every agent can reach this proxy, so anything counted
    // here is counted for the whole field to read.
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
    // The recording stats, for whoever runs the proxy. Behind the operator's own token, and absent
    // that token the path does not exist at all, so the default surface an agent sees is `{ok}`.
    if (req.method === "GET" && url.pathname === "/admin/recording") {
      if (!opts.statsToken) return send(res, 404, { error: "path not allowed" });
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token || !safeEqual(token, opts.statsToken))
        return send(res, 401, {
          error: "unauthorized: the operator's stats token is required (ERIS_INFERENCE_STATS_TOKEN)",
        });
      return send(res, 200, { ok: true, recording: stats(), handlerErrors });
    }
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
      // The record has this call but not its text: it was made after recording was capped. Serving
      // the next recorded answer in its place would make the whole replay quietly wrong, so it stops
      // here and hands over what the record does hold.
      if ("truncated" in rec)
        return send(res, 409, {
          error:
            `replay has no body for call #${n} of ${who}: recording was capped before it, so the ` +
            `record keeps its size and digest and not its text`,
          truncated: true,
          seq: rec.seq,
          status: rec.status,
          requestBytes: rec.requestBytes,
          requestSha256: rec.requestSha256,
          responseBytes: rec.responseBytes,
          responseSha256: rec.responseSha256,
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
  };

  return http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // A bug on one call is that call's 500, not an unhandled rejection that takes the process --
      // and with it every agent's only path to a model -- down.
      handlerErrors++;
      log(
        `[inference-proxy] ${req.method ?? "?"} ${req.url ?? "?"} from ` +
          `${String(req.headers["x-eris-agent"] ?? "anonymous")} failed in the proxy: ` +
          (error instanceof Error ? (error.stack ?? error.message) : String(error)),
      );
      if (!res.headersSent) send(res, 500, { error: "proxy internal error" });
      else res.destroy();
    });
  });
}
