/**
 * llm.ts: 素の LLM 呼び出し 1 関数（ADR 0015 §4。プロバイダ切替のみ）。
 *
 * - ollama 系（既定）: JSON mode（format:"json"）。system prompt の <schema> と併用する
 *   Hermes JSON mode パターン（NousResearch/Hermes-Function-Calling）
 * - claude 系（model が "claude" で始まる）: Anthropic SDK の tool use で structured output
 *
 * 環境変数（旧 ollamaStrategist と同じ慣習）:
 *   ERIS_OLLAMA_BASE_URL  既定 https://ollama.com/api（ローカルは http://127.0.0.1:11434/api）
 *   ERIS_OLLAMA_API_KEY / OLLAMA_API_KEY  Ollama Cloud の Bearer トークン（ローカルは不要）
 *   ANTHROPIC_API_KEY     claude 系のとき必須
 *   ERIS_LLM_CALL_TIMEOUT_MS  1 呼び出しのタイムアウト（既定 60000）
 */
export type LlmMessage = { role: "user" | "assistant"; content: string };

export type LlmRequest = {
  model: string;
  system: string;
  messages: LlmMessage[];
  // claude 系 tool use に渡す action の JSON Schema（ollama 系では未使用 = <schema> が担う）。
  jsonSchema?: Record<string, unknown>;
};

const DEFAULT_OLLAMA_BASE_URL = "https://ollama.com/api";
const CALL_TIMEOUT_MS = Number(process.env.ERIS_LLM_CALL_TIMEOUT_MS ?? "60000");

// 1 回の LLM 呼び出し。応答テキスト（JSON 文字列を期待）を返す。パース/検証は呼び側（bot.ts）。
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
      format: "json",
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

// Anthropic client は memo 化（validate 再試行で 1 サイクル最大 4 回呼ぶため）。
let anthropicClient: InstanceType<
  (typeof import("@anthropic-ai/sdk"))["default"]
> | null = null;

async function callClaude(req: LlmRequest): Promise<string> {
  // Anthropic SDK は optional 依存（ollama 系だけ使う環境でロードさせない）。
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
