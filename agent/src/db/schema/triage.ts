import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent.js";

/** Terminal output of a run: the triage decision, or the escalation. */
export const triageResults = pgTable(
  "triage_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: text("ticket_id").notNull(),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    category: text("category"),
    priority: text("priority"),
    summary: text("summary"),
    citations: jsonb("citations").notNull().default([]),
    escalated: boolean("escalated").notNull().default(false),
    escalationReason: text("escalation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("triage_results_ticket_idx").on(t.ticketId), index("triage_results_run_idx").on(t.runId)],
);
