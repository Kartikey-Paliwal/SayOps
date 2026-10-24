/**
 * Minimal structured-output LLM call. Groq exposes an OpenAI-compatible API, so this
 * is plain fetch with no SDK. Tests pass a fake `JsonLlm` instead.
 */
export interface LlmRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
}

export interface LlmResponse {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export type JsonLlm = (req: LlmRequest) => Promise<LlmResponse>;

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterS?: number,
    /** provider error code, e.g. "json_validate_failed" when output was truncated or off-schema */
    readonly code?: string,
  ) {
    super(message);
  }
}

export function groq(opts: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: "low" | "medium" | "high";
  /** includes reasoning tokens; keep prompt + this under the free tier's 8K tokens/minute */
  maxCompletionTokens?: number;
}): JsonLlm {
  const model = opts.model ?? "openai/gpt-oss-120b";
  const url = `${opts.baseUrl ?? "https://api.groq.com/openai/v1"}/chat/completions`;

  return async ({ system, user, schemaName, schema }) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        reasoning_effort: opts.reasoningEffort ?? "low",
        max_completion_tokens: opts.maxCompletionTokens ?? 5500,
        include_reasoning: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let message = body.slice(0, 300);
      let code: string | undefined;
      try {
        const err = (JSON.parse(body) as { error?: { message?: string; code?: string } }).error;
        message = err?.message?.slice(0, 300) ?? message;
        code = err?.code;
      } catch { /* not JSON */ }
      const retry = Number(res.headers.get("retry-after")) || undefined;
      throw new LlmError(`LLM ${res.status}: ${message}`, res.status, retry, code);
    }
    const data = (await res.json()) as {
      model: string;
      choices: { message: { content: string | null } }[];
      usage?: LlmResponse["usage"];
    };
    const content = data.choices[0]?.message.content;
    if (!content) throw new LlmError("LLM returned an empty message");
    return { content, model: data.model, usage: data.usage };
  };
}
