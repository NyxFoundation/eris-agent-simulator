/**
 * llm.ts: a single bare LLM-call function (ADR 0015 §4; provider switching only).
 *
 * - ollama family (default): JSON mode (format:"json"). The Hermes JSON mode pattern used
 *   together with the system prompt's <schema> (NousResearch/Hermes-Function-Calling)
 * - claude family (model starts with "claude"): structured output via the Anthropic SDK's tool use
 * - openai-compatible family ("openai:<model>", or a model starting with gpt-/o1/o3/o4): chat
 *   completions with response_format json_object
 * - codex CLI (model "codex" or "codex:<model>"): spawns `codex exec` — runs on a ChatGPT
 *   subscription (codex login), no API key
 * - claude CLI (model "claude-cli" or "claude-cli:<model>"): spawns `claude -p` — runs on a
 *   Claude subscription (Claude Code OAuth login), no API key. The Agent SDK's query() hangs on
 *   nested-session detection when run inside a Claude Code session; `claude -p` does not (measured),
 *   which is why this spawns the CLI directly.
 *
 * Environment variables (same conventions as the old ollamaStrategist):
 *   ERIS_INFERENCE_BASE_URL  the operator's inference proxy (rules §2.3 / §2.5). When set, the
 *                            ollama / openai / anthropic families all go through it and no API key
 *                            is needed here: ERIS_INFERENCE_TOKEN (per agent, handed out by the
 *                            coordinator) and ERIS_AGENT_ID identify the caller
 *   ERIS_OLLAMA_BASE_URL  default https://ollama.com/api (local is http://127.0.0.1:11434/api)
 *   OPENAI_BASE_URL / OPENAI_API_KEY  the openai family without a proxy (default https://api.openai.com/v1)
 *   ERIS_OLLAMA_API_KEY / OLLAMA_API_KEY  Ollama Cloud Bearer token (not needed locally)
 *   ANTHROPIC_API_KEY     required for the claude family (SDK; ignored by claude-cli)
 *   ERIS_CLAUDE_BIN / ERIS_CODEX_BIN  CLI binary override (default "claude" / "codex")
 *   ERIS_LLM_CALL_TIMEOUT_MS  timeout for one call (default 300000: the five minutes a call may
 *                            wait at the operator's inference proxy)
 *   ERIS_LLM_MAX_OUTPUT_TOKENS  cap on the reply (prompt.md `maxOutputTokens` wins). Default 16000
 *                            for the claude family, whose API requires one; the model's own for
 *                            the ollama and openai families
 *   ERIS_LLM_CONTEXT_TOKENS  the ollama family's context window, `num_ctx` (prompt.md
 *                            `contextTokens` wins). Default 32768
 * The two token limits apply to the HTTP families only; the subscription CLIs set their own.
 */
import { spawn } from "node:child_process";

export type LlmMessage = { role: "user" | "assistant"; content: string };

export type LlmRequest = {
  model: string;
  system: string;
  messages: LlmMessage[];
  // JSON Schema of the action passed to claude-family tool use (unused for the ollama family = <schema> handles it).
  jsonSchema?: Record<string, unknown>;
  // false for a free-text response (e.g. prompt revision). Default true = JSON mode.
  json?: boolean;
  // Limits for this call, from prompt.md. Absent = ERIS_LLM_MAX_OUTPUT_TOKENS /
  // ERIS_LLM_CONTEXT_TOKENS, then the family's default (resolveLlmLimits).
  maxOutputTokens?: number;
  contextTokens?: number;
};

// What a call returned, with what the service said about it.
export type LlmReply = {
  text: string;
  // Tokens in and out, when the service reported them.
  usage?: { inputTokens?: number; outputTokens?: number };
  // What the call got away with but should not have -- today, an Ollama prompt that cannot have
  // fit its context. The reply is still used; the caller logs these.
  warnings: string[];
};

const DEFAULT_OLLAMA_BASE_URL = "https://ollama.com/api";
// One call's wait: five minutes, the most a call that is not streamed may wait at the operator's
// inference proxy (issue #166), and so the wait participants are told. It was 60 s (120 s for the
// CLIs) while a call returned one trading action; a whole strategy source takes minutes.
export const DEFAULT_CALL_TIMEOUT_MS = 300_000;
const CALL_TIMEOUT_MS = Number(
  process.env.ERIS_LLM_CALL_TIMEOUT_MS ?? DEFAULT_CALL_TIMEOUT_MS,
);

// Anthropic's API requires max_tokens, so for this family the runtime's number *is* the limit. It
// was 2,048 from when a call returned one trading action (the emit_action tool below). Since
// ADR 0018 a call returns a whole strategy source, which can be longer; the reply was then cut
// mid-code and discarded like any other rejected revision (issue #168). 16,000 fits a strategy
// with room to spare and sits inside the SDK's non-streaming bound (10 minutes at its estimate of
// 128k tokens an hour, ~21,333 tokens).
export const DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS = 16_000;
// Ollama's context window. Without one the service's default applies -- unpublished, liable to
// change -- and Ollama drops what does not fit without an error. It covers the reply as well as
// the prompt: a revision context is ~10k tokens today, and the strategy coming back needs room.
export const DEFAULT_OLLAMA_CONTEXT_TOKENS = 32_768;

export type LlmLimits = { maxOutputTokens?: number; contextTokens?: number };

function positiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  return n;
}

// The limits a call is made with: prompt.md, then the environment. A family default is applied
// where the call is built, because only there is it known which family needs one.
export function resolveLlmLimits(
  req: Pick<LlmRequest, "maxOutputTokens" | "contextTokens">,
  env: NodeJS.ProcessEnv = process.env,
): LlmLimits {
  return {
    maxOutputTokens:
      req.maxOutputTokens ??
      positiveInt(env.ERIS_LLM_MAX_OUTPUT_TOKENS, "ERIS_LLM_MAX_OUTPUT_TOKENS"),
    contextTokens:
      req.contextTokens ??
      positiveInt(env.ERIS_LLM_CONTEXT_TOKENS, "ERIS_LLM_CONTEXT_TOKENS"),
  };
}

// The reply reached its output cap and stopped. For a revision that means mid-code, which would
// then fail to parse or compile and be logged like any rejected revision -- when the fix is a
// number. So it is its own failure, naming the number.
export class LlmOutputTruncatedError extends Error {
  constructor(
    readonly tokens: number | undefined,
    readonly signal: string,
  ) {
    super(
      `output truncated at ${tokens ?? "?"} tokens (${signal}): raise maxOutputTokens in ` +
        "prompt.md, or ask for a shorter reply",
    );
    this.name = "LlmOutputTruncatedError";
  }
}

// A rough token count with one use: saying when a prompt cannot have fit. Four characters a token
// undercounts code, so the warning below comes late rather than falsely.
export function estimatePromptTokens(req: Pick<LlmRequest, "system" | "messages">): number {
  const chars =
    req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 4);
}

// Ollama truncates a prompt longer than num_ctx and says nothing. Its prompt_eval_count cannot say
// it either -- a reused KV cache lowers it too -- so the test is the prompt's size against the window.
export function ollamaInputWarning(
  estimatedTokens: number,
  numCtx: number,
  promptEvalCount: number | undefined,
): string | undefined {
  if (estimatedTokens <= numCtx) return undefined;
  return (
    `input truncated: the prompt is ~${estimatedTokens} tokens (at 4 characters a token) and ` +
    `num_ctx is ${numCtx}` +
    (promptEvalCount !== undefined ? `; Ollama evaluated ${promptEvalCount}` : "") +
    ". Ollama drops what does not fit without an error: raise contextTokens in prompt.md"
  );
}

export type LlmProvider =
  | { kind: "ollama" | "anthropic" | "openai" }
  | { kind: "codex" | "claude-cli"; model?: string };

// The operator's inference proxy, when the run has one. Every HTTP provider routes through it and
// authenticates with the per-agent token; the upstream key lives in the proxy, not here.
function inferenceBase(): string | undefined {
  const base = process.env.ERIS_INFERENCE_BASE_URL;
  return base && base.trim() !== "" ? base.trim().replace(/\/$/, "") : undefined;
}
function proxyHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = process.env.ERIS_INFERENCE_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const agentId = process.env.ERIS_AGENT_ID;
  if (agentId) headers["x-eris-agent"] = agentId;
  return headers;
}

// Model name → provider. "codex[:<model>]" / "claude-cli[:<model>]" select the subscription CLIs
// (an empty model defers to the CLI's own configured default). "claude..." selects the Anthropic SDK.
export function resolveLlmProvider(model: string): LlmProvider {
  for (const kind of ["codex", "claude-cli"] as const) {
    if (model === kind) return { kind };
    if (model.startsWith(`${kind}:`)) {
      const rest = model.slice(kind.length + 1).trim();
      return rest === "" ? { kind } : { kind, model: rest };
    }
  }
  if (model.startsWith("openai:")) return { kind: "openai" };
  // OpenAI's own names: gpt-<digit>... and the o-series. NOT gpt-oss, which is an open-weights
  // model served by Ollama and the default here.
  if (/^(gpt-\d|o[134](-|$))/.test(model)) return { kind: "openai" };
  if (model.startsWith("claude")) return { kind: "anthropic" };
  return { kind: "ollama" };
}

// "openai:<model>" is the explicit form; the bare model name goes upstream.
function openAiModelName(model: string): string {
  return model.startsWith("openai:") ? model.slice("openai:".length) : model;
}

// A single LLM call. Returns the response text (a JSON string is expected). Parsing/validation is the caller's job (bot.ts).
export async function callLlm(req: LlmRequest): Promise<string> {
  return (await callLlmWithUsage(req)).text;
}

// The same call, with what the service reported about it. Throws LlmOutputTruncatedError when the
// reply hit its output cap.
export async function callLlmWithUsage(req: LlmRequest): Promise<LlmReply> {
  const provider = resolveLlmProvider(req.model);
  if (provider.kind === "codex")
    return { text: await callCodexCli(provider.model, req), warnings: [] };
  if (provider.kind === "claude-cli")
    return { text: await callClaudeCli(provider.model, req), warnings: [] };
  const limits = resolveLlmLimits(req);
  if (provider.kind === "anthropic") return callClaude(req, limits);
  if (provider.kind === "openai") return callOpenAi(req, limits);
  return callOllama(req, limits);
}

async function callOpenAi(req: LlmRequest, limits: LlmLimits): Promise<LlmReply> {
  const proxy = inferenceBase();
  const base = proxy
    ? `${proxy}/v1`
    : (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (proxy) Object.assign(headers, proxyHeaders());
  else {
    const key = process.env.OPENAI_API_KEY;
    if (!key)
      throw new Error(
        "OPENAI_API_KEY is not set (or point the run at an inference proxy with ERIS_INFERENCE_BASE_URL)",
      );
    headers.authorization = `Bearer ${key}`;
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    body: JSON.stringify({
      model: openAiModelName(req.model),
      messages: [{ role: "system", content: req.system }, ...req.messages],
      ...(req.json === false ? {} : { response_format: { type: "json_object" } }),
      // OpenAI's current name for the cap: `max_tokens` is deprecated there and refused by the
      // o-series. Absent, the model's own maximum applies.
      ...(limits.maxOutputTokens !== undefined
        ? { max_completion_tokens: limits.maxOutputTokens }
        : {}),
    }),
  });
  if (!res.ok)
    throw new Error(`openai chat failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string | null };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length")
    throw new LlmOutputTruncatedError(
      data.usage?.completion_tokens ?? limits.maxOutputTokens,
      'openai finish_reason "length"',
    );
  const content = choice?.message?.content;
  if (typeof content !== "string" || content.trim() === "")
    throw new Error("openai chat returned empty content");
  return {
    text: content,
    usage: {
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
    },
    warnings: [],
  };
}

async function callOllama(req: LlmRequest, limits: LlmLimits): Promise<LlmReply> {
  const proxy = inferenceBase();
  const baseUrl = proxy
    ? `${proxy}/api`
    : (process.env.ERIS_OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL).replace(
        /\/$/,
        "",
      );
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (proxy) Object.assign(headers, proxyHeaders());
  else {
    const apiKey =
      process.env.ERIS_OLLAMA_API_KEY ?? process.env.OLLAMA_API_KEY ?? "";
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  }
  const numCtx = limits.contextTokens ?? DEFAULT_OLLAMA_CONTEXT_TOKENS;
  const res = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    body: JSON.stringify({
      model: req.model,
      stream: false,
      ...(req.json === false ? {} : { format: "json" }),
      messages: [{ role: "system", content: req.system }, ...req.messages],
      options: {
        num_ctx: numCtx,
        // Absent, Ollama generates until the model stops or the window is full.
        ...(limits.maxOutputTokens !== undefined
          ? { num_predict: limits.maxOutputTokens }
          : {}),
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`ollama chat failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    message?: { content?: string };
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  if (data.done_reason === "length")
    throw new LlmOutputTruncatedError(
      data.eval_count ?? limits.maxOutputTokens,
      'ollama done_reason "length"',
    );
  const content = data.message?.content;
  if (typeof content !== "string" || content.trim() === "")
    throw new Error("ollama chat returned empty content");
  const inputWarning = ollamaInputWarning(
    estimatePromptTokens(req),
    numCtx,
    data.prompt_eval_count,
  );
  return {
    text: content,
    usage: {
      inputTokens: data.prompt_eval_count,
      outputTokens: data.eval_count,
    },
    warnings: inputWarning ? [inputWarning] : [],
  };
}

// Memoize the Anthropic client (validation retries call it up to 4 times per cycle).
let anthropicClient: InstanceType<
  (typeof import("@anthropic-ai/sdk"))["default"]
> | null = null;

async function callClaude(req: LlmRequest, limits: LlmLimits): Promise<LlmReply> {
  // The Anthropic SDK is an optional dependency (don't load it in an environment that only uses the ollama family).
  if (!anthropicClient) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const proxy = inferenceBase();
    // The client carries this runtime's bound as its own timeout. Without one, the SDK estimates a
    // non-streamed call's length from max_tokens and refuses anything it expects to pass 10 minutes
    // (~21,333 tokens; 8,192 for Opus 4 / 4.1) with "Streaming is required" -- a participant raising
    // maxOutputTokens would meet that instead of the model's own limit. A call cannot outlast
    // CALL_TIMEOUT_MS either way.
    //
    // Through the proxy the SDK's x-api-key is meaningless (the proxy attaches the real one); the
    // per-agent bearer token in defaultHeaders is what authenticates. The SDK still insists on a
    // non-empty apiKey, so it gets the token.
    anthropicClient = proxy
      ? new Anthropic({
          baseURL: proxy,
          apiKey: process.env.ERIS_INFERENCE_TOKEN ?? "proxy",
          defaultHeaders: proxyHeaders(),
          timeout: CALL_TIMEOUT_MS,
        })
      : new Anthropic({ timeout: CALL_TIMEOUT_MS });
  }
  const client = anthropicClient;
  const useTool = req.jsonSchema !== undefined;
  const maxTokens = limits.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS;
  const response = await client.messages.create(
    {
      model: req.model,
      max_tokens: maxTokens,
      system: req.system,
      messages: req.messages,
      ...(useTool
        ? {
            tools: [
              {
                name: "emit_action",
                description:
                  "Emit exactly one trading action for this decision cycle.",
                input_schema: req.jsonSchema as never,
              },
            ],
            tool_choice: { type: "tool" as const, name: "emit_action" },
          }
        : {}),
    },
    { timeout: CALL_TIMEOUT_MS },
  );
  if (response.stop_reason === "max_tokens")
    throw new LlmOutputTruncatedError(
      response.usage?.output_tokens ?? maxTokens,
      'anthropic stop_reason "max_tokens"',
    );
  const usage = {
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
  };
  if (useTool) {
    const tool = response.content.find((c) => c.type === "tool_use");
    if (!tool || tool.type !== "tool_use")
      throw new Error("claude returned no tool_use block");
    return { text: JSON.stringify(tool.input), usage, warnings: [] };
  }
  const text = response.content.find((c) => c.type === "text");
  if (!text || text.type !== "text")
    throw new Error("claude returned no text block");
  return { text: text.text, usage, warnings: [] };
}

// ---------------------------------------------------------------------------
// Subscription CLI providers (codex exec / claude -p). Ported from the retired
// self-improvement strategists (_archive/llm/{codex,claude}CliStrategist.ts @ 4a65a8f)
// where both spawn contracts were proven live.
// ---------------------------------------------------------------------------

// Claude Code built-in tools are useless for emitting an action and waiting on tool use can hang
// print mode; disallow them all.
const CLAUDE_CLI_DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Read",
  "Write",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "SlashCommand",
  "TodoWrite",
  "BashOutput",
  "KillShell",
  "NotebookEdit",
];

// Markers of an enclosing Claude Code session; leaving them in makes `claude -p` detect nesting and hang.
function isNestedSessionMarker(key: string): boolean {
  return (
    key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE" || key === "AI_AGENT"
  );
}

// CLI calls are stateless one-shots; fold the validation-retry conversation into a single prompt.
export function flattenMessages(messages: LlmMessage[]): string {
  if (messages.length === 1) return messages[0].content;
  return messages
    .map((m) =>
      m.role === "assistant"
        ? `[your previous response]\n${m.content}`
        : `[user]\n${m.content}`,
    )
    .join("\n\n");
}

// Extract the first balanced JSON object from CLI output. Action JSON can contain braces/quotes
// inside strings, so scan with string/escape awareness instead of a regex.
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function buildClaudeCliArgs(
  model: string | undefined,
  system: string,
  prompt: string,
): string[] {
  return [
    "-p",
    prompt,
    ...(model ? ["--model", model] : []),
    "--permission-mode",
    "bypassPermissions",
    "--append-system-prompt",
    system,
    "--disallowed-tools",
    ...CLAUDE_CLI_DISALLOWED_TOOLS,
  ];
}

// codex has no --append-system-prompt; the caller folds system + user into the single prompt.
export function buildCodexCliArgs(
  model: string | undefined,
  prompt: string,
): string[] {
  return [
    "exec",
    prompt,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--color",
    "never",
    ...(model ? ["--model", model] : []),
  ];
}

// Spawn a CLI and resolve its stdout. Rejects on spawn failure, non-zero exit, or timeout.
export function runCli(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (result: string | Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const child = spawn(bin, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (e: Error) =>
      finish(new Error(`spawn ${bin} failed: ${e.message}`)),
    );
    child.on("close", (code: number | null) => {
      if (code !== 0)
        return finish(new Error(`${bin} exited ${code}: ${err.slice(0, 200)}`));
      finish(out);
    });
  });
}

// For JSON-mode requests, pull the first JSON object out of the CLI's chatter (banners, prose)
// so bot.ts's JSON.parse sees a clean object. Free-text requests (json:false) pass through as-is.
function postProcessCliOutput(
  bin: string,
  out: string,
  req: LlmRequest,
): string {
  if (req.json === false) return out.trim();
  const json = extractJsonObject(out);
  if (json === null)
    throw new Error(`no JSON object in ${bin} output: ${out.slice(0, 200)}`);
  return JSON.stringify(json);
}

async function callClaudeCli(
  model: string | undefined,
  req: LlmRequest,
): Promise<string> {
  const bin = process.env.ERIS_CLAUDE_BIN ?? "claude";
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (isNestedSessionMarker(key)) delete env[key];
  }
  // Bill the subscription (OAuth login), never the API key — that is this provider's whole point.
  delete env.ANTHROPIC_API_KEY;
  const args = buildClaudeCliArgs(
    model,
    req.system,
    flattenMessages(req.messages),
  );
  const out = await runCli(bin, args, env, CALL_TIMEOUT_MS);
  return postProcessCliOutput(bin, out, req);
}

async function callCodexCli(
  model: string | undefined,
  req: LlmRequest,
): Promise<string> {
  const bin = process.env.ERIS_CODEX_BIN ?? "codex";
  const prompt = `${req.system}\n\n---\n\n${flattenMessages(req.messages)}`;
  const args = buildCodexCliArgs(model, prompt);
  const out = await runCli(bin, args, { ...process.env }, CALL_TIMEOUT_MS);
  return postProcessCliOutput(bin, out, req);
}
