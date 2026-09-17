import { describe, expect, it, vi } from "vitest";
import { approxTokens, ContextBudgeter, type Summarizer } from "../src/budgeter.js";
import type { ModelMessage, TokenBudget } from "../src/types.js";

const BUDGET: TokenBudget = { maxRunTokens: 60_000, maxStepInput: 400, reserveForFinal: 100 };
// threshold = 400 * 0.8 = 320 tokens ≈ 1280 chars

const big = (label: string, chars: number) => `${label}:${"x".repeat(chars)}`;

function history(): { messages: ModelMessage[]; summaries: Map<string, string> } {
  const messages: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: big("ticket", 400) }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: big("old-scratchpad", 600) },
        { type: "tool_use", id: "t1", name: "search_policies", input: { query: "qle" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: big("old-result", 800) }],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "mid thinking" },
        { type: "tool_use", id: "t2", name: "search_policies", input: { query: "cobra" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t2", content: big("mid-result", 500) }],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "recent thinking" },
        { type: "tool_use", id: "t3", name: "find_similar_tickets", input: { description: "spouse" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t3", content: big("recent-result", 700) }],
    },
  ];
  const summaries = new Map([
    ["t1", "search_policies(qle) -> 3 chunks"],
    ["t2", "search_policies(cobra) -> 3 chunks"],
    ["t3", "find_similar_tickets -> 2 matches"],
  ]);
  return { messages, summaries };
}

describe("context budgeter", () => {
  it("passes messages through untouched under the 0.8 threshold", async () => {
    const budgeter = new ContextBudgeter({ ...BUDGET, maxStepInput: 100_000 });
    const { messages, summaries } = history();
    const out = await budgeter.assemble(messages, summaries);
    expect(out.compacted).toBe(false);
    expect(out.messages).toBe(messages);
  });

  it("replaces only OLD tool results with summaries; recent ones stay full", async () => {
    const budgeter = new ContextBudgeter({ ...BUDGET, maxStepInput: 700 });
    const { messages, summaries } = history();
    const out = await budgeter.assemble(messages, summaries);

    const flat = JSON.stringify(out.messages);
    expect(flat).toContain("[compacted] search_policies(qle)");
    expect(flat).toContain(big("recent-result", 700)); // last exchanges kept full
    expect(out.droppedApproxTokens).toBeGreaterThan(0);
  });

  it("never modifies the original ticket (messages[0])", async () => {
    const budgeter = new ContextBudgeter(BUDGET); // tight: forces both stages
    const { messages, summaries } = history();
    const out = await budgeter.assemble(messages, summaries);
    expect(out.messages[0]).toEqual(messages[0]);
  });

  it("preserves block structure: every tool_use keeps its id and pairing", async () => {
    const budgeter = new ContextBudgeter(BUDGET);
    const { messages, summaries } = history();
    const out = await budgeter.assemble(messages, summaries);
    const uses = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_use"));
    const results = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"));
    expect(uses.map((u) => (u.type === "tool_use" ? u.id : ""))).toEqual(["t1", "t2", "t3"]);
    expect(results.map((r) => (r.type === "tool_result" ? r.toolUseId : ""))).toEqual(["t1", "t2", "t3"]);
  });

  it("summarizes the old scratchpad with ONE cheap-model call when configured", async () => {
    const summarizer: Summarizer = { summarize: vi.fn(async () => "condensed reasoning") };
    const budgeter = new ContextBudgeter(BUDGET, summarizer);
    const { messages, summaries } = history();
    const out = await budgeter.assemble(messages, summaries);

    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(out.messages)).toContain("[earlier reasoning, summarized] condensed reasoning");
    expect(JSON.stringify(out.messages)).not.toContain(big("old-scratchpad", 600));
  });

  it("falls back to deterministic truncation with no summarizer (and when it fails)", async () => {
    const failing: Summarizer = { summarize: async () => Promise.reject(new Error("down")) };
    for (const budgeter of [new ContextBudgeter(BUDGET), new ContextBudgeter(BUDGET, failing)]) {
      const { messages, summaries } = history();
      const out = await budgeter.assemble(messages, summaries);
      const scratch = out.messages[1].content.find((b) => b.type === "text");
      expect(scratch && scratch.type === "text" ? scratch.text.length : 0).toBeLessThan(300);
      expect(scratch && scratch.type === "text" ? scratch.text : "").toMatch(/…$/);
    }
  });

  it("shrinks estimated tokens below the pre-compaction size", async () => {
    const budgeter = new ContextBudgeter(BUDGET);
    const { messages, summaries } = history();
    const before = approxTokens(messages);
    const out = await budgeter.assemble(messages, summaries);
    expect(approxTokens(out.messages)).toBeLessThan(before);
    expect(before - approxTokens(out.messages)).toBe(out.droppedApproxTokens);
  });
});
