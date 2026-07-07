#!/usr/bin/env node
/**
 * Benefits Support Triage MCP Server
 * -----------------------------------
 * Exposes the Benefits Support Triage Agent's RAG pipeline (policy_chunks +
 * resolved_tickets pgvector corpora) as MCP tools, resources, and prompts.
 *
 * ASSUMPTIONS ABOUT YOUR SCHEMA
 * -----------------------------
 * This file assumes a Drizzle setup shaped like:
 *
 *   db/schema.ts
 *     export const policyChunks = pgTable('policy_chunks', {
 *       id: text('id').primaryKey(),
 *       docId: text('doc_id').notNull(),
 *       docName: text('doc_name').notNull(),
 *       section: text('section'),
 *       page: integer('page'),
 *       planType: text('plan_type'),          // 'PPO' | 'HDHP' | 'HMO' | 'dental' | 'vision' | null
 *       text: text('text').notNull(),
 *       embedding: vector('embedding', { dimensions: 768 }), // nomic-embed-text
 *     });
 *
 *     export const resolvedTickets = pgTable('resolved_tickets', {
 *       id: text('id').primaryKey(),
 *       category: text('category'),
 *       submittedText: text('submitted_text').notNull(),
 *       resolutionSummary: text('resolution_summary'),
 *       resolvedAt: timestamp('resolved_at'),
 *       embedding: vector('embedding', { dimensions: 768 }),
 *     });
 *
 * Swap the import path and column names below to match your actual
 * `rag/db/schema.ts`. Everywhere you need to touch it is marked with
 * `// SCHEMA:`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { db } from "./db.js"; // SCHEMA: your existing Drizzle client (rag/db/client.ts)
import { policyChunks, resolvedTickets } from "./db.js"; // SCHEMA: your existing tables
import { sql, eq, desc } from "drizzle-orm";
import { embed } from "./embeddings.js"; // Ollama nomic-embed-text wrapper, see embeddings.ts
import { readLatestEvalReport } from "./eval.js"; // reads your DeepEval sidecar output
import { runTriagePipeline } from "./triage.js"; // your existing agent-loop logic, extracted

// ---------------------------------------------------------------------------
// Zod schemas for tool inputs (also used for runtime validation before we
// touch the DB — cheap insurance against malformed calls from the host)
// ---------------------------------------------------------------------------

const SearchPoliciesInput = z.object({
  query: z.string().min(1),
  top_k: z.number().int().min(1).max(20).default(5),
  plan_type: z
    .enum(["PPO", "HDHP", "HMO", "dental", "vision", "any"])
    .default("any"),
  min_similarity: z.number().min(0).max(1).default(0.7),
});

const FindSimilarTicketsInput = z.object({
  query: z.string().min(1),
  top_k: z.number().int().min(1).max(20).default(5),
});

const TriageTicketInput = z.object({
  ticket_text: z.string().min(1),
  employee_context: z
    .object({
      plan_type: z.string().optional(),
      enrollment_status: z.string().optional(),
    })
    .optional(),
});

const GetEvalMetricsInput = z.object({
  metric: z
    .enum([
      "all",
      "contextual_precision",
      "contextual_recall",
      "faithfulness",
      "answer_relevancy",
    ])
    .default("all"),
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "benefits-support-triage", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// ---------------------------------------------------------------------------
// Tools: list
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_policies",
      description:
        "Semantic search over the benefits policy corpus. Returns ranked policy chunks with similarity scores and source metadata. Use this to find policy language relevant to a question before triaging a ticket.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Natural language question or topic, e.g. 'HSA contribution limit for family coverage'",
          },
          top_k: { type: "integer", default: 5, minimum: 1, maximum: 20 },
          plan_type: {
            type: "string",
            enum: ["PPO", "HDHP", "HMO", "dental", "vision", "any"],
            default: "any",
          },
          min_similarity: { type: "number", default: 0.7 },
        },
        required: ["query"],
      },
    },
    {
      name: "find_similar_tickets",
      description:
        "Semantic search over resolved support tickets to find precedent cases. Returns past tickets similar to the input, along with their resolutions.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The employee's issue or question",
          },
          top_k: { type: "integer", default: 5, minimum: 1, maximum: 20 },
        },
        required: ["query"],
      },
    },
    {
      name: "triage_ticket",
      description:
        "Runs the full triage pipeline on a new support ticket: retrieves relevant policy chunks and similar resolved tickets, then produces a recommended category, priority, and draft response, with retrieval evidence attached.",
      inputSchema: {
        type: "object",
        properties: {
          ticket_text: { type: "string" },
          employee_context: {
            type: "object",
            properties: {
              plan_type: { type: "string" },
              enrollment_status: { type: "string" },
            },
          },
        },
        required: ["ticket_text"],
      },
    },
    {
      name: "get_eval_metrics",
      description:
        "Returns the latest DeepEval RAG evaluation results for this triage system: contextual precision, contextual recall, faithfulness, and answer relevancy against the golden dataset.",
      inputSchema: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            enum: [
              "all",
              "contextual_precision",
              "contextual_recall",
              "faithfulness",
              "answer_relevancy",
            ],
            default: "all",
          },
        },
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tools: call
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "search_policies":
        return await handleSearchPolicies(SearchPoliciesInput.parse(args));
      case "find_similar_tickets":
        return await handleFindSimilarTickets(
          FindSimilarTicketsInput.parse(args)
        );
      case "triage_ticket":
        return await handleTriageTicket(TriageTicketInput.parse(args));
      case "get_eval_metrics":
        return await handleGetEvalMetrics(GetEvalMetricsInput.parse(args));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    // Surface errors as tool results (isError) rather than throwing raw,
    // so the host model can see what went wrong and retry/adjust.
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: `Tool "${name}" failed: ${message}` }],
    };
  }
});

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleSearchPolicies(
  input: z.infer<typeof SearchPoliciesInput>
) {
  const queryEmbedding = await embed(input.query);

  // SCHEMA: pgvector cosine distance operator is `<=>`; similarity = 1 - distance.
  // Adjust the `sql` fragment if your column/operator differs (e.g. `<->` for L2).
  // A chunk with plan_type = null applies to any plan, so it always matches
  // regardless of the requested plan_type.
  const rows = await db
    .select({
      id: policyChunks.id,
      docTitle: policyChunks.docTitle,
      section: policyChunks.section,
      chunkText: policyChunks.chunkText,
      sourceUrl: policyChunks.sourceUrl,
      planType: policyChunks.planType,
      similarity: sql<number>`1 - (${policyChunks.embedding} <=> ${sql.raw(
        `'[${queryEmbedding.join(",")}]'::vector`
      )})`,
    })
    .from(policyChunks)
    .where(
      input.plan_type === "any"
        ? sql`true`
        : sql`(${policyChunks.planType} is null or ${policyChunks.planType} = ${input.plan_type})`
    )
    .orderBy(
      sql`${policyChunks.embedding} <=> ${sql.raw(
        `'[${queryEmbedding.join(",")}]'::vector`
      )}`
    )
    .limit(input.top_k);

  const results = rows
    .filter((r) => r.similarity >= input.min_similarity)
    .map((r) => ({
      chunk_id: r.id,
      resource_uri: `policy://chunk/${r.id}`,
      similarity: Number(r.similarity.toFixed(4)),
      policy_doc: r.docTitle,
      section: r.section,
      text_preview: r.chunkText.slice(0, 240),
      source_url: r.sourceUrl,
      plan_type: r.planType,
    }));

  const payload = {
    results,
    query_embedding_model: "nomic-embed-text",
    corpus_size: await countRows(policyChunks),
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

async function handleFindSimilarTickets(
  input: z.infer<typeof FindSimilarTicketsInput>
) {
  const queryEmbedding = await embed(input.query);

  const rows = await db
    .select({
      id: resolvedTickets.id,
      category: resolvedTickets.category,
      caseText: resolvedTickets.caseText,
      approvedResponse: resolvedTickets.approvedResponse,
      similarity: sql<number>`1 - (${resolvedTickets.embedding} <=> ${sql.raw(
        `'[${queryEmbedding.join(",")}]'::vector`
      )})`,
    })
    .from(resolvedTickets)
    .orderBy(
      sql`${resolvedTickets.embedding} <=> ${sql.raw(
        `'[${queryEmbedding.join(",")}]'::vector`
      )}`
    )
    .limit(input.top_k);

  const results = rows.map((r) => ({
    ticket_id: r.id,
    resource_uri: `ticket://${r.id}`,
    similarity: Number(r.similarity.toFixed(4)),
    category: r.category,
    case_text: r.caseText,
    approved_response: r.approvedResponse,
  }));

  return {
    content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }],
  };
}

async function handleTriageTicket(input: z.infer<typeof TriageTicketInput>) {
  // Delegates to your existing agent-loop logic (extracted from the Express
  // route into a shared module so both the HTTP API and this MCP server
  // call the same code path — no duplicated business logic).
  const result = await runTriagePipeline({
    ticketText: input.ticket_text,
    employeeContext: input.employee_context,
  });

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

async function handleGetEvalMetrics(
  input: z.infer<typeof GetEvalMetricsInput>
) {
  const report = await readLatestEvalReport(); // reads DeepEval sidecar JSON output

  const payload =
    input.metric === "all"
      ? report
      : { [input.metric]: report[input.metric], run_id: report.run_id };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

async function countRows(table: typeof policyChunks) {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(table);
  return Number(count);
}

// ---------------------------------------------------------------------------
// Resources: list
// ---------------------------------------------------------------------------
// Resources are for direct, ID-based re-fetches (no re-embedding, no ranking).
// We intentionally don't enumerate the full corpus here — that's what
// search_policies / find_similar_tickets are for. `list` returns a bounded,
// recency-ordered sample so hosts that call `resources/list` on connect get
// something reasonable without hammering the DB.

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const recentTickets = await db
    .select({ id: resolvedTickets.id, category: resolvedTickets.category })
    .from(resolvedTickets)
    .orderBy(desc(resolvedTickets.createdAt))
    .limit(25);

  return {
    resources: [
      ...recentTickets.map((t) => ({
        uri: `ticket://${t.id}`,
        name: `Ticket ${t.id} — ${t.category ?? "uncategorized"}`,
        mimeType: "application/json",
      })),
      {
        uri: "eval://latest",
        name: "Latest DeepEval RAG evaluation run",
        mimeType: "application/json",
      },
    ],
  };
});

// ---------------------------------------------------------------------------
// Resources: read
// ---------------------------------------------------------------------------

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  if (uri.startsWith("policy://chunk/")) {
    const id = Number(uri.replace("policy://chunk/", ""));
    const [row] = await db
      .select()
      .from(policyChunks)
      .where(eq(policyChunks.id, id))
      .limit(1);
    if (!row) throw new Error(`No policy chunk found for ${uri}`);
    return {
      contents: [
        {
          uri,
          mimeType: "text/plain",
          text: row.chunkText,
        },
      ],
    };
  }

  if (uri.startsWith("ticket://")) {
    const id = Number(uri.replace("ticket://", "").replace(/\/resolution$/, ""));
    const [row] = await db
      .select()
      .from(resolvedTickets)
      .where(eq(resolvedTickets.id, id))
      .limit(1);
    if (!row) throw new Error(`No ticket found for ${uri}`);

    const isResolutionOnly = uri.endsWith("/resolution");
    const body = isResolutionOnly
      ? { ticket_id: row.id, approved_response: row.approvedResponse }
      : row;

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(body, null, 2),
        },
      ],
    };
  }

  if (uri === "eval://latest") {
    const report = await readLatestEvalReport();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(report, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unrecognized resource URI: ${uri}`);
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "triage_summary_for_manager",
      description:
        "Formats a triage result into a short manager-facing summary for escalated tickets.",
      arguments: [
        {
          name: "ticket_id",
          description: "Ticket to summarize",
          required: true,
        },
      ],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name !== "triage_summary_for_manager") {
    throw new Error(`Unknown prompt: ${request.params.name}`);
  }

  const ticketId = request.params.arguments?.ticket_id;
  if (!ticketId) throw new Error("ticket_id argument is required");

  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Read the resource ticket://${ticketId}, then write a 3-sentence summary for a benefits manager covering: what the employee asked, how it was resolved, and whether it indicates a policy-communication gap worth flagging.`,
        },
      },
    ],
  };
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio servers must never write to stdout — it corrupts the JSON-RPC
  // stream. Always log to stderr.
  console.error("Benefits Support Triage MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});
