import { describe, expect, it } from "vitest";
import { toAnthropicMessages, toAnthropicTools } from "../src/providers/anthropic.js";
import { OllamaProvider, toOllamaMessages } from "../src/providers/ollama.js";
import { buildProviders } from "../src/providers/index.js";
import type { ChatRequest, ModelMessage } from "../src/types.js";

const HISTORY: ModelMessage[] = [
  { role: "user", content: [{ type: "text", text: "Triage this ticket." }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Searching." },
      { type: "tool_use", id: "toolu_1", name: "search_policies", input: { query: "QLE", k: 5 } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", toolUseId: "toolu_1", content: '[{"chunkId":"c1"}]' },
      { type: "text", text: "Refine your query." },
    ],
  },
];

const CHAT_REQ: ChatRequest = {
  system: "sys",
  messages: HISTORY,
  tools: [
    { name: "search_policies", description: "search", inputSchema: { type: "object" } },
    { name: "triage_ticket", description: "final", inputSchema: { type: "object" } },
  ],
  temperature: 0.2,
  maxTokens: 500,
};

describe("anthropic mapping", () => {
  it("maps blocks 1:1 and preserves ids and error flags", () => {
    const msgs = toAnthropicMessages(HISTORY);
    expect(msgs[1].content).toEqual([
      { type: "text", text: "Searching." },
      { type: "tool_use", id: "toolu_1", name: "search_policies", input: { query: "QLE", k: 5 } },
    ]);
    expect(msgs[2].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: '[{"chunkId":"c1"}]', is_error: false },
      { type: "text", text: "Refine your query." },
    ]);
  });

  it("puts the cache_control breakpoint on the last tool only", () => {
    const tools = toAnthropicTools(CHAT_REQ.tools);
    expect(tools[0]).not.toHaveProperty("cache_control");
    expect(tools[1]).toHaveProperty("cache_control", { type: "ephemeral" });
  });
});

describe("ollama mapping", () => {
  it("prepends system, converts tool_use to tool_calls and tool_result to tool role", () => {
    const msgs = toOllamaMessages("sys", HISTORY);
    expect(msgs[0]).toEqual({ role: "system", content: "sys" });
    expect(msgs[2]).toEqual({
      role: "assistant",
      content: "Searching.",
      tool_calls: [{ function: { name: "search_policies", arguments: { query: "QLE", k: 5 } } }],
    });
    // tool result first, then the textual nudge as its own user message
    expect(msgs[3]).toEqual({ role: "tool", content: '[{"chunkId":"c1"}]' });
    expect(msgs[4]).toEqual({ role: "user", content: "Refine your query." });
  });
});

function ndjsonFetch(lines: object[], status = 200): typeof fetch {
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return async () => new Response(body, { status });
}

describe("ollama streaming", () => {
  it("accumulates deltas, collects tool calls, and maps usage from the final chunk", async () => {
    const provider = new OllamaProvider(
      "llama3.1",
      "http://fake",
      ndjsonFetch([
        { message: { content: "Looking " }, done: false },
        { message: { content: "into it." }, done: false },
        {
          message: {
            content: "",
            tool_calls: [{ function: { name: "search_policies", arguments: { query: "QLE" } } }],
          },
          done: false,
        },
        { message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 812, eval_count: 44 },
      ]),
    );
    const deltas: string[] = [];
    const turn = await provider.chat(CHAT_REQ, (t) => deltas.push(t));

    expect(deltas.join("")).toBe("Looking into it.");
    expect(turn.text).toBe("Looking into it.");
    expect(turn.toolCalls).toEqual([
      { id: "ollama_1", name: "search_policies", input: { query: "QLE" } },
    ]);
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.usage).toMatchObject({
      provider: "ollama",
      inputTokens: 812,
      outputTokens: 44,
      cacheReadTokens: 0,
    });
  });

  it("maps done_reason length to max_tokens when no tools were called", async () => {
    const provider = new OllamaProvider(
      "llama3.1",
      "http://fake",
      ndjsonFetch([
        { message: { content: "partial answ" }, done: true, done_reason: "length", prompt_eval_count: 10, eval_count: 500 },
      ]),
    );
    const turn = await provider.chat({ ...CHAT_REQ, tools: [] });
    expect(turn.stopReason).toBe("max_tokens");
  });

  it("throws with a status property so transient-retry and failover classify it", async () => {
    const provider = new OllamaProvider("llama3.1", "http://fake", ndjsonFetch([], 503));
    await expect(provider.chat(CHAT_REQ)).rejects.toMatchObject({ status: 503 });
  });
});

describe("provider factory", () => {
  it("is ollama-only with no API key, anthropic-default when keyed", () => {
    const bare = buildProviders({} as NodeJS.ProcessEnv);
    expect(bare.defaultProvider).toBe("ollama");
    expect(bare.providers.anthropic).toBeUndefined();

    const keyed = buildProviders({ ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    expect(keyed.defaultProvider).toBe("anthropic");
    expect(keyed.providers.anthropic).toBeDefined();
    expect(keyed.providers.ollama).toBeDefined();
  });
});
