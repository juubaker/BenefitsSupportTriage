import { useState } from 'react';
import BenefitsSupportTriage from './components/BenefitsSupportTriage.jsx';
import TriageAgentPanel from './components/TriageAgentPanel.jsx';

export default function App() {
  const [view, setView] = useState('queue'); // 'queue' | 'agent'

  return (
    <div className="min-h-screen bg-stone-950">
      {/* view switch — matches the dark/amber theme */}
      <div className="flex gap-1 border-b border-stone-800 bg-stone-950 px-6 py-2">
        <button
          onClick={() => setView('queue')}
          className={`rounded px-3 py-1 font-mono text-[10px] uppercase tracking-widest transition ${
            view === 'queue'
              ? 'bg-stone-800 text-amber-300'
              : 'text-stone-500 hover:text-stone-300'
          }`}
        >
          Triage queue
        </button>
        <button
          onClick={() => setView('agent')}
          className={`rounded px-3 py-1 font-mono text-[10px] uppercase tracking-widest transition ${
            view === 'agent'
              ? 'bg-stone-800 text-amber-300'
              : 'text-stone-500 hover:text-stone-300'
          }`}
        >
          Live agent
        </button>
      </div>

      {view === 'queue' ? <BenefitsSupportTriage /> : <TriageAgentPanel />}
    </div>
  );
}
