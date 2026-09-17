import type { ContentBlock, ModelMessage, TokenBudget } from "./types.js";

/**
 * Phase 2 context budgeter (spec §6).
 *
 * Assembly order when over budget (drop from the bottom):
 *   1. system prompt + tools        — NOT owned here; the adapter keeps this
 *                                     prefix byte-stable for prompt caching
 *   2. original ticket verbatim     — messages[0], never modified
 *   3. running scratchpad           — old assistant text; summarized (cheap
 *                                     model) or deterministically truncated
 *   4. last KEEP_FULL exchanges     — tool results in full
 *   5. older tool results           — replaced by their one-line summaries
 *
 * Block structure is never altered — only text content shrinks — so
 * tool_use/tool_result pairing stays valid for both providers.
 */

export interface Summarizer {
  summarize(text: string): Promise<string>;
}

export interface AssemblyResult {
  messages: ModelMessage[];
  droppedApproxTokens: number;
  compacted: boolean;
}

const APPROX_CHARS_PER_TOKEN = 4;
const COMPACTION_THRESHOLD = 0.8; // spec §6
const KEEP_FULL_MESSAGES = 4; // last two assistant/user exchanges
const SCRATCHPAD_TRUNCATE_CHARS = 240; // fallback when no summarizer configured

export function approxTokens(messages: ModelMessage[]): number {
  const chars = messages.reduce(
    (n, m) =>
      n +
      m.content.reduce(
        (c, b) =>
          c +
          (b.type === "text"
            ? b.text.length
            : b.type === "tool_result"
              ? b.content.length
              : JSON.stringify(b.input ?? {}).length),
        0,
      ),
    0,
  );
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

export class ContextBudgeter {
  constructor(
    private budget: TokenBudget,
    private summarizer?: Summarizer,
  ) {}

  async assemble(
    messages: ModelMessage[],
    resultSummaries: Map<string, string>,
  ): Promise<AssemblyResult> {
    const before = approxTokens(messages);
    if (before <= this.budget.maxStepInput * COMPACTION_THRESHOLD) {
      return { messages, droppedApproxTokens: 0, compacted: false };
    }

    const keepFullFrom = Math.max(1, messages.length - KEEP_FULL_MESSAGES);

    // Stage 1: old tool results -> stored one-line summaries (free).
    let out = messages.map((m, i) => {
      if (i === 0 || i >= keepFullFrom || m.role !== "user") return m;
      const content: ContentBlock[] = m.content.map((b) => {
        if (b.type !== "tool_result") return b;
        const summary = resultSummaries.get(b.toolUseId);
        if (!summary || b.content.length <= summary.length + 40) return b;
        return { ...b, content: `[compacted] ${summary}` };
      });
      return { ...m, content };
    });

    // Stage 2: still over -> shrink the old scratchpad (assistant text).
    if (approxTokens(out) > this.budget.maxStepInput * COMPACTION_THRESHOLD) {
      out = await this.compactScratchpad(out, keepFullFrom);
    }

    const after = approxTokens(out);
    return {
      messages: out,
      droppedApproxTokens: Math.max(0, before - after),
      compacted: after < before,
    };
  }

  private async compactScratchpad(
    messages: ModelMessage[],
    keepFullFrom: number,
  ): Promise<ModelMessage[]> {
    const oldTexts: string[] = [];
    for (let i = 1; i < keepFullFrom; i++) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      for (const b of m.content) if (b.type === "text" && b.text) oldTexts.push(b.text);
    }
    if (oldTexts.length === 0) return messages;

    let replacement: (original: string) => string;
    if (this.summarizer) {
      // One cheap-model call for the whole old scratchpad, not one per turn.
      const combined = await this.summarizer
        .summarize(oldTexts.join("\n---\n"))
        .catch(() => null);
      if (combined) {
        let injected = false;
        replacement = () => {
          if (injected) return "[see earlier reasoning summary]";
          injected = true;
          return `[earlier reasoning, summarized] ${combined}`;
        };
      } else {
        replacement = (t) => truncate(t);
      }
    } else {
      replacement = (t) => truncate(t);
    }

    return messages.map((m, i) => {
      if (i === 0 || i >= keepFullFrom || m.role !== "assistant") return m;
      const content: ContentBlock[] = m.content.map((b) =>
        b.type === "text" && b.text.length > SCRATCHPAD_TRUNCATE_CHARS + 20
          ? { ...b, text: replacement(b.text) }
          : b,
      );
      return { ...m, content };
    });
  }
}

function truncate(text: string): string {
  return `${text.slice(0, SCRATCHPAD_TRUNCATE_CHARS)}…`;
}

/**
 * Cheap-model scratchpad summarizer (spec §6: "never the triage model").
 * Wrap the Ollama adapter locally or a Haiku-class adapter on the API path.
 */
import type { ProviderAdapter } from "./types.js";

export class ProviderSummarizer implements Summarizer {
  constructor(private provider: ProviderAdapter) {}

  async summarize(text: string): Promise<string> {
    const turn = await this.provider.chat({
      system:
        "Compress the agent reasoning below into at most 3 sentences. Preserve every concrete fact, chunk id, and decision. Output only the summary.",
      messages: [{ role: "user", content: [{ type: "text", text }] }],
      tools: [],
      temperature: 0,
      maxTokens: 300,
    });
    return turn.text.trim();
  }
}
