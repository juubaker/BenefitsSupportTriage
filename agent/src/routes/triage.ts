import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AgentHarness } from "../harness.js";

const bodySchema = z.object({
  ticketId: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  provider: z.enum(["anthropic", "ollama"]).optional(),
});

/**
 * POST /api/triage — runs the agent and streams AgentEvents over SSE.
 * Client disconnect aborts the run via AbortController -> terminal "aborted".
 */
export type HarnessSource = AgentHarness | ((ticketId: string) => AgentHarness);

export function triageRouter(source: HarnessSource): Router {
  const router = Router();
  // A factory is the normal case: the terminal tools are bound per ticket, so
  // the registry (and therefore the harness) is built per request.
  const resolve = (ticketId: string): AgentHarness =>
    typeof source === "function" ? source(ticketId) : source;

  router.post("/api/triage", async (req: Request, res: Response) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { provider, ...ticket } = parsed.data;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const abort = new AbortController();
    req.on("close", () => abort.abort());
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const harness = resolve(ticket.ticketId);
      for await (const event of harness.run(ticket, { provider, signal: abort.signal })) {
        // step_completed carries the full persisted record; the client only needs the lean stream.
        if (event.type === "step_completed") continue;
        send(event.type, event);
        if (event.type === "terminal") break;
      }
    } catch (err) {
      send("error", { message: err instanceof Error ? err.message : "run failed" });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });

  return router;
}
