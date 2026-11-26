/**
 * Unwraps the `cause` chain so an error names what actually went wrong.
 *
 * Node wraps transport failures in a generic outer error — `fetch failed`,
 * `Failed query: ...` — and puts the diagnosis one level down in `cause`.
 * Twice on this project a dropped cause chain cost an hour: `fetch failed`
 * was Ollama being down, and `Failed query: insert into agent_runs` was a
 * missing migration. Both were a single `cause.message` away.
 *
 * Postgres errors carry a SQLSTATE in `code`; a socket failure carries
 * ECONNREFUSED. The cause's code wins when both are present, because the
 * inner one is the specific failure.
 */
export interface ErrorDescription {
  message: string;
  cause?: string;
  code?: string;
  status?: number;
}

export function describeError(err: unknown): ErrorDescription {
  if (!(err instanceof Error)) return { message: "run failed" };
  const out: ErrorDescription = { message: err.message.split("\n")[0] };

  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") out.code = code;

  // Anthropic SDK errors carry the HTTP status, which is the whole diagnosis:
  // 401 is a bad key, 404 a wrong model name, 429 a rate limit, 529 overload.
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") out.status = status;

  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    out.cause = cause.message.split("\n")[0];
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string") out.code = causeCode;
  }
  return out;
}

/** One-line rendering for a log or an SSE payload. */
export function formatError(err: unknown): string {
  const d = describeError(err);
  const parts = [d.message];
  if (d.status !== undefined) parts.push(`status=${d.status}`);
  if (d.code) parts.push(`code=${d.code}`);
  if (d.cause) parts.push(`cause=${d.cause}`);
  return parts.join(" ");
}
