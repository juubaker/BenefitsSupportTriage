import { CategoryChip, ConfidenceBar, StatusDot, Spinner } from './ui.jsx';

export default function PostDetail({ post, draft, draftLoading, onDraft }) {
  if (!post) {
    return (
      <section className="col-span-12 px-7 py-6 md:col-span-5">
        <div className="flex h-full items-center justify-center text-sm text-stone-600">Select a post.</div>
      </section>
    );
  }

  return (
    <section className="col-span-12 px-7 py-6 md:col-span-5">
      <article>
        {/* Meta line */}
        <div className="mb-4 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">
            {post.id} · {post.source} · {post.posted}
          </span>
          <StatusDot status={post.status} />
        </div>

        {/* Title */}
        <h2 className="mb-4 font-serif text-[26px] font-medium leading-tight tracking-tight text-stone-50">
          {post.title}
        </h2>

        {/* Tags */}
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <CategoryChip label={post.category || 'uncategorized'} />
          <ConfidenceBar value={post.confidence} />
          <span className="font-mono text-xs text-stone-600">posted by {post.author}</span>
        </div>

        {/* Body */}
        <p className="mb-8 whitespace-pre-line text-[15px] leading-relaxed text-stone-300">{post.body}</p>

        {/* Triage reasoning */}
        {post.reasoning && (
          <div className="mb-6 rounded-md border border-stone-800 bg-stone-900/40 px-4 py-3">
            <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">
              Triage reasoning
            </p>
            <p className="font-serif text-[13px] italic text-stone-400">{post.reasoning}</p>
          </div>
        )}

        {/* Answer or draft */}
        {post.status === 'answered' ? (
          <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-5">
            <div className="mb-3 flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-400/80">
                Resolved response
              </p>
              <span className="font-mono text-[11px] text-emerald-500/70">{post.answeredBy}</span>
            </div>
            <p className="text-[14.5px] leading-relaxed text-stone-200">{post.answer}</p>
          </div>
        ) : (
          <div className="rounded-lg border border-stone-800 bg-stone-900/40 p-5">
            <div className="mb-3 flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-400/80">
                Awaiting response
              </p>
              {draft && (
                <span className="font-mono text-[11px] text-amber-500/70">
                  ai draft · review before posting
                </span>
              )}
            </div>

            {draft ? (
              <p className="mb-4 whitespace-pre-line text-[14.5px] leading-relaxed text-stone-200">{draft}</p>
            ) : (
              <p className="mb-4 font-serif text-[13px] italic text-stone-500">
                No response posted yet. Generate a draft based on Benefits configuration knowledge.
              </p>
            )}

            <button
              onClick={() => onDraft(post)}
              disabled={draftLoading}
              className="inline-flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3.5 py-2 text-sm text-amber-200 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {draftLoading ? (
                <>
                  <Spinner /> Drafting…
                </>
              ) : draft ? (
                <>↻ Regenerate draft</>
              ) : (
                <>✦ Generate draft response</>
              )}
            </button>
          </div>
        )}
      </article>
    </section>
  );
}
