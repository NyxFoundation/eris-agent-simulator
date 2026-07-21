/**
 * llm.ts: a single bare LLM-call function (ADR 0015 §4; provider switching only).
 *
 * - ollama family (default): JSON mode (format:"json"). The Hermes JSON mode pattern used
 *   together with the system prompt's <schema> (NousResearch/Hermes-Function-Calling)
 * - claude family (model starts with "claude"): structured output via the Anthropic SDK's tool use
 * - codex CLI (model "codex" or "codex:<model>"): spawns `codex exec` — runs on a ChatGPT
 *   subscription (codex login), no API key
 * - claude CLI (model "claude-cli" or "claude-cli:<model>"): spawns `claude -p` — runs on a
 *   Claude subscription (Claude Code OAuth login), no API key. The Agent SDK's query() hangs on
 *   nested-session detection when run inside a Claude Code session; `claude -p` does not (measured),
 *   which is why this spawns the CLI directly.
 *
 * Environment variables (same conventions as the old ollamaStrategist):
 *   ERIS_OLLAMA_BASE_URL  default https://ollama.com/api (local is http://127.0.0.1:11434/api)
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
  | { kind: "ollama" | "anthropic" }
  | { kind: "codex" | "claude-cli"; model?: string };

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
  if (model.startsWith("claude")) return { kind: "anthropic" };
  return { kind: "ollama" };
}

// A single LLM call. Returns the response text (a JSON string is expected). Parsing/validation is the caller's job (bot.ts).
export async function callLlm(req: LlmRequest): Promise<string> {
  const provider = resolveLlmProvider(req.model);
  if (provider.kind === "codex") return callCodexCli(provider.model, req);
  if (provider.kind === "claude-cli") return callClaudeCli(provider.model, req);
  if (provider.kind === "anthropic") return callClaude(req);
  return callOllama(req);
}

async function callOllama(req: LlmRequest): Promise<string> {
  const baseUrl = (
    process.env.ERIS_OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL
  ).replace(/\/$/, "");
  const apiKey =
    process.env.ERIS_OLLAMA_API_KEY ?? process.env.OLLAMA_API_KEY ?? "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
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
    anthropicClient = new Anthropic();
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
