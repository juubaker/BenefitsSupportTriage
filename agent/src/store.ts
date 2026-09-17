import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { RunStore } from "./harness.js";
import type { StepRecord, TerminalState, ProviderName } from "./types.js";
import { agentRuns, agentSteps, tokenLedger } from "./db/schema/agent.js";

/** Pricing lookup is done in the harness; the store just persists. */
export class DrizzleRunStore implements RunStore {
  constructor(
    private db: NodePgDatabase<Record<string, unknown>>,
    private pricing?: Record<string, { inputPerMTok: number; outputPerMTok: number }>,
  ) {}

  async createRun(row: {
    id: string;
    ticketId: string;
    provider: ProviderName;
    model: string;
    runConfigHash: string;
    traceId?: string;
  }): Promise<void> {
    await this.db.insert(agentRuns).values(row);
  }

  async appendStep(r: StepRecord): Promise<void> {
    await this.db.insert(agentSteps).values({
      runId: r.runId,
      stepNo: r.stepNo,
      modelStopReason: r.modelStopReason,
      toolCalls: r.toolCalls,
      toolResultsSummary: r.toolResultsSummary,
      scratchpad: r.scratchpad,
      spanId: r.spanId,
    });
  }

  async recordLedger(r: StepRecord): Promise<void> {
    const p = this.pricing?.[r.usage.model];
    const cost = p
      ? (r.usage.inputTokens * p.inputPerMTok + r.usage.outputTokens * p.outputPerMTok) /
        1_000_000
      : 0;
    await this.db.insert(tokenLedger).values({
      runId: r.runId,
      stepNo: r.stepNo,
      provider: r.usage.provider,
      model: r.usage.model,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      cacheReadTokens: r.usage.cacheReadTokens,
      cacheWriteTokens: r.usage.cacheWriteTokens,
      costUsd: cost.toFixed(6),
    });
  }

  async finishRun(row: {
    id: string;
    terminalState: TerminalState;
    stepCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
  }): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({
        endedAt: sql`now()`,
        terminalState: row.terminalState,
        stepCount: row.stepCount,
        totalInputTokens: row.totalInputTokens,
        totalOutputTokens: row.totalOutputTokens,
        totalCostUsd: row.totalCostUsd.toFixed(6),
      })
      .where(eq(agentRuns.id, row.id));
  }
}
