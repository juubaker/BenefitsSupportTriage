import { CategoryChip, ConfidenceBar, StatusDot, Spinner } from './ui.jsx';

export default function PostList({ posts, selectedId, onSelect, processingIds }) {
  return (
    <section className="col-span-12 border-stone-800/80 md:col-span-4 md:border-r">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-stone-800/80 bg-stone-950/90 px-5 py-3 backdrop-blur">
        <p className="font-mono text-xs text-stone-400">
          {posts.length} {posts.length === 1 ? 'post' : 'posts'}
        </p>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-600">sorted: newest</p>
      </div>

      <ul className="divide-y divide-stone-800/60">
        {posts.map((post) => {
          const isProcessing = processingIds.has(post.id);
          const isSelected = post.id === selectedId;
          return (
            <li
              key={post.id}
              onClick={() => onSelect(post.id)}
              className={`group cursor-pointer px-5 py-4 transition ${
                isSelected ? 'bg-stone-900/80' : 'hover:bg-stone-900/40'
              }`}
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[10px] text-stone-500">
                  {post.id} · {post.source}
                </span>
                <StatusDot status={post.status} />
              </div>
              <h3 className="mb-2 font-serif text-[15px] font-medium leading-snug text-stone-100">
                {post.title}
              </h3>
              <p className="mb-3 line-clamp-2 text-[13px] leading-relaxed text-stone-400">{post.body}</p>
              <div className="flex items-center justify-between gap-2">
                {isProcessing ? (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-amber-300">
                    <Spinner className="h-3 w-3" />
                    classifying…
                  </span>
                ) : (
                  <CategoryChip label={post.category || 'uncategorized'} />
                )}
                <ConfidenceBar value={post.confidence} />
              </div>
            </li>
          );
        })}
        {posts.length === 0 && (
          <li className="px-5 py-12 text-center text-sm text-stone-600">No posts match these filters.</li>
        )}
      </ul>
    </section>
  );
}
