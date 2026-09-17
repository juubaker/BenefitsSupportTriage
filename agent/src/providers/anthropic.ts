import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatRequest,
  ModelMessage,
  ProviderAdapter,
  ProviderTurn,
  ToolSpec,
} from "../types.js";

/**
 * Anthropic Messages API adapter (spec §5 provider abstraction, §6 caching).
 *
 * Prompt caching: the system prompt and the tool list get cache_control
 * breakpoints. The loop keeps both byte-stable across steps within a run, so
 * steps 2..N read the prefix from cache — cache hit rate lands in token_ledger
 * via cacheReadTokens/cacheWriteTokens.
 */

export function toAnthropicMessages(
  messages: ModelMessage[],
): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b): Anthropic.ContentBlockParam => {
      switch (b.type) {
        case "text":
          return { type: "text", text: b.text };
        case "tool_use":
          return {
            type: "tool_use",
            id: b.id,
            name: b.name,
            input: (b.input ?? {}) as Record<string, unknown>,
          };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: b.toolUseId,
            content: b.content,
            is_error: b.isError ?? false,
          };
      }
    }),
  }));
}

export function toAnthropicTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    // Breakpoint on the LAST tool caches the whole tool-definition prefix.
    ...(i === tools.length - 1
      ? { cache_control: { type: "ephemeral" as const } }
      : {}),
  }));
}

export class AnthropicProvider implements ProviderAdapter {
  readonly name = "anthropic" as const;
  private client: Anthropic;

  constructor(
    readonly model: string = "claude-sonnet-4-6",
    client?: Anthropic,
  ) {
    // Reads ANTHROPIC_API_KEY from the environment by default.
    this.client = client ?? new Anthropic();
  }

  async chat(req: ChatRequest, onDelta?: (text: string) => void): Promise<ProviderTurn> {
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        system: [
          {
            type: "text",
            text: req.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: toAnthropicMessages(req.messages),
        ...(req.tools.length > 0 ? { tools: toAnthropicTools(req.tools) } : {}),
      },
      { signal: req.signal },
    );

    if (onDelta) stream.on("text", onDelta);
    const msg = await stream.finalMessage();

    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolCalls = msg.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    return {
      text,
      toolCalls,
      stopReason:
        msg.stop_reason === "tool_use"
          ? "tool_use"
          : msg.stop_reason === "max_tokens"
            ? "max_tokens"
            : "end_turn",
      usage: {
        provider: this.name,
        model: this.model,
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
