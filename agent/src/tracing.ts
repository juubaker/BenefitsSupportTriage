import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { createHash } from "node:crypto";
import { stableStringify } from "./loop.js";
import type { ExecuteWrapper } from "./registry.js";
import type {
  ChatRequest,
  ProviderAdapter,
  ProviderTurn,
  StepRecord,
  TerminalState,
} from "./types.js";

/**
 * Phase 2 tracing (spec §7). Span hierarchy:
 *   HTTP (auto)  ->  agent.run  ->  agent.step  ->  gen_ai.chat | agent.tool.{name}
 * Compaction and provider failover land as span events. Inbound W3C
 * traceparent (e.g. from the DeepEval sidecar) parents the whole run, so eval
 * failures link straight to the spans of the run being judged.
 */

const propagator = new W3CTraceContextPropagator();

/** Call once at process start. Returns a shutdown hook for graceful exit. */
export function initTracing(
  serviceName = "benefits-triage-agent",
  otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318",
): () => Promise<void> {
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
      ),
    ],
  });
  provider.register();
  return () => provider.shutdown();
}

export interface RunScope {
  span: Span;
  ctx: Context;
  traceId: string;
}

export interface StepScope {
  span: Span;
  ctx: Context;
  spanId: string;
}

export class AgentTracing {
  constructor(private tracer: Tracer = trace.getTracer("agent-harness")) {}

  startRun(
    runId: string,
    ticketId: string,
    provider: string,
    model: string,
    traceparent?: string,
  ): RunScope {
    const parent = traceparent
      ? propagator.extract(context.active(), { traceparent }, {
          get: (c, k) => (c as Record<string, string>)[k],
          keys: (c) => Object.keys(c as Record<string, string>),
        })
      : context.active();
    const span = this.tracer.startSpan(
      "agent.run",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "agent.run.id": runId,
          "agent.ticket.id": ticketId,
          "gen_ai.system": provider,
          "gen_ai.request.model": model,
        },
      },
      parent,
    );
    return { span, ctx: trace.setSpan(parent, span), traceId: span.spanContext().traceId };
  }

  endRun(
    scope: RunScope,
    summary: {
      terminalState: TerminalState;
      stepCount: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCostUsd: number;
    },
  ): void {
    scope.span.setAttributes({
      "agent.terminal_state": summary.terminalState,
      "agent.step_count": summary.stepCount,
      "gen_ai.usage.input_tokens": summary.totalInputTokens,
      "gen_ai.usage.output_tokens": summary.totalOutputTokens,
      "agent.cost_usd": summary.totalCostUsd,
    });
    if (summary.terminalState === "tool_failure" || summary.terminalState === "aborted") {
      scope.span.setStatus({ code: SpanStatusCode.ERROR, message: summary.terminalState });
    }
    scope.span.end();
  }

  startStep(run: RunScope, stepNo: number): StepScope {
    const span = this.tracer.startSpan(
      "agent.step",
      { kind: SpanKind.INTERNAL, attributes: { "agent.step.no": stepNo } },
      run.ctx,
    );
    return { span, ctx: trace.setSpan(run.ctx, span), spanId: span.spanContext().spanId };
  }

  endStep(scope: StepScope, record: StepRecord): void {
    scope.span.setAttributes({
      "agent.step.stop_reason": record.modelStopReason,
      "agent.step.tool_calls": record.toolCalls.map((c) => c.name).join(","),
    });
    scope.span.end();
  }

  recordEvent(scope: StepScope | RunScope, name: string, attrs: Record<string, string | number>): void {
    scope.span.addEvent(name, attrs);
  }

  within<T>(ctx: Context, fn: () => T): T {
    return context.with(ctx, fn);
  }

  /** gen_ai.chat spans, parented by whatever context is active (the step). */
  instrumentProvider(p: ProviderAdapter): ProviderAdapter {
    const tracer = this.tracer;
    return {
      name: p.name,
      model: p.model,
      chat(req: ChatRequest, onDelta?: (t: string) => void): Promise<ProviderTurn> {
        return tracer.startActiveSpan(
          `gen_ai.chat ${p.model}`,
          {
            kind: SpanKind.CLIENT,
            attributes: {
              "gen_ai.operation.name": "chat",
              "gen_ai.system": p.name,
              "gen_ai.request.model": p.model,
              "gen_ai.request.temperature": req.temperature,
              "gen_ai.request.max_tokens": req.maxTokens,
              "agent.tools_enabled": req.tools.length,
            },
          },
          async (span) => {
            try {
              const turn = await p.chat(req, onDelta);
              span.setAttributes({
                "gen_ai.response.finish_reasons": turn.stopReason,
                "gen_ai.usage.input_tokens": turn.usage.inputTokens,
                "gen_ai.usage.output_tokens": turn.usage.outputTokens,
                "gen_ai.usage.cache_read_tokens": turn.usage.cacheReadTokens,
                "gen_ai.usage.cache_write_tokens": turn.usage.cacheWriteTokens,
              });
              return turn;
            } catch (err) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: err instanceof Error ? err.message : String(err),
              });
              throw err;
            } finally {
              span.end();
            }
          },
        );
      },
    };
  }

  /** agent.tool.{name} spans around registry execution (args hashed, never raw). */
  executeWrapper(): ExecuteWrapper {
    const tracer = this.tracer;
    return (name, rawArgs, _ctx, next) =>
      tracer.startActiveSpan(
        `agent.tool.${name}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "agent.tool.name": name,
            "agent.tool.args_hash": createHash("sha256")
              .update(stableStringify(rawArgs))
              .digest("hex")
              .slice(0, 16),
          },
        },
        async (span) => {
          try {
            const result = await next();
            span.setAttributes({ "agent.tool.ok": result.ok });
            if (!result.ok) {
              span.setAttributes({ "agent.tool.error_kind": result.kind });
              span.setStatus({ code: SpanStatusCode.ERROR, message: result.error });
            } else {
              span.setAttributes({
                "agent.tool.result_bytes": JSON.stringify(result.output.data).length,
              });
            }
            return result;
          } finally {
            span.end();
          }
        },
      );
  }
}
