// src/components/RagDraftPanel.jsx
//
// Reviewer-pane component for the grounded draft. Posts to /api/draft/grounded
// with { postId, title, body } — same input shape as your existing /api/draft
// route. Renders the draft with [policy:id] citation chips (green = verified,
// red = unverifiable), an evidence panel (policy passages + precedents), and an
// abstention state. Tailwind, matches your stack.

import { useState } from "react";

const API_URL = "/api/draft/grounded";

export default function RagDraftPanel({ post }) {
  // `post` = the selected support post: { id, title, body }
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function runDraft() {
    if (!post?.title || !post?.body) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: post.id, title: post.title, body: post.body }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `HTTP ${res.status}`);
      }
      setResult(await res.json());
    } catch (e) {
      setError(String(e.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  const hasUnverified = result?.citations?.some((c) => !c.verified) ?? false;

  return (
    <div className="flex flex-col gap-4 p-4">
      <button
        className="self-start rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        onClick={runDraft}
        disabled={loading || !post?.title}
      >
        {loading ? "Drafting…" : "Generate grounded draft"}
      </button>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {result?.abstained && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-semibold">Routed to a human</div>
          <div>{result.abstainReason}</div>
          <div className="mt-1 text-xs text-amber-700">
            Top similarity {result.retrieval.topSimilarity.toFixed(3)} — below the
            grounding threshold.
          </div>
        </div>
      )}

      {result && !result.abstained && (
        <>
          {hasUnverified && (
            <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs font-medium text-red-800">
              ⚠ This draft contains a citation that could not be verified against
              retrieved evidence. Review the flagged chip before approving.
            </div>
          )}

          <DraftWithCitations
            draft={result.draft}
            citations={result.citations}
            policy={result.retrieval.policy}
          />

          <EvidencePanel
            policy={result.retrieval.policy}
            precedents={result.retrieval.precedents}
          />
        </>
      )}
    </div>
  );
}

function DraftWithCitations({ draft, citations, policy }) {
  const verifiedById = new Map(citations.map((c) => [c.id, c.verified]));
  const policyById = new Map(policy.map((p) => [p.id, p]));

  const parts = [];
  const regex = /\[policy:(\d+)\]/g;
  let last = 0;
  let m;
  let key = 0;
  while ((m = regex.exec(draft)) !== null) {
    if (m.index > last) parts.push(draft.slice(last, m.index));
    const id = Number(m[1]);
    const verified = verifiedById.get(id) ?? false;
    const p = policyById.get(id);
    parts.push(
      <span
        key={`cite-${key++}`}
        title={p ? `${p.docTitle}${p.section ? " — " + p.section : ""}` : "Unverified citation"}
        className={
          "mx-0.5 inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium " +
          (verified
            ? "bg-green-100 text-green-800"
            : "bg-red-100 text-red-800 line-through")
        }
      >
        policy:{id}
      </span>
    );
    last = regex.lastIndex;
  }
  if (last < draft.length) parts.push(draft.slice(last));

  return (
    <div className="whitespace-pre-wrap rounded-md border border-gray-200 bg-white p-4 text-sm leading-relaxed text-gray-900">
      {parts}
    </div>
  );
}

function EvidencePanel({ policy, precedents }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Policy passages ({policy.length})
        </h3>
        <div className="flex flex-col gap-2">
          {policy.map((p) => (
            <div key={p.id} className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium text-gray-700">
                  [{p.id}] {p.docTitle}
                  {p.section ? ` — ${p.section}` : ""}
                </span>
                <span className="text-gray-400">{p.similarity.toFixed(3)}</span>
              </div>
              <p className="text-gray-600">{p.chunkText}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Precedents ({precedents.length})
        </h3>
        <div className="flex flex-col gap-2">
          {precedents.map((p) => (
            <div key={p.id} className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium text-gray-700">{p.category}</span>
                <span className="text-gray-400">{p.similarity.toFixed(3)}</span>
              </div>
              <p className="mb-1 text-gray-600">{p.caseText}</p>
              <p className="text-gray-500 italic">{p.approvedResponse}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
