# agent/ — v2 Agent sub-package

Standalone TypeScript sub-package (peer to `rag/` and `server/`), following the
same conventions as `rag/`: ESM + NodeNext, `tsx` to run, `strict`, its own
`node_modules`. Holds the v2 rearchitecture — harness, bounded loop, token
budgeter, OTel tracing, and the optional graph layer.

## Layout (code and tests separated, per the modularity goal)

```
agent/
├── package.json           # ESM, NodeNext, tsx — matches rag/ conventions
├── tsconfig.json
├── vitest.config.ts       # node env, .ts tests — isolated from the root happy-dom config
├── src/
│   ├── types.ts           registry.ts  loop.ts  harness.ts  store.ts
│   ├── budgeter.ts        tracing.ts   tools.ts
│   ├── providers/         # thin typed adapters (see note below)
│   ├── graph/             # graph.ts, graph-tool.ts, graph-extract.ts (Phase 4, opt-in)
│   ├── db/schema/         # agent.ts, graph.ts (Drizzle)
│   ├── routes/            # triage.ts (SSE), runs.ts (debug/get_run_trace)
│   └── testing/           # fake-provider.ts
├── tests/                 # ALL tests here — separated from src/
└── scripts/               # smoke.ts, extract-graph.ts (wire before use)
```

## Install & run

```
cd agent
npm install --legacy-peer-deps     # peer-dep resolution; see note
npm run typecheck                  # tsc --noEmit — clean
npm test                           # vitest run — 30 pass, 1 skip (live-PG graph test)
npm run smoke -- --fake            # loop end-to-end, no model
```

`--legacy-peer-deps` is needed on install: the OpenTelemetry packages declare
overlapping peer ranges on `@opentelemetry/api` that npm's strict resolver
rejects (the "edgesOut" error). Legacy resolution is the standard workaround and
does not affect runtime.

## Providers — reuses your existing server/llm

`src/providers/` currently contains self-contained TS adapters. To reuse your
working `server/llm/anthropic.js` and `ollama.js` instead (recommended — one
source of truth), replace the bodies with a thin shim that imports those JS
files and wraps them to the `ProviderAdapter` interface in `src/types.ts`. The
interface is small (one `chat()` method); the shim is ~20 lines per provider.
Left as standalone TS for now so the package compiles and tests green out of the
box — swap at your convenience.

## NodeNext imports

Every relative import carries an explicit `.js` extension (e.g.
`from "./types.js"`), required by NodeNext — the same rule your `rag/` package
follows. Keep this when adding files.

## Eval work

The Python eval harness is NOT inside this package — it lives at the repo-level
`evals/` folder alongside your existing files. See `evals/V2_CONSOLIDATION.md`.
