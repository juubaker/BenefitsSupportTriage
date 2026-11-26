/**
 * Retry a provider call when the failure is transient.
 *
 * There was no retry anywhere in the harness: one dropped stream killed a run.
 * A full nightly suite that had scored 40/40 an hour earlier came back 32/40,
 * and every failure was the same log line —
 *
 *   [agent] provider anthropic (claude-sonnet-4-6) failed on run ...:
 *   terminated cause=terminated
 *
 * `terminated` is undici's error for a fetch stream cut mid-flight. Under a
 * suite's sustained load some streams get dropped; the runs that failed were
 * the slow ones (55-67s against a 10-20s norm), and they ended `aborted` or
 * `max_steps` with no terminal decision, which reads in a scorecard as the
 * model forgetting how to call a tool.
 *
 * The distinction that matters is transient versus permanent. A dropped socket,
 * a rate limit and a 529 are worth another attempt; a 400, 401 or 404 will fail
 * identically forever and retrying only delays a clear error. The harness
 * previously treated them alike: fail over, or on a pinned provider, die.
 *
 * This decorates the adapter rather than living in the loop, so both call sites
 * in loop.ts and both providers get it once.
 */

import type { ChatRequest, ProviderAdapter, ProviderTurn } from "../types.js";
import { formatError } from "../describe-error.js";

export interface RetryOptions {
  /** Total attempts including the first. 1 disables retrying. */
  attempts?: number;
  /** First backoff in ms; doubles each attempt. */
  baseDelayMs?: number;
  /** Cap on any single backoff. */
  maxDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const DEFAULTS = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

/**
 * Statuses worth another attempt. 408 request timeout, 409 conflict, 429 rate
 * limit, and the 5xx family including Anthropic's 529 overloaded.
 */
const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/**
 * Statuses that will fail the same way forever: a malformed request, a bad or
 * unauthorized key, a model name that does not exist, a payload too large, a
 * schema the API rejects. 400 also covers an empty credit balance, which is
 * exactly the error that must surface immediately rather than after backoff.
 */
const PERMANENT_STATUS = new Set([400, 401, 403, 404, 413, 422]);

/** undici and Node socket failures that mean "try again", not "this is wrong". */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function isAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return err.name === "AbortError" || code === "ABORT_ERR";
}

export function isTransient(err: unknown): boolean {
  // An abort is a decision, not a fault: the client disconnected or the run was
  // cancelled. Retrying would restart work nobody is waiting for. This matters
  // because our own abort propagates into undici as `terminated` too, so the
  // signal is checked before the message.
  if (isAbort(err)) return false;
  if (!(err instanceof Error)) return false;

  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") {
    if (PERMANENT_STATUS.has(status)) return false;
    if (TRANSIENT_STATUS.has(status)) return true;
    // An unknown 4xx is a client error: assume it stays broken.
    return status >= 500;
  }

  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (TRANSIENT_CODES.has(code)) return true;
    // Ollama or the API not listening at all. Retrying cannot help and hides a
    // clear "start it" error behind several seconds of backoff.
    if (code === "ECONNREFUSED" || code === "ENOTFOUND") return false;
  }

  const haystack = `${err.message} ${(err as { cause?: Error }).cause?.message ?? ""}`.toLowerCase();
  return (
    haystack.includes("terminated") ||
    haystack.includes("socket hang up") ||
    haystack.includes("fetch failed") ||
    haystack.includes("premature close") ||
    haystack.includes("other side closed")
  );
}

/** Honour a server's Retry-After (seconds, or an HTTP date) when it sends one. */
function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown }).headers;
  if (!headers) return undefined;
  const get = (k: string): string | undefined => {
    if (typeof (headers as Headers).get === "function") {
      return (headers as Headers).get(k) ?? undefined;
    }
    const rec = headers as Record<string, string | undefined>;
    return rec[k] ?? rec[k.toLowerCase()];
  };
  const raw = get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(raw);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function withRetry(inner: ProviderAdapter, options: RetryOptions = {}): ProviderAdapter {
  const attempts = Math.max(1, options.attempts ?? DEFAULTS.attempts);
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = options.sleep ?? defaultSleep;

  return {
    name: inner.name,
    model: inner.model,
    async chat(req: ChatRequest, onDelta?: (text: string) => void): Promise<ProviderTurn> {
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await inner.chat(req, onDelta);
        } catch (err) {
          lastError = err;
          const isLast = attempt === attempts;
          // Re-check the signal each time: a client that disconnected during
          // the backoff should not have another attempt made on its behalf.
          if (isLast || !isTransient(err) || req.signal?.aborted) throw err;

          const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
          // Jitter so a suite's concurrent runs do not retry in lockstep.
          const jittered = backoff / 2 + Math.random() * (backoff / 2);
          const delayMs = Math.round(retryAfterMs(err) ?? jittered);

          options.onRetry?.({ attempt, delayMs, error: err });
          // eslint-disable-next-line no-console
          console.warn(
            `[agent] ${inner.name} (${inner.model}) attempt ${attempt}/${attempts} failed, ` +
              `retrying in ${delayMs}ms: ${formatError(err)}`,
          );
          await sleep(delayMs);
        }
      }
      throw lastError;
    },
  };
}
