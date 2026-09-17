import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Router, type Request, type Response } from "express";
import { agentRuns, agentSteps, tokenLedger } from "../db/schema/agent.js";

/**
 * Run debug API (spec §7 "run debug view", §10 get_run_trace).
 *
 *   GET /api/runs           — recent runs (terminal state, steps, tokens, cost)
 *   GET /api/runs/:id       — full trajectory: run + ordered steps + ledger
 *
 * The React debug view renders /api/runs/:id as a timeline; trace_id links out
 * to Jaeger (http://localhost:16686/trace/<trace_id> on the local stack). The
 * same payload backs the MCP get_run_trace tool and the DeepEval sidecar's
 * deterministic trajectory metrics.
 */
export function runsRouter(db: NodePgDatabase<Record<string, unknown>>): Router {
  const router = Router();

  router.get("/api/runs", async (_req: Request, res: Response) => {
    const rows = await db
      .select({
        id: agentRuns.id,
        ticketId: agentRuns.ticketId,
        startedAt: agentRuns.startedAt,
        endedAt: agentRuns.endedAt,
        terminalState: agentRuns.terminalState,
        stepCount: agentRuns.stepCount,
        provider: agentRuns.provider,
        model: agentRuns.model,
        totalInputTokens: agentRuns.totalInputTokens,
        totalOutputTokens: agentRuns.totalOutputTokens,
        totalCostUsd: agentRuns.totalCostUsd,
        traceId: agentRuns.traceId,
      })
      .from(agentRuns)
      .orderBy(desc(agentRuns.startedAt))
      .limit(50);
    res.json({ runs: rows });
  });

  router.get("/api/runs/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
    if (!run) {
      res.status(404).json({ error: `run not found: ${id}` });
      return;
    }
    const steps = await db
      .select()
      .from(agentSteps)
      .where(eq(agentSteps.runId, id))
      .orderBy(agentSteps.stepNo);
    const ledger = await db
      .select()
      .from(tokenLedger)
      .where(eq(tokenLedger.runId, id))
      .orderBy(tokenLedger.stepNo);

    res.json({
      run,
      steps,
      ledger,
      trajectory: steps.map((s) =>
        ((s.toolCalls as Array<{ name: string }>) ?? []).map((c) => c.name).join("+") || "(prose)",
      ),
    });
  });

  return router;
}
