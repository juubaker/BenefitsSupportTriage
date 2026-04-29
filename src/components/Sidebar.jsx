import { CATEGORIES } from '../lib/categories.js';
import { StatBlock, FilterRow } from './ui.jsx';

export default function Sidebar({
  stats,
  counts,
  totalPosts,
  filterStatus,
  setFilterStatus,
  filterCategory,
  setFilterCategory,
}) {
  return (
    <aside className="col-span-12 border-stone-800/80 px-6 py-6 md:col-span-3 md:border-r">
      {/* Stats */}
      <div className="mb-6">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">Queue</p>
        <div className="grid grid-cols-2 gap-2">
          <StatBlock label="Total" value={stats.total} />
          <StatBlock label="Open" value={stats.open} accent="amber" />
          <StatBlock label="Answered" value={stats.answered} accent="emerald" />
          <StatBlock label="Untriaged" value={stats.uncategorized} accent="rose" />
        </div>
      </div>

      {/* Status filter */}
      <div className="mb-6">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">Status</p>
        <div className="flex flex-wrap gap-1.5">
          {['all', 'open', 'answered'].map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={`rounded-md px-2.5 py-1 text-xs transition ${
                filterStatus === s
                  ? 'bg-stone-100 text-stone-900'
                  : 'bg-stone-900 text-stone-400 hover:bg-stone-800 hover:text-stone-200'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Categories */}
      <div>
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">Categories</p>
        <div className="space-y-0.5">
          <FilterRow
            active={filterCategory === 'all'}
            onClick={() => setFilterCategory('all')}
            label="All categories"
            count={totalPosts}
          />
          <FilterRow
            active={filterCategory === 'uncategorized'}
            onClick={() => setFilterCategory('uncategorized')}
            label="Uncategorized"
            count={stats.uncategorized}
            dim
          />
          <div className="my-2 h-px bg-stone-800/80" />
          {CATEGORIES.map((cat) => (
            <FilterRow
              key={cat.id}
              active={filterCategory === cat.label}
              onClick={() => setFilterCategory(cat.label)}
              label={cat.label}
              count={counts[cat.label] || 0}
              category={cat}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}
