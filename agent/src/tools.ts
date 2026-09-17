import { z } from "zod";
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

export const triageResultSchema = z.object({
  category: z.string().min(1),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  summary: z.string().min(1),
  citations: z.array(z.string()).default([]),
  escalated: z.literal(false).default(false),
});

export function buildRegistry(services: TriageServices): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: "search_policies",
    description:
      "Semantic search over benefits policy documents. Returns policy chunks with ids and relevance scores. Refine and call again if the first results do not cover every part of the ticket.",
    schema: z.object({
      query: z.string().min(3),
      k: z.number().int().min(1).max(10).default(5),
    }),
    handler: async ({ query, k }) => {
      const rows = await services.searchPolicies(query, k);
      return {
        data: rows,
        summary: `search_policies("${query}") -> ${rows.length} chunks, top score ${rows[0]?.score?.toFixed(2) ?? "n/a"}`,
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
    handler: async ({ description, k }) => {
      const rows = await services.findSimilarTickets(description, k);
      return {
        data: rows,
        summary: `find_similar_tickets -> ${rows.length} matches, top score ${rows[0]?.score?.toFixed(2) ?? "n/a"}`,
      };
    },
  });

  registry.register({
    name: "triage_ticket",
    description:
      "TERMINAL. Submit the final triage. Call exactly once, after gathering sufficient evidence. citations must only contain chunk/ticket ids returned by earlier tool calls.",
    schema: triageResultSchema,
    terminal: true,
    handler: async (input) => {
      await services.saveTriage(input);
      return { data: { saved: true }, summary: `triage saved: ${input.category}/${input.priority}` };
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
    handler: async ({ ticketId, reason }) => {
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
