import { useState, useMemo, useEffect } from 'react';
import { SEED_POSTS } from '../data/seedPosts.js';
import { CATEGORIES, CATEGORY_LABELS, catById } from '../lib/categories.js';
import * as api from '../lib/api.js';

import Header from './Header.jsx';
import Sidebar from './Sidebar.jsx';
import PostList from './PostList.jsx';
import PostDetail from './PostDetail.jsx';

/**
 * Hydrate seed data into the same shape the /api/posts endpoint returns.
 * Used as a fallback when the database is unreachable so the demo still works.
 */
function hydrateSeedAsApiShape(seed) {
  return seed.map((p) => ({
    ...p,
    category: p.seedCategory ? catById(p.seedCategory).label : null,
    confidence: p.seedCategory ? 1 : null,
    reasoning: p.seedCategory ? 'Pre-categorized seed data' : null,
    draft: null,
  }));
}

export default function BenefitsSupportTriage() {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [filterCategory, setFilterCategory] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');

  const [batchProcessing, setBatchProcessing] = useState(false);
  const [processingIds, setProcessingIds] = useState(new Set());
  const [draftLoadingId, setDraftLoadingId] = useState(null);
  const [error, setError] = useState(null);
  const [usingFallback, setUsingFallback] = useState(false);

  // ---- Initial load -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { posts: rows } = await api.listPosts();
        if (cancelled) return;
        setPosts(rows);
        setSelectedId(rows[0]?.id ?? null);
      } catch (e) {
        if (cancelled) return;
        // Database not running? Fall back to the seed so the UI still renders.
        const fallback = hydrateSeedAsApiShape(SEED_POSTS);
        setPosts(fallback);
        setSelectedId(fallback[0]?.id ?? null);
        setUsingFallback(true);
        setError(`API unreachable — showing seed data only. (${e.message})`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Derived state ------------------------------------------------------

  const selected = posts.find((p) => p.id === selectedId);

  const filtered = posts.filter((p) => {
    if (filterStatus !== 'all' && p.status !== filterStatus) return false;
    if (filterCategory === 'all') return true;
    if (filterCategory === 'uncategorized') return !p.category;
    return p.category === filterCategory;
  });

  const stats = useMemo(() => {
    const total = posts.length;
    const answered = posts.filter((p) => p.status === 'answered').length;
    const uncategorized = posts.filter((p) => !p.category).length;
    return { total, answered, open: total - answered, uncategorized };
  }, [posts]);

  const counts = useMemo(() => {
    const c = {};
    CATEGORIES.forEach((cat) => {
      c[cat.label] = 0;
    });
    posts.forEach((p) => {
      if (p.category) c[p.category] = (c[p.category] || 0) + 1;
    });
    return c;
  }, [posts]);

  // ---- Actions ------------------------------------------------------------

  async function handleCategorizeAll() {
    setError(null);
    const targets = posts.filter((p) => !p.category);
    if (targets.length === 0) return;
    setBatchProcessing(true);
    setProcessingIds(new Set(targets.map((t) => t.id)));
    try {
      const results = await Promise.all(
        targets.map(async (t) => {
          try {
            const r = await api.categorizePost({ postId: t.id, title: t.title, body: t.body });
            return { id: t.id, ok: true, ...r };
          } catch (e) {
            return { id: t.id, ok: false, error: e.message };
          }
        })
      );
      setPosts((prev) =>
        prev.map((p) => {
          const r = results.find((x) => x.id === p.id);
          if (!r || !r.ok) return p;
          const valid = CATEGORY_LABELS.includes(r.category);
          return {
            ...p,
            category: valid ? r.category : null,
            confidence: valid ? r.confidence : null,
            reasoning: r.reasoning || null,
          };
        })
      );
      const failures = results.filter((r) => !r.ok);
      if (failures.length) {
        setError(`${failures.length} post(s) failed to categorize. ${failures[0].error}`);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBatchProcessing(false);
      setProcessingIds(new Set());
    }
  }

  async function handleDraftResponse(post) {
    setError(null);
    setDraftLoadingId(post.id);
    try {
      const { draft } = await api.draftResponse({
        postId: post.id,
        title: post.title,
        body: post.body,
      });
      // Update the post's draft field in place — drafts are persisted server-side
      setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, draft } : p)));
    } catch (e) {
      setError(e.message);
    } finally {
      setDraftLoadingId(null);
    }
  }

  // ---- Render -------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stone-950 font-mono text-sm text-stone-500">
        Loading triage queue…
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-stone-950 text-stone-100">
      <div
        className="pointer-events-none fixed inset-0 -z-10 opacity-40"
        style={{
          background:
            'radial-gradient(ellipse 80% 50% at 50% -20%, rgba(245, 158, 11, 0.08), transparent 60%), radial-gradient(ellipse 60% 50% at 80% 100%, rgba(20, 184, 166, 0.06), transparent 60%)',
        }}
      />

      <Header
        batchProcessing={batchProcessing}
        processingCount={processingIds.size}
        uncategorizedCount={stats.uncategorized}
        onCategorizeAll={handleCategorizeAll}
      />

      {error && (
        <div className="border-b border-rose-900/50 bg-rose-950/40 px-6 py-2 font-mono text-xs text-rose-300">
          {error}
        </div>
      )}
      {usingFallback && !error && (
        <div className="border-b border-amber-900/50 bg-amber-950/40 px-6 py-2 font-mono text-xs text-amber-300">
          Demo mode — connect a Postgres instance and run npm run db:setup to enable persistence.
        </div>
      )}

      <div className="mx-auto grid max-w-[1400px] grid-cols-12 gap-0">
        <Sidebar
          stats={stats}
          counts={counts}
          totalPosts={posts.length}
          filterStatus={filterStatus}
          setFilterStatus={setFilterStatus}
          filterCategory={filterCategory}
          setFilterCategory={setFilterCategory}
        />

        <PostList
          posts={filtered}
          selectedId={selectedId}
          onSelect={setSelectedId}
          processingIds={processingIds}
        />

        <PostDetail
          post={selected}
          draft={selected?.draft ?? null}
          draftLoading={selected && draftLoadingId === selected.id}
          onDraft={handleDraftResponse}
        />
      </div>

      <footer className="mx-auto max-w-[1400px] border-t border-stone-800/60 px-6 py-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-stone-600">
          benefits triage · agent tool · drafts require human review before posting
        </p>
      </footer>
    </div>
  );
}
