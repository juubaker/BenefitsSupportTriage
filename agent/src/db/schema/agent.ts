import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Spec §9. One row per harness invocation. */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey(),
    ticketId: text("ticket_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    terminalState: text("terminal_state"), // null while running
    stepCount: integer("step_count").notNull().default(0),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    runConfigHash: text("run_config_hash").notNull(),
    totalInputTokens: integer("total_input_tokens").notNull().default(0),
    totalOutputTokens: integer("total_output_tokens").notNull().default(0),
    totalCostUsd: numeric("total_cost_usd", { precision: 10, scale: 6 })
      .notNull()
      .default("0"),
    traceId: text("trace_id"), // populated by Phase 2 tracing
  },
  (t) => [
    index("agent_runs_ticket_idx").on(t.ticketId),
    index("agent_runs_state_idx").on(t.terminalState),
    index("agent_runs_config_idx").on(t.runConfigHash),
  ],
);

export const agentSteps = pgTable(
  "agent_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    stepNo: integer("step_no").notNull(),
    modelStopReason: text("model_stop_reason").notNull(),
    toolCalls: jsonb("tool_calls").notNull().default([]),
    toolResultsSummary: jsonb("tool_results_summary").notNull().default([]),
    scratchpad: text("scratchpad").notNull().default(""),
    spanId: text("span_id"), // populated by Phase 2 tracing
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_steps_run_idx").on(t.runId, t.stepNo)],
);

export const tokenLedger = pgTable(
  "token_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    stepNo: integer("step_no").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("token_ledger_run_idx").on(t.runId)],
);

export const evalResults = pgTable(
  "eval_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    suite: text("suite").notNull(), // "smoke" | "nightly" | ...
    caseId: text("case_id").notNull(),
    metric: text("metric").notNull(),
    score: real("score").notNull(),
    passed: boolean("passed").notNull(),
    judgeModel: text("judge_model"), // null for deterministic metrics
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("eval_results_run_idx").on(t.runId), index("eval_results_case_idx").on(t.suite, t.caseId)],
);

/*
 * Also add to your existing resolved_tickets table (spec §9 flywheel):
 *
 *   sourceRunId: uuid("source_run_id").references(() => agentRuns.id)
 *
 * then `npx drizzle-kit generate` to produce the migration.
 */
