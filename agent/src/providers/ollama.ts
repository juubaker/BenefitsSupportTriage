import type {
  ChatRequest,
  ModelMessage,
  ProviderAdapter,
  ProviderTurn,
  StepUsage,
  ToolSpec,
} from "../types.js";

/**
 * Ollama /api/chat adapter. Streams NDJSON, accumulates text deltas and tool
 * calls, and maps prompt_eval_count/eval_count into the usage ledger.
 *
 * Notes:
 * - Ollama has no tool_use ids; synthetic ids are generated per call. The loop
 *   only uses ids for intra-turn correlation, so this is safe.
 * - Errors carry a `status` property so the registry's transient-retry logic
 *   and the harness failover classify them correctly.
 */

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

interface OllamaChunk {
  message?: {
    content?: string;
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export function toOllamaMessages(
  system: string,
  messages: ModelMessage[],
): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      const toolCalls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) =>
          b.type === "tool_use"
            ? { function: { name: b.name, arguments: (b.input ?? {}) as Record<string, unknown> } }
            : { function: { name: "", arguments: {} } },
        );
      out.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // user messages may contain tool_result blocks (loop results) and/or text (nudges)
    for (const b of m.content) {
      if (b.type === "tool_result") out.push({ role: "tool", content: b.content });
    }
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

function httpError(status: number, detail: string): Error {
  const err = new Error(`Ollama request failed (${status}): ${detail}`) as Error & {
    status: number;
  };
  err.status = status;
  return err;
}

export class OllamaProvider implements ProviderAdapter {
  readonly name = "ollama" as const;
  private ids = 0;

  constructor(
    readonly model: string = "llama3.1",
    private baseUrl: string = "http://localhost:11434",
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async chat(req: ChatRequest, onDelta?: (text: string) => void): Promise<ProviderTurn> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: req.signal,
      body: JSON.stringify({
        model: this.model,
        stream: true,
        messages: toOllamaMessages(req.system, req.messages),
        ...(req.tools.length > 0
          ? {
              tools: req.tools.map((t: ToolSpec) => ({
                type: "function",
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema,
                },
              })),
            }
          : {}),
        options: { temperature: req.temperature, num_predict: req.maxTokens },
      }),
    });

    if (!res.ok || !res.body) {
      throw httpError(res.status, await res.text().catch(() => res.statusText));
    }

    let text = "";
    const toolCalls: ProviderTurn["toolCalls"] = [];
    let doneReason = "stop";
    const usage: StepUsage = {
      provider: this.name,
      model: this.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const consume = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const chunk = JSON.parse(trimmed) as OllamaChunk;
      if (chunk.error) throw httpError(500, chunk.error);
      const delta = chunk.message?.content ?? "";
      if (delta) {
        text += delta;
        onDelta?.(delta);
      }
      for (const call of chunk.message?.tool_calls ?? []) {
        toolCalls.push({
          id: `ollama_${++this.ids}`,
          name: call.function.name,
          input: call.function.arguments ?? {},
        });
      }
      if (chunk.done) {
        doneReason = chunk.done_reason ?? "stop";
        usage.inputTokens = chunk.prompt_eval_count ?? 0;
        usage.outputTokens = chunk.eval_count ?? 0;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    consume(buffer);

    return {
      text,
      toolCalls,
      stopReason:
        toolCalls.length > 0
          ? "tool_use"
          : doneReason === "length"
            ? "max_tokens"
            : "end_turn",
      usage,
    };
  }
}
