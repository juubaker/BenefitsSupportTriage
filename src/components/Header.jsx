import { Spinner } from './ui.jsx';

export default function Header({ batchProcessing, processingCount, uncategorizedCount, onCategorizeAll }) {
  return (
    <header className="border-b border-stone-800/80 bg-stone-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-5">
        <div className="flex items-center gap-4">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-md bg-amber-500/10 ring-1 ring-amber-500/40"
            title="Benefits Support Triage"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-amber-300">
              <path d="M12 2 4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4Z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </div>
          <div>
            <h1 className="font-serif text-xl leading-none tracking-tight">
              <span className="font-medium">Benefits Support</span>
              <span className="text-stone-500"> · </span>
              <span className="italic text-amber-300/90">Triage Agent</span>
            </h1>
            <p className="mt-1 font-mono text-xs text-stone-500">oracle hcm cloud · benefits · v0.4</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-2 rounded-md border border-stone-800 bg-stone-900/60 px-3 py-1.5 font-mono text-xs text-stone-400 md:flex">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            api ready
          </div>
          <button
            onClick={onCategorizeAll}
            disabled={batchProcessing || uncategorizedCount === 0}
            className="rounded-md bg-amber-400 px-4 py-2 text-sm font-medium text-stone-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-stone-800 disabled:text-stone-500"
          >
            {batchProcessing ? (
              <span className="flex items-center gap-2">
                <Spinner />
                Categorizing {processingCount}…
              </span>
            ) : uncategorizedCount > 0 ? (
              <>Categorize {uncategorizedCount} new</>
            ) : (
              <>All categorized</>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
