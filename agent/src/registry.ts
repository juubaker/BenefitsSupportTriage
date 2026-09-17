import { z } from "zod";
import type { ToolSpec } from "./types.js";

/** Every handler returns data for the model AND a one-line summary for compaction (spec §6, §10). */
export interface ToolOutput {
  data: unknown;
  summary: string;
}

export interface ToolContext {
  runId: string;
  step: number;
  signal?: AbortSignal;
}

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  /** Terminal tools end the run cleanly (triage_ticket, escalate_to_human). */
  terminal?: boolean;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolOutput>;
}

export type ExecuteWrapper = (
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
  next: () => Promise<ToolExecution>,
) => Promise<ToolExecution>;

export type ToolExecution =
  | { ok: true; name: string; output: ToolOutput; validatedArgs: unknown }
  | { ok: false; name: string; error: string; kind: "validation" | "execution" };

const TRANSIENT_STATUS = new Set([429, 500, 503, 529]);
const TRANSIENT_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED"]);

function isTransient(err: unknown): boolean {
  const e = err as { status?: number; code?: string };
  return (
    (typeof e?.status === "number" && TRANSIENT_STATUS.has(e.status)) ||
    (typeof e?.code === "string" && TRANSIENT_CODES.has(e.code))
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private wrapper?: ExecuteWrapper;

  /** Middleware around execute() — used by tracing for agent.tool spans. */
  setExecuteWrapper(wrapper: ExecuteWrapper): void {
    this.wrapper = wrapper;
  }

  register<S extends z.ZodTypeAny>(def: ToolDefinition<S>): this {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, def as unknown as ToolDefinition);
    return this;
  }

  isTerminal(name: string): boolean {
    return this.tools.get(name)?.terminal === true;
  }

  /** Provider-facing tool specs (JSON Schema derived from Zod). */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      // Zod v4 native export. On Zod v3, swap for zod-to-json-schema.
      inputSchema: z.toJSONSchema(t.schema) as Record<string, unknown>,
    }));
  }

  /**
   * Validate then execute. Validation failures are returned (never thrown) so the
   * loop can hand them back to the model for one self-correction attempt.
   * Transient execution errors get one retry with backoff (spec §5).
   */
  async execute(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<ToolExecution> {
    if (this.wrapper) {
      const wrapper = this.wrapper;
      return wrapper(name, rawArgs, ctx, () => this.doExecute(name, rawArgs, ctx));
    }
    return this.doExecute(name, rawArgs, ctx);
  }

  private async doExecute(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<ToolExecution> {
    const def = this.tools.get(name);
    if (!def) {
      return { ok: false, name, kind: "validation", error: `Unknown tool: ${name}` };
    }

    const parsed = def.schema.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        name,
        kind: "validation",
        error: `Invalid arguments for ${name}: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      };
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const output = await def.handler(parsed.data, ctx);
        return { ok: true, name, output, validatedArgs: parsed.data };
      } catch (err) {
        if (attempt === 0 && isTransient(err) && !ctx.signal?.aborted) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        return {
          ok: false,
          name,
          kind: "execution",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
}
