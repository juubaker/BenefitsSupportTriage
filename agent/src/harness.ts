import { randomUUID, createHash } from "node:crypto";
import { runLoop } from "./loop.js";
import type { ToolRegistry } from "./registry.js";
import type { ContextBudgeter } from "./budgeter.js";
import type { AgentTracing, RunScope, StepScope } from "./tracing.js";
import type {
  AgentEvent,
  ProviderAdapter,
  ProviderName,
  RunOptions,
  StepRecord,
  TerminalState,
  TriageRequest,
} from "./types.js";
import { DEFAULT_BUDGET } from "./types.js";

/**
 * Persistence boundary. DrizzleRunStore is the real one; tests use MemoryRunStore.
 * The harness awaits each write before advancing the loop, so every step is
 * durable before the next begins (spec §4).
 */
export interface RunStore {
  createRun(row: {
    id: string;
    ticketId: string;
    provider: ProviderName;
    model: string;
    runConfigHash: string;
    traceId?: string;
  }): Promise<void>;
  appendStep(record: StepRecord): Promise<void>;
  recordLedger(record: StepRecord): Promise<void>;
  finishRun(row: {
    id: string;
    terminalState: TerminalState;
    stepCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
  }): Promise<void>;
}

export interface HarnessDeps {
  providers: Partial<Record<ProviderName, ProviderAdapter>>;
  defaultProvider: ProviderName;
  registry: ToolRegistry;
  store: RunStore;
  systemPrompt: string;
  /** Phase 2: spec §6 budgeter (with optional cheap-model summarizer). */
  budgeter?: ContextBudgeter;
  /** Phase 2: spec §7 tracing. When set, agent.tool spans are wired automatically. */
  tracing?: AgentTracing;
  /** $ per 1M tokens, keyed by model; used for the ledger's cost column. */
  pricing?: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
}

export class AgentHarness {
  constructor(private deps: HarnessDeps) {
    if (deps.tracing) deps.registry.setExecuteWrapper(deps.tracing.executeWrapper());
  }

  async *run(req: TriageRequest, opts: RunOptions = {}): AsyncIterable<AgentEvent> {
    const { tracing } = this.deps;
    const providerName = opts.provider ?? this.deps.defaultProvider;
    const explicitPin = opts.provider !== undefined;
    let provider = this.deps.providers[providerName];
    if (!provider) throw new Error(`Provider not configured: ${providerName}`);

    const runId = randomUUID();
    const runConfigHash = this.configHash(provider, opts);
    const totals = { input: 0, output: 0 };
    let stepCount = 0;
    let terminal: TerminalState = "aborted";

    const runScope: RunScope | undefined = tracing?.startRun(
      runId,
      req.ticketId,
      provider.name,
      provider.model,
      opts.traceparent,
    );
    let stepScope: StepScope | undefined;

    await this.deps.store.createRun({
      id: runId,
      ticketId: req.ticketId,
      provider: provider.name,
      model: provider.model,
      runConfigHash,
      traceId: runScope?.traceId,
    });

    yield { type: "run_started", runId, provider: provider.name, model: provider.model };

    const execute = async function* (
      this: AgentHarness,
      p: ProviderAdapter,
    ): AsyncGenerator<AgentEvent> {
      const traced = tracing ? tracing.instrumentProvider(p) : p;
      const gen = runLoop(
        {
          provider: traced,
          registry: this.deps.registry,
          runId,
          systemPrompt: this.deps.systemPrompt,
          budgeter: this.deps.budgeter,
        },
        req,
        opts,
      );
      // Each next() resumes the loop inside the active step (or run) context,
      // so gen_ai.chat and agent.tool spans parent correctly.
      const next = () => {
        const ctx = stepScope?.ctx ?? runScope?.ctx;
        return tracing && ctx ? tracing.within(ctx, () => gen.next()) : gen.next();
      };
      while (true) {
        const { value, done } = await next();
        if (done) {
          terminal = value.state;
          stepCount = value.stepCount;
          totals.input = value.totals.inputTokens;
          totals.output = value.totals.outputTokens;
          return;
        }
        const event = value;
        if (event.type === "step_started" && runScope) {
          stepScope = tracing!.startStep(runScope, event.step);
        }
        if (event.type === "compaction" && stepScope) {
          tracing!.recordEvent(stepScope, "context_compaction", {
            dropped_approx_tokens: event.droppedApproxTokens,
          });
        }
        if (event.type === "step_completed") {
          event.record.spanId = stepScope?.spanId;
          // Durable before the loop advances: next() isn't called until these resolve.
          await this.deps.store.appendStep(event.record);
          await this.deps.store.recordLedger(event.record);
          if (stepScope) {
            tracing!.endStep(stepScope, event.record);
            stepScope = undefined;
          }
        }
        yield event;
      }
    }.bind(this);

    try {
      try {
        yield* execute(provider);
      } catch (err) {
        // Provider failover only when the caller didn't pin a provider (spec §5).
        const fallbackName: ProviderName = provider.name === "anthropic" ? "ollama" : "anthropic";
        const fallback = this.deps.providers[fallbackName];
        if (explicitPin || !fallback || opts.signal?.aborted) throw err;
        if (stepScope) {
          tracing!.endStep(stepScope, {
            runId,
            stepNo: -1,
            modelStopReason: "provider_error",
            toolCalls: [],
            toolResultsSummary: [],
            scratchpad: "",
            usage: {
              provider: provider.name,
              model: provider.model,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          });
          stepScope = undefined;
        }
        if (runScope) {
          tracing!.recordEvent(runScope, "provider_failover", {
            from: provider.name,
            to: fallback.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        provider = fallback;
        yield { type: "run_started", runId, provider: fallback.name, model: fallback.model };
        yield* execute(fallback);
      }
    } finally {
      const totalCostUsd = this.cost(provider.model, totals.input, totals.output);
      await this.deps.store.finishRun({
        id: runId,
        terminalState: terminal,
        stepCount,
        totalInputTokens: totals.input,
        totalOutputTokens: totals.output,
        totalCostUsd,
      });
      if (runScope) {
        tracing!.endRun(runScope, {
          terminalState: terminal,
          stepCount,
          totalInputTokens: totals.input,
          totalOutputTokens: totals.output,
          totalCostUsd,
        });
      }
    }
  }

  private cost(model: string, input: number, output: number): number {
    const p = this.deps.pricing?.[model];
    if (!p) return 0;
    return (input * p.inputPerMTok + output * p.outputPerMTok) / 1_000_000;
  }

  /** Attribute eval regressions to code vs prompt vs model changes (spec §5). */
  private configHash(provider: ProviderAdapter, opts: RunOptions): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          provider: provider.name,
          model: provider.model,
          maxSteps: opts.maxSteps ?? 8,
          budget: { ...DEFAULT_BUDGET, ...opts.tokenBudget },
          systemPrompt: this.deps.systemPrompt,
          tools: this.deps.registry.specs().map((t) => t.name),
        }),
      )
      .digest("hex")
      .slice(0, 16);
  }
}

/** In-memory store for Vitest. */
export class MemoryRunStore implements RunStore {
  runs = new Map<string, Record<string, unknown>>();
  steps: StepRecord[] = [];
  ledger: StepRecord[] = [];

  async createRun(row: { id: string } & Record<string, unknown>) {
    this.runs.set(row.id, { ...row, terminalState: null });
  }
  async appendStep(record: StepRecord) {
    this.steps.push(record);
  }
  async recordLedger(record: StepRecord) {
    this.ledger.push(record);
  }
  async finishRun(row: { id: string } & Record<string, unknown>) {
    this.runs.set(row.id, { ...(this.runs.get(row.id) ?? {}), ...row });
  }
}
