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
 *   ERIS_LLM_CALL_TIMEOUT_MS  timeout for one call (default 60000; CLI providers 120000)
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
};

const DEFAULT_OLLAMA_BASE_URL = "https://ollama.com/api";
const CALL_TIMEOUT_MS = Number(process.env.ERIS_LLM_CALL_TIMEOUT_MS ?? "60000");
// CLI providers pay process startup + a coding-tuned model per call; give them more headroom by default.
const CLI_CALL_TIMEOUT_MS = Number(
  process.env.ERIS_LLM_CALL_TIMEOUT_MS ?? "120000",
);

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
  const provider = resolveLlmProvider(req.model);
  if (provider.kind === "codex") return callCodexCli(provider.model, req);
  if (provider.kind === "claude-cli") return callClaudeCli(provider.model, req);
  if (provider.kind === "anthropic") return callClaude(req);
  if (provider.kind === "openai") return callOpenAi(req);
  return callOllama(req);
}

async function callOpenAi(req: LlmRequest): Promise<string> {
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
    }),
  });
  if (!res.ok)
    throw new Error(`openai chat failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "")
    throw new Error("openai chat returned empty content");
  return content;
}

async function callOllama(req: LlmRequest): Promise<string> {
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
  const res = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    body: JSON.stringify({
      model: req.model,
      stream: false,
      ...(req.json === false ? {} : { format: "json" }),
      messages: [{ role: "system", content: req.system }, ...req.messages],
    }),
  });
  if (!res.ok) {
    throw new Error(`ollama chat failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content;
  if (typeof content !== "string" || content.trim() === "")
    throw new Error("ollama chat returned empty content");
  return content;
}

// Memoize the Anthropic client (validation retries call it up to 4 times per cycle).
let anthropicClient: InstanceType<
  (typeof import("@anthropic-ai/sdk"))["default"]
> | null = null;

async function callClaude(req: LlmRequest): Promise<string> {
  // The Anthropic SDK is an optional dependency (don't load it in an environment that only uses the ollama family).
  if (!anthropicClient) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const proxy = inferenceBase();
    // Through the proxy the SDK's x-api-key is meaningless (the proxy attaches the real one); the
    // per-agent bearer token in defaultHeaders is what authenticates. The SDK still insists on a
    // non-empty apiKey, so it gets the token.
    anthropicClient = proxy
      ? new Anthropic({
          baseURL: proxy,
          apiKey: process.env.ERIS_INFERENCE_TOKEN ?? "proxy",
          defaultHeaders: proxyHeaders(),
        })
      : new Anthropic();
  }
  const client = anthropicClient;
  const useTool = req.jsonSchema !== undefined;
  const response = await client.messages.create(
    {
      model: req.model,
      max_tokens: 2048,
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
  if (useTool) {
    const tool = response.content.find((c) => c.type === "tool_use");
    if (!tool || tool.type !== "tool_use")
      throw new Error("claude returned no tool_use block");
    return JSON.stringify(tool.input);
  }
  const text = response.content.find((c) => c.type === "text");
  if (!text || text.type !== "text")
    throw new Error("claude returned no text block");
  return text.text;
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
  const out = await runCli(bin, args, env, CLI_CALL_TIMEOUT_MS);
  return postProcessCliOutput(bin, out, req);
}

async function callCodexCli(
  model: string | undefined,
  req: LlmRequest,
): Promise<string> {
  const bin = process.env.ERIS_CODEX_BIN ?? "codex";
  const prompt = `${req.system}\n\n---\n\n${flattenMessages(req.messages)}`;
  const args = buildCodexCliArgs(model, prompt);
  const out = await runCli(bin, args, { ...process.env }, CLI_CALL_TIMEOUT_MS);
  return postProcessCliOutput(bin, out, req);
}
