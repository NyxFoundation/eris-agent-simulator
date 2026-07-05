/**
 * llm.ts: a single bare LLM-call function (ADR 0015 §4; provider switching only).
 *
 * - ollama family (default): JSON mode (format:"json"). The Hermes JSON mode pattern used
 *   together with the system prompt's <schema> (NousResearch/Hermes-Function-Calling)
 * - claude family (model starts with "claude"): structured output via the Anthropic SDK's tool use
 *
 * Environment variables (same conventions as the old ollamaStrategist):
 *   ERIS_OLLAMA_BASE_URL  default https://ollama.com/api (local is http://127.0.0.1:11434/api)
 *   ERIS_OLLAMA_API_KEY / OLLAMA_API_KEY  Ollama Cloud Bearer token (not needed locally)
 *   ANTHROPIC_API_KEY     required for the claude family
 *   ERIS_LLM_CALL_TIMEOUT_MS  timeout for one call (default 60000)
 */
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

// A single LLM call. Returns the response text (a JSON string is expected). Parsing/validation is the caller's job (bot.ts).
export async function callLlm(req: LlmRequest): Promise<string> {
  if (req.model.startsWith("claude")) return callClaude(req);
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
