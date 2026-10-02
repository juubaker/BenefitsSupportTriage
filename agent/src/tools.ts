import { z } from "zod";
import { ToolValidationError } from "./registry.js";
import { ToolRegistry } from "./registry.js";

/**
 * Wires the v1 MCP tool handlers into the harness registry (spec §4, §10).
 * The MCP server keeps exposing the same tools externally; internally the
 * harness calls the underlying services directly — no localhost round-trip.
 *
 * INTEGRATION: replace each `services.*` call with your actual v1 service
 * functions (the ones your MCP handlers already call).
 */
export interface TriageServices {
  searchPolicies(q: string, k: number): Promise<Array<{ chunkId: string; text: string; score: number }>>;
  findSimilarTickets(q: string, k: number): Promise<Array<{ ticketId: string; resolution: string; score: number }>>;
  saveTriage(input: Record<string, unknown>): Promise<void>;
  escalate(ticketId: string, reason: string): Promise<void>;
}

/**
 * The taxonomy the eval's golden cases are written against. Free-form strings
 * let the model answer "benefits-enrollment" where the expected value is
 * "enrollment", which fails outcome scoring on vocabulary alone; as an enum the
 * valid values are part of the tool schema the model sees.
 */
export const TRIAGE_CATEGORIES = [
  "enrollment",
  "eligibility",
  "plan_administration",
  "medical",
  "dental",
  "vision",
  "pharmacy",
  "spending_accounts",
  "disability",
  "life_insurance",
  "retirement",
  "commuter",
  "wellbeing",
] as const;

export const TRIAGE_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export const triageResultSchema = z.object({
  category: z.enum(TRIAGE_CATEGORIES),
  priority: z.enum(TRIAGE_PRIORITIES),
  summary: z.string().min(1),
  citations: z.array(z.string()).default([]),
  escalated: z.literal(false).default(false),
});

export function buildRegistry(services: TriageServices): ToolRegistry {
  const registry = new ToolRegistry();

  // Ids this run actually retrieved, per run. The prompt tells the model to
  // cite only these; this enforces it at the boundary, so a fabricated
  // citation comes back as a correctable error instead of being stored and
  // caught later by an eval metric (or not at all).
  const observed = new Map<string, Set<string>>();
  const note = (runId: string, ids: string[]) => {
    const seen = observed.get(runId) ?? new Set<string>();
    for (const id of ids) seen.add(id);
    observed.set(runId, seen);
  };

  registry.register({
    name: "search_policies",
    description:
      "Semantic search over benefits policy documents. Returns policy chunks with ids and relevance scores. Refine and call again if the first results do not cover every part of the ticket.",
    schema: z.object({
      query: z.string().min(3),
      k: z.number().int().min(1).max(10).default(5),
    }),
    handler: async ({ query, k }, ctx) => {
      const rows = await services.searchPolicies(query, k);
      note(ctx.runId, rows.map((r) => r.chunkId));
      return {
        data: rows,
        // The ids belong in the summary: agent_steps persists only this string,
        // and the eval's grounding metric recovers what the run actually saw
        // from it. Without them every citation looks hallucinated.
        summary: `search_policies("${query}") -> ${rows.length} chunks [${rows
          .map((r) => r.chunkId)
          .join(", ")}], top score ${rows[0]?.score?.toFixed(2) ?? "n/a"}`,
      };
    },
  });

  registry.register({
    name: "find_similar_tickets",
    description:
      "Find previously resolved support tickets similar to a description. Use to check how comparable cases were resolved.",
    schema: z.object({
      description: z.string().min(3),
      k: z.number().int().min(1).max(10).default(3),
    }),
    handler: async ({ description, k }, ctx) => {
      const rows = await services.findSimilarTickets(description, k);
      note(ctx.runId, rows.map((r) => r.ticketId));
      return {
        data: rows,
        summary: `find_similar_tickets -> ${rows.length} matches [${rows
          .map((r) => r.ticketId)
          .join(", ")}], top score ${rows[0]?.score?.toFixed(2) ?? "n/a"}`,
      };
    },
  });

  registry.register({
    name: "triage_ticket",
    description:
      "TERMINAL. Submit the final triage. Call exactly once, after gathering sufficient evidence. citations must only contain chunk/ticket ids returned by earlier tool calls.",
    schema: triageResultSchema,
    terminal: true,
    handler: async (input, ctx) => {
      const seen = observed.get(ctx.runId) ?? new Set<string>();
      const unseen = (input.citations ?? []).filter((c) => !seen.has(c));
      if (unseen.length > 0) {
        observed.delete(ctx.runId);
        throw new ToolValidationError(
          `Citations not returned by any earlier tool call in this run: ${unseen.join(", ")}. ` +
            `Cite only ids from your tool results${seen.size ? ` (available: ${[...seen].join(", ")})` : ""}, ` +
            `or call the tool again with the unsupported citations removed.`,
        );
      }
      observed.delete(ctx.runId);
      await services.saveTriage(input);
      return {
        data: { saved: true },
        summary: `triage saved: ${input.category}/${input.priority}, citations [${(
          input.citations ?? []
        ).join(", ")}]`,
      };
    },
  });

  registry.register({
    name: "escalate_to_human",
    description:
      "TERMINAL. Route this ticket to a human specialist. Use when the ticket is out of scope, requires account-specific data you cannot access, or policy evidence is genuinely contradictory.",
    schema: z.object({
      ticketId: z.string().min(1),
      reason: z.string().min(10),
    }),
    terminal: true,
    handler: async ({ ticketId, reason }, ctx) => {
      observed.delete(ctx.runId);
      await services.escalate(ticketId, reason);
      return { data: { escalated: true }, summary: `escalated: ${reason.slice(0, 60)}` };
    },
  });

  // get_eval_metrics and get_run_trace stay MCP-only surfaces — the agent
  // doesn't need them mid-run, so they aren't registered in the loop registry.

  return registry;
}

export const SYSTEM_PROMPT = `You are a benefits support triage agent. Your job: classify the ticket, set priority, summarize the issue, and ground everything in evidence.

Rules:
- Gather evidence with search_policies and find_similar_tickets before deciding. Tickets touching multiple topics (e.g. a qualifying life event AND COBRA) need a separate refined search per topic.
- Before finishing, state in one short paragraph whether the evidence is sufficient. Then call triage_ticket.
- citations may only contain ids that appeared in your tool results. Never invent citations.
- If the ticket is out of scope or requires account data you cannot see, call escalate_to_human instead of guessing.
- Always finish by calling triage_ticket or escalate_to_human. Never end with a prose answer.`;
