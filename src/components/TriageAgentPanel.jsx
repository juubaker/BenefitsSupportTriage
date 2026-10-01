import { useRef, useState } from 'react';

/**
 * Live agent console for the v2 /api/triage SSE endpoint.
 *
 * The endpoint streams Server-Sent Events from a POST, so the browser's native
 * EventSource (GET-only) can't be used. We read response.body with a reader and
 * parse the `event:` / `data:` frames by hand, dispatching each to state as it
 * arrives — the agent's steps and tool calls render live, then the final triage.
 *
 * Uses the Vite dev proxy (/api -> :3001), so no CORS handling is needed.
 */
export default function TriageAgentPanel() {
  const [subject, setSubject] = useState('spouse lost job');
  const [body, setBody] = useState('My wife was laid off. Can I add her to my plan mid-year?');
  const [events, setEvents] = useState([]);
  const [result, setResult] = useState(null);
  const [terminal, setTerminal] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  async function runTriage() {
    setEvents([]);
    setResult(null);
    setTerminal(null);
    setError(null);
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticketId: `UI-${Date.now()}`,
          subject,
          body,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => res.statusText);
        throw new Error(`Request failed (${res.status}): ${detail}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // SSE frames are separated by a blank line; each frame has `event:` and `data:` lines.
      const dispatch = (frame) => {
        const lines = frame.split('\n');
        let type = 'message';
        let dataRaw = '';
        for (const line of lines) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) dataRaw += line.slice(5).trim();
        }
        if (type === 'message' && !dataRaw) return; // keep-alive comment frame
        let data = null;
        try {
          data = dataRaw ? JSON.parse(dataRaw) : null;
        } catch {
          data = { raw: dataRaw };
        }
        setEvents((prev) => [...prev, { type, data }]);
        if (type === 'terminal') {
          setTerminal(data?.state ?? 'unknown');
          if (data?.result) setResult(data.result);
        }
        if (type === 'error') setError(data?.message ?? 'stream error');
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (frame.trim()) dispatch(frame);
        }
      }
      if (buffer.trim()) dispatch(buffer);
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-8">
      <h2 className="mb-1 font-mono text-sm uppercase tracking-[0.2em] text-amber-400">
        Live triage agent
      </h2>
      <p className="mb-6 font-mono text-xs text-stone-500">
        Streams the agent loop from /api/triage — steps, tool calls, and the grounded result.
      </p>

      <div className="grid gap-3">
        <label className="font-mono text-[10px] uppercase tracking-widest text-stone-500">
          Subject
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="mt-1 w-full rounded border border-stone-800 bg-stone-900 px-3 py-2 font-mono text-sm text-stone-100 focus:border-amber-500 focus:outline-none"
          />
        </label>
        <label className="font-mono text-[10px] uppercase tracking-widest text-stone-500">
          Ticket body
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded border border-stone-800 bg-stone-900 px-3 py-2 font-mono text-sm text-stone-100 focus:border-amber-500 focus:outline-none"
          />
        </label>
        <div className="flex gap-2">
          <button
            onClick={runTriage}
            disabled={running}
            className="rounded bg-amber-500 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-widest text-stone-950 transition hover:bg-amber-400 disabled:opacity-40"
          >
            {running ? 'Running…' : 'Run triage'}
          </button>
          {running && (
            <button
              onClick={stop}
              className="rounded border border-stone-700 px-4 py-2 font-mono text-xs uppercase tracking-widest text-stone-400 hover:border-stone-500"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded border border-rose-900/50 bg-rose-950/40 px-4 py-2 font-mono text-xs text-rose-300">
          {error}
        </div>
      )}

      {events.length > 0 && (
        <div className="mt-6 rounded border border-stone-800 bg-stone-900/50 p-4">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-stone-600">
            Event stream
          </div>
          <ol className="space-y-1 font-mono text-xs">
            {events.map((e, i) => (
              <li key={i} className="text-stone-300">
                <EventLine event={e} />
              </li>
            ))}
          </ol>
        </div>
      )}

      {result && (
        <div className="mt-6 rounded border border-teal-900/50 bg-teal-950/20 p-5">
          <div className="mb-3 flex items-center gap-2">
            <span className="rounded bg-teal-500/20 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-teal-300">
              {result.category}
            </span>
            <span className="rounded bg-amber-500/20 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-amber-300">
              {result.priority}
            </span>
            {result.escalated && (
              <span className="rounded bg-rose-500/20 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-rose-300">
                escalated
              </span>
            )}
          </div>
          <p className="mb-3 text-sm leading-relaxed text-stone-200">{result.summary}</p>
          {result.citations?.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {result.citations.map((c) => (
                <span
                  key={c}
                  className="rounded border border-stone-700 bg-stone-900 px-2 py-0.5 font-mono text-[10px] text-stone-400"
                >
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {terminal && terminal !== 'completed' && (
        <div className="mt-4 font-mono text-xs text-amber-400">
          Run ended: {terminal}
        </div>
      )}
    </div>
  );
}

function EventLine({ event }) {
  const { type, data } = event;
  switch (type) {
    case 'run_started':
      return <span className="text-stone-500">▶ run started · {data?.provider}/{data?.model}</span>;
    case 'step_started':
      return <span className="text-stone-500">── step {data?.step}</span>;
    case 'tool_call':
      return (
        <span className="text-amber-300">
          → {data?.name}({JSON.stringify(data?.args)})
        </span>
      );
    case 'tool_result':
      return (
        <span className={data?.isError ? 'text-rose-400' : 'text-teal-300'}>
          {data?.isError ? '✗' : '✓'} {data?.name}: {data?.summary}
        </span>
      );
    case 'loop_guard':
      return <span className="text-amber-400">⚠ loop guard: {data?.tool} ({data?.action})</span>;
    case 'compaction':
      return <span className="text-stone-500">⚠ compaction · ~{data?.droppedApproxTokens} tokens</span>;
    case 'model_delta':
      return <span className="text-stone-400">{data?.text}</span>;
    case 'terminal':
      return <span className="text-stone-500">■ terminal · {data?.state}</span>;
    default:
      return <span className="text-stone-600">{type}</span>;
  }
}
