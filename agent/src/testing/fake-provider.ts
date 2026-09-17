import type {
  ChatRequest,
  ProviderAdapter,
  ProviderName,
  ProviderTurn,
} from "../types.js";

export interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ name: string; input: unknown }>;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Assert on the request the loop actually sent for this turn. */
  expect?: (req: ChatRequest) => void;
  throwError?: Error;
}

/**
 * Replays canned turns so the loop's mechanics are testable with no model
 * (spec §13). Records every ChatRequest it receives for later assertions.
 */
export class FakeProvider implements ProviderAdapter {
  readonly name: ProviderName;
  readonly model = "fake-model";
  readonly requests: ChatRequest[] = [];
  private cursor = 0;
  private ids = 0;

  constructor(private turns: ScriptedTurn[], name: ProviderName = "ollama") {
    this.name = name;
  }

  async chat(req: ChatRequest, onDelta?: (t: string) => void): Promise<ProviderTurn> {
    this.requests.push(req);
    const turn = this.turns[this.cursor++];
    if (!turn) throw new Error(`FakeProvider exhausted after ${this.turns.length} turns`);
    turn.expect?.(req);
    if (turn.throwError) throw turn.throwError;

    const text = turn.text ?? "";
    if (text && onDelta) for (const chunk of text.match(/.{1,12}/gs) ?? []) onDelta(chunk);

    const toolCalls = (turn.toolCalls ?? []).map((c) => ({
      id: `toolu_${++this.ids}`,
      name: c.name,
      input: c.input,
    }));

    return {
      text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      usage: {
        provider: this.name,
        model: this.model,
        inputTokens: turn.usage?.inputTokens ?? 500,
        outputTokens: turn.usage?.outputTokens ?? 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }
}
