import { catByLabel } from '../lib/categories.js';

export function CategoryChip({ label, dim = false }) {
  const cat = catByLabel(label);
  if (!cat) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-700/30 px-2 py-0.5 text-[11px] font-medium italic text-stone-400 ring-1 ring-stone-600/40">
        uncategorized
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${cat.tint} ${dim ? 'opacity-60' : ''}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

export function ConfidenceBar({ value }) {
  if (value == null) return null;
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-1.5" title={`Confidence ${pct}%`}>
      <div className="h-1 w-10 overflow-hidden rounded-full bg-stone-700/60">
        <div className="h-full rounded-full bg-amber-400/80" style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-[10px] text-stone-500">{pct}</span>
    </div>
  );
}

export function StatusDot({ status }) {
  const isAnswered = status === 'answered';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`h-1.5 w-1.5 rounded-full ${isAnswered ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`}
      />
      <span className="font-mono text-[10px] uppercase tracking-wider text-stone-500">
        {isAnswered ? 'answered' : 'open'}
      </span>
    </span>
  );
}

export function Spinner({ className = 'h-3.5 w-3.5' }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function StatBlock({ label, value, accent }) {
  const ring =
    accent === 'amber'   ? 'ring-amber-500/30'   :
    accent === 'emerald' ? 'ring-emerald-500/30' :
    accent === 'rose'    ? 'ring-rose-500/30'    :
                           'ring-stone-700/60';
  const text =
    accent === 'amber'   ? 'text-amber-300'   :
    accent === 'emerald' ? 'text-emerald-300' :
    accent === 'rose'    ? 'text-rose-300'    :
                           'text-stone-200';
  return (
    <div className={`rounded-md bg-stone-900/60 px-3 py-2.5 ring-1 ${ring}`}>
      <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-stone-500">{label}</p>
      <p className={`mt-0.5 font-serif text-2xl font-medium leading-none tabular-nums ${text}`}>{value}</p>
    </div>
  );
}

export function FilterRow({ active, onClick, label, count, category, dim }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] transition ${
        active
          ? 'bg-stone-100/95 text-stone-900'
          : 'text-stone-400 hover:bg-stone-900 hover:text-stone-200'
      } ${dim && !active ? 'italic text-stone-500' : ''}`}
    >
      <span className="flex items-center gap-2 truncate">
        {category && (
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: category.swatch }}
          />
        )}
        <span className="truncate">{label}</span>
      </span>
      <span
        className={`font-mono text-[11px] tabular-nums ${active ? 'text-stone-500' : 'text-stone-600'}`}
      >
        {count}
      </span>
    </button>
  );
}
