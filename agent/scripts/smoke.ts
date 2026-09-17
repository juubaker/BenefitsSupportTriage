/**
 * Phase 1 smoke test — one real ticket through the full loop.
 *
 *   npx tsx scripts/smoke.ts                 # local Ollama (OLLAMA_MODEL, default llama3.1)
 *   npx tsx scripts/smoke.ts --provider anthropic   # needs ANTHROPIC_API_KEY
 *   npx tsx scripts/smoke.ts --fake          # scripted provider, no model (sanity-check the script itself)
 *
 * Services are stubbed with a tiny in-memory policy corpus (keyword scoring) so
 * no Postgres is needed: this validates loop + adapter mechanics — streaming,
 * tool-call round-trips, terminal behavior, usage accounting — not retrieval
 * quality. Point `buildRegistry` at your real services to smoke those too.
 */
import { AgentHarness, MemoryRunStore } from "../src/harness.js";
import { buildProviders } from "../src/providers/index.js";
import { FakeProvider } from "../src/testing/fake-provider.js";
import { buildRegistry, SYSTEM_PROMPT, type TriageServices } from "../src/tools.js";
import type { AgentEvent, ProviderName } from "../src/types.js";

// ---------- Stub services: tiny corpus, keyword overlap scoring ----------

const POLICY_CHUNKS = [
  {
    chunkId: "chunk-qle-12",
    text: "Qualifying life events (QLEs) — including a spouse's involuntary loss of other coverage — open a 31-day special enrollment window during which the employee may add dependents and change plan elections outside open enrollment.",
  },
  {
    chunkId: "chunk-cobra-04",
    text: "COBRA continuation lets a spouse who loses employer coverage continue that prior plan for up to 18 months at full premium plus a 2% administrative fee. Electing COBRA does not remove special-enrollment rights under the employee's plan.",
  },
  {
    chunkId: "chunk-docs-31",
    text: "Special enrollment requests require proof of the qualifying event, such as a coverage-termination letter from the prior carrier, submitted within the 31-day window via the benefits portal.",
  },
  {
    chunkId: "chunk-hsa-22",
    text: "HSA contribution limits are prorated by months of HDHP eligibility; mid-year plan changes may affect the annual maximum.",
  },
];

const RESOLVED_TICKETS = [
  {
    ticketId: "R-2201",
    resolution:
      "Spouse laid off; confirmed QLE special enrollment, employee added spouse to PPO within 31 days with termination letter as proof. Category: enrollment, priority high.",
  },
  {
    ticketId: "R-1876",
    resolution:
      "Employee asked COBRA vs joining spouse plan; compared premiums, chose special enrollment onto employee plan. Category: enrollment.",
  },
];

function score(query: string, text: string): number {
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
  if (terms.length === 0) return 0;
  const hay = text.toLowerCase();
  return terms.filter((t) => hay.includes(t)).length / terms.length;
}

function stubServices(log: (line: string) => void): TriageServices {
  return {
    async searchPolicies(q, k) {
      return POLICY_CHUNKS.map((c) => ({ ...c, score: score(q, c.text) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
    async findSimilarTickets(q, k) {
      return RESOLVED_TICKETS.map((t) => ({ ...t, score: score(q, t.resolution) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
    async saveTriage(input) {
      log(`   [services] saveTriage(${JSON.stringify(input)})`);
    },
    async escalate(ticketId, reason) {
      log(`   [services] escalate(${ticketId}, "${reason}")`);
    },
  };
}

// ---------- The ticket ----------

const TICKET = {
  ticketId: "SMOKE-001",
  subject: "Wife lost her job — add her to my plan? COBRA?",
  body:
    "My wife was laid off last Friday and her health coverage ends at the end of the month. " +
    "Can I add her to my plan even though open enrollment is over? Someone also mentioned COBRA — " +
    "is that better? What paperwork do I need and how long do I have?",
};

// ---------- Scripted provider for --fake mode ----------

function fakeProvider(): FakeProvider {
  return new FakeProvider([
    {
      text: "Two topics here: QLE special enrollment and COBRA. Searching both.",
      toolCalls: [
        { name: "search_policies", input: { query: "spouse loss of coverage qualifying life event special enrollment", k: 3 } },
      ],
    },
    {
      toolCalls: [
        { name: "search_policies", input: { query: "COBRA continuation spouse employer coverage", k: 3 } },
        { name: "find_similar_tickets", input: { description: "spouse laid off add to plan COBRA comparison", k: 2 } },
      ],
    },
    {
      text: "Evidence covers both topics; proceeding to final triage.",
      toolCalls: [
        {
          name: "triage_ticket",
          input: {
            category: "enrollment",
            priority: "high",
            summary:
              "Spouse's job loss is a QLE opening a 31-day special enrollment window; needs termination letter via portal. COBRA is the fallback comparison.",
            citations: ["chunk-qle-12", "chunk-cobra-04", "chunk-docs-31", "R-2201"],
            escalated: false,
          },
        },
      ],
    },
  ]);
}

// ---------- Runner ----------

function fmtEvent(e: AgentEvent): string | null {
  switch (e.type) {
    case "run_started":
      return `▶ run ${e.runId.slice(0, 8)} on ${e.provider}/${e.model}`;
    case "step_started":
      return `\n── step ${e.step} ──`;
    case "tool_call":
      return `→ ${e.name}(${JSON.stringify(e.args)})`;
    case "tool_result":
      return `${e.isError ? "✗" : "✓"} ${e.name}: ${e.summary}`;
    case "loop_guard":
      return `⚠ loop guard: ${e.tool} (${e.action})`;
    case "compaction":
      return `⚠ compaction: ~${e.droppedApproxTokens} tokens dropped`;
    case "terminal":
      return `\n■ terminal: ${e.state}`;
    default:
      return null; // model_delta streamed live; step_completed summarized at the end
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const pinned = process.argv[process.argv.indexOf("--provider") + 1] as ProviderName | undefined;

  const registry = buildRegistry(stubServices(console.log));
  const store = new MemoryRunStore();

  const harness = args.has("--fake")
    ? new AgentHarness({
        providers: { ollama: fakeProvider() },
        defaultProvider: "ollama",
        registry,
        store,
        systemPrompt: SYSTEM_PROMPT,
      })
    : new AgentHarness({
        ...buildProviders(),
        registry,
        store,
        systemPrompt: SYSTEM_PROMPT,
      });

  console.log(`Ticket: ${TICKET.subject}\n${"─".repeat(60)}`);

  let streaming = false;
  const t0 = Date.now();
  for await (const event of harness.run(TICKET, {
    provider: args.has("--fake") ? undefined : pinned,
    timeoutMs: 180_000,
  })) {
    if (event.type === "model_delta") {
      process.stdout.write(streaming ? event.text : `💬 ${event.text}`);
      streaming = true;
      continue;
    }
    if (streaming) {
      process.stdout.write("\n");
      streaming = false;
    }
    const line = fmtEvent(event);
    if (line) console.log(line);
    if (event.type === "terminal" && event.result) {
      console.log(JSON.stringify(event.result, null, 2));
    }
  }

  // ---------- Post-run assertions against the persisted records ----------
  const run = [...store.runs.values()][0] as Record<string, unknown>;
  const trajectory = store.steps.map((s) => s.toolCalls.map((c) => c.name).join("+") || "(prose)");
  const tokens = store.ledger.reduce(
    (n, s) => n + s.usage.inputTokens + s.usage.outputTokens,
    0,
  );

  console.log(`\n${"─".repeat(60)}\nRun summary`);
  console.log(`  terminal_state : ${run.terminalState}`);
  console.log(`  steps          : ${run.stepCount}  [${trajectory.join(" → ")}]`);
  console.log(`  tokens (ledger): ${tokens} in+out across ${store.ledger.length} steps`);
  console.log(`  duration       : ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const checks: Array<[string, boolean]> = [
    ["terminal state is completed", run.terminalState === "completed"],
    ["every step persisted before finish", store.steps.length === run.stepCount],
    ["ledger rows match steps", store.ledger.length === store.steps.length],
    ["ledger recorded nonzero usage", tokens > 0],
    ["searched policies before triaging", trajectory.some((t) => t.includes("search_policies"))],
  ];
  let failed = 0;
  console.log("\nChecks");
  for (const [label, ok] of checks) {
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  }
  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nSmoke test passed.");
}

main().catch((err) => {
  console.error("\nSmoke test crashed:", err);
  process.exit(1);
});
