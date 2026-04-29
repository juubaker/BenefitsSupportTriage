// Benefits taxonomy. Keep in sync with the CATEGORIES array in server/index.js.

export const CATEGORIES = [
  { id: 'life-events',     label: 'Life Events',          tint: 'bg-amber-500/15  text-amber-300  ring-amber-500/30',  swatch: '#fbbf24' },
  { id: 'open-enrollment', label: 'Open Enrollment',      tint: 'bg-sky-500/15    text-sky-300    ring-sky-500/30',    swatch: '#7dd3fc' },
  { id: 'eligibility',     label: 'Eligibility Profiles', tint: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30', swatch: '#6ee7b7' },
  { id: 'rates',           label: 'Standard Rates',       tint: 'bg-rose-500/15   text-rose-300   ring-rose-500/30',   swatch: '#fda4af' },
  { id: 'plan-config',     label: 'Plan Configuration',   tint: 'bg-violet-500/15 text-violet-300 ring-violet-500/30', swatch: '#c4b5fd' },
  { id: 'extracts',        label: 'Vendor Extracts',      tint: 'bg-cyan-500/15   text-cyan-300   ring-cyan-500/30',   swatch: '#67e8f9' },
  { id: 'self-service',    label: 'Self-Service',         tint: 'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30', swatch: '#f0abfc' },
  { id: 'reports',         label: 'Reports & Analytics',  tint: 'bg-lime-500/15   text-lime-300   ring-lime-500/30',   swatch: '#bef264' },
  { id: 'aca',             label: 'ACA Compliance',       tint: 'bg-orange-500/15 text-orange-300 ring-orange-500/30', swatch: '#fdba74' },
  { id: 'cobra',           label: 'COBRA',                tint: 'bg-teal-500/15   text-teal-300   ring-teal-500/30',   swatch: '#5eead4' },
];

export const CATEGORY_LABELS = CATEGORIES.map((c) => c.label);

export const catById = (id) => CATEGORIES.find((c) => c.id === id);
export const catByLabel = (label) => CATEGORIES.find((c) => c.label === label);
