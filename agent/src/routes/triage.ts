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
 * Client disconnect (response close before a clean end) aborts the run via
 * AbortController -> terminal "aborted".
 */
/**
 * Unwraps the `cause` chain so an error names what actually went wrong.
 * Postgres errors carry a SQLSTATE in `code`; a socket failure carries
 * ECONNREFUSED. Both are what you need, and both sit one level down.
 */
function describeError(err: unknown): { message: string; cause?: string; code?: string } {
  if (!(err instanceof Error)) return { message: "run failed" };
  const out: { message: string; cause?: string; code?: string } = {
    message: err.message.split("\n")[0],
  };
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") out.code = code;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    out.cause = cause.message.split("\n")[0];
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string") out.code = causeCode;
  }
  return out;
}

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
    // res "close" means the connection actually went away. The
    // writableEnded guard keeps a clean finish from counting as a disconnect:
    // res.end() in the finally block also fires "close", and aborting there
    // races the final finishRun write.
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
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
      // Surface the underlying cause, not just the wrapper. Drizzle's
      // DrizzleQueryError and Node's fetch both carry the real failure in
      // `cause` — a dropped cause has twice turned a one-line diagnosis
      // ("ECONNREFUSED", "relation does not exist") into a long hunt, since
      // the client saw only "Failed query: insert into ..." or "fetch failed".
      const detail = describeError(err);
      // Also log it: the stream reaches whoever made the request, but an
      // operator reading the server log had nothing at all.
      console.error(`[triage] run failed: ${detail.message}`, detail.cause ?? "");
      send("error", detail);
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });

  return router;
}
