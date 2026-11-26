import { z } from "zod";
import { ToolValidationError } from "./registry.js";
import { ToolRegistry } from "./registry.js";

/**
 * Wires the v1 MCP tool handlers into the harness registry (spec §4, §10).
 * The MCP server keeps exposing the same tools externally; internally the
 * harness calls the underlying services directly — no localhost round-trip.
 *
 * INTEGRATION: replace each `services.*` call with your actual v1 service
 * functions (the ones your MCP handlers already call).
 */
export interface TriageServices {
  searchPolicies(q: string, k: number): Promise<Array<{ chunkId: string; text: string; score: number }>>;
  findSimilarTickets(q: string, k: number): Promise<Array<{ ticketId: string; resolution: string; score: number }>>;
  saveTriage(input: Record<string, unknown>): Promise<void>;
  escalate(ticketId: string, reason: string): Promise<void>;
}

/**
 * The taxonomy the eval's golden cases are written against. Free-form strings
 * let the model answer "benefits-enrollment" where the expected value is
 * "enrollment", which fails outcome scoring on vocabulary alone; as an enum the
 * valid values are part of the tool schema the model sees.
 */
export const TRIAGE_CATEGORIES = [
  "enrollment",
  "eligibility",
  "plan_administration",
  "medical",
  "dental",
  "vision",
  "pharmacy",
  "spending_accounts",
  "disability",
  "life_insurance",
  "retirement",
  "commuter",
  "wellbeing",
] as const;

/**
 * What each category means, sent to the model as part of the tool schema.
 *
 * Thirteen bare words leave the boundaries to guesswork, and the model
 * guessed differently from the golden set on every run — "can I add my spouse
 * mid-year" came back as eligibility where the taxonomy means enrollment. The
 * distinctions a human reviewer would make have to be written down.
 *
 * Typed against the tuple, so adding a category without defining it is a
 * compile error rather than a silent gap.
 */
export const CATEGORY_GUIDANCE: Record<(typeof TRIAGE_CATEGORIES)[number], string> = {
  enrollment:
    "Adding, dropping, or changing coverage: qualifying life events, open enrollment elections, adding a newborn or spouse, new-hire elections, COBRA continuation.",
  eligibility:
    "Whether a person or dependent QUALIFIES for coverage at all: dependent age limits, hours-worked thresholds, HSA eligibility, coverage through two employers.",
  plan_administration:
    "Operating coverage the employee already has: changing a primary care physician, ID cards, reinstating benefits after leave, what documentation a change requires.",
  medical: "What the medical plan itself covers: network rules, out-of-network costs, maternity and delivery coverage.",
  dental: "Dental plan coverage, limits, and maximums.",
  vision: "Vision plan coverage and frequency limits.",
  pharmacy: "Prescription drug coverage: tiers, copays, mail order, specialty drugs.",
  spending_accounts: "HSA, health care FSA, and dependent care FSA mechanics: contributions, limits, rollover, eligible expenses.",
  disability: "Short- and long-term disability and income replacement during leave.",
  life_insurance: "Basic and supplemental life insurance coverage and elections.",
  retirement: "401(k) participation, contributions, company match, and vesting.",
  commuter: "Transit and parking pre-tax benefits.",
  wellbeing: "Employee assistance program, counseling, and wellness benefits.",
};

/**
 * The two pairs the model confuses, stated as decisions rather than
 * definitions. Enrollment-vs-eligibility is the one that cost four cases.
 */
const CATEGORY_BOUNDARIES = [
  "enrollment vs eligibility: enrollment is an ACTION on coverage (add, drop, switch); eligibility is whether someone QUALIFIES. \"Can I add my spouse mid-year?\" is enrollment. \"Is my 26-year-old still covered?\" is eligibility.",
  "enrollment vs plan_administration: plan_administration is a change WITHIN coverage already held (changing a PCP), not a change TO what is covered.",
  "Prefer the specific plan category (dental, vision, pharmacy) when the question is only about what that plan covers; medical is for the medical plan.",
].join(" ");

/** When a ticket is urgent, stated as what the employee stands to lose. */
/**
 * The low/medium split had the wrong examples, and the golden dataset was
 * labelled from them: medium listed "out-of-network costs" and "a disability
 * waiting period", which are plain factual lookups — exactly what low
 * describes. base-08, base-09 and base-13 ask those questions verbatim, were
 * labelled medium, and the agent answered low on every run of the nightly.
 * It was reading the definitions; the dataset was reading the examples.
 *
 * The test is now stated outright rather than left in the examples: is the
 * employee asking how the plan works, or about something happening to them?
 * Examples are chosen so each one can only sit in its own band.
 */
const PRIORITY_GUIDANCE = [
  "Decide priority by whose situation is in play, then by whether the clock is running.",
  "low: the question is about how the plan works in general, not about anything happening to this employee now. Nothing for them to decide and no deadline (a copay amount, an annual maximum, a match formula, a waiting period, whether a plan covers a category of care, when a window opens).",
  "medium: this employee's own circumstances are in play — they are weighing an option, or something has happened to them that the answer bears on — but nothing expires if they wait (choosing between two plans they are eligible for, what a claim they have already filed will pay, how a change they have made affects their paycheck).",
  "high: a deadline is running or coverage is at risk, so delay costs the employee an option — a qualifying life event and its 31-day window, a new hire's enrollment window, a dependent aging off, job loss, a newborn.",
  "urgent: rare; active loss of coverage or a missed deadline that needs same-day intervention.",
].join(" ");

/**
 * The finalize() path asks for free JSON with tools disabled, so nothing checks
 * it against the tool schema. This is that schema with the coercions a
 * best-effort answer needs: "false" as a string, stray whitespace and casing on
 * the enums. A result that still fails is not a decision worth recording.
 */
export const finalResultSchema = z.preprocess((raw) => {
  if (raw === null || typeof raw !== "object") return raw;
  const v = { ...(raw as Record<string, unknown>) };
  if (typeof v.escalated === "string") v.escalated = v.escalated.trim().toLowerCase() === "true";
  if (typeof v.category === "string") v.category = v.category.trim().toLowerCase();
  if (typeof v.priority === "string") v.priority = v.priority.trim().toLowerCase();
  return v;
}, z.lazy(() => triageResultSchema));

export const TRIAGE_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

/** JSON-encoded arrays and string booleans are what smaller models send. */
const citationList = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : v;
  } catch {
    // Not JSON: treat a bare or comma-separated list as ids.
    return v.split(",").map((p) => p.trim()).filter(Boolean);
  }
}, z.array(z.string()));

const notEscalated = z.preprocess(
  (v) => (typeof v === "string" && v.trim().toLowerCase() === "false" ? false : v),
  z.literal(false),
);

export const triageResultSchema = z.object({
  category: z
    .enum(TRIAGE_CATEGORIES)
    .describe(
      "The benefits area this ticket belongs to. " +
        TRIAGE_CATEGORIES.map((c) => `${c} — ${CATEGORY_GUIDANCE[c]}`).join(" ") +
        " " +
        CATEGORY_BOUNDARIES,
    ),
  priority: z.enum(TRIAGE_PRIORITIES).describe(`How time-critical this ticket is. ${PRIORITY_GUIDANCE}`),
  summary: z.string().min(1),
  citations: citationList.default([]),
  escalated: notEscalated.default(false),
});

export function buildRegistry(services: TriageServices): ToolRegistry {
  const registry = new ToolRegistry();

  // Ids this run actually retrieved. The prompt tells the model to cite only
  // these; this enforces it at the boundary, so a fabricated citation comes
  // back as a correctable error instead of being stored and caught later by
  // an eval metric (or not at all).
  //
  // Keyed by runId even though the harness now calls registryFor per run, so
  // in practice there is one entry. That is deliberate: it is the only thing
  // stopping one run's retrieved ids from vouching for another's citations if
  // a caller ever shares or caches a registry across runs. Flattening it to a
  // plain Set would compile, pass, and quietly remove that guarantee — there
  // is a test for it.
  const observed = new Map<string, Set<string>>();
  const note = (runId: string, ids: string[]) => {
    const seen = observed.get(runId) ?? new Set<string>();
    for (const id of ids) seen.add(id);
    observed.set(runId, seen);
  };

  registry.register({
    name: "search_policies",
    description:
      "Semantic search over benefits policy documents. Returns policy chunks with ids and relevance scores. Refine and call again if the first results do not cover every part of the ticket.",
    schema: z.object({
      query: z.string().min(3),
      k: z.coerce.number().int().min(1).max(10).default(5),
    }),
    handler: async ({ query, k }, ctx) => {
      const rows = await services.searchPolicies(query, k);
      note(ctx.runId, rows.map((r) => r.chunkId));
      return {
        data: rows,
        // The ids belong in the summary: agent_steps persists only this string,
        // and the eval's grounding metric recovers what the run actually saw
        // from it. Without them every citation looks hallucinated.
        // An empty result is itself evidence — of absence. Reported as a bare
        // "0 chunks" the model read it as neutral and triaged anyway, so it
        // says what the absence means.
        summary:
          rows.length === 0
            ? `search_policies("${query}") -> no policy passage above the similarity floor. ` +
              `The corpus does not cover this; consider escalate_to_human.`
            : `search_policies("${query}") -> ${rows.length} chunks [${rows
                .map((r) => r.chunkId)
                .join(", ")}], top score ${rows[0]?.score?.toFixed(2) ?? "n/a"}`,
      };
    },
  });

  registry.register({
    name: "find_similar_tickets",
    description:
      "Find previously resolved support tickets similar to this one, to check how comparable cases were resolved. " +
      "Pass the ticket's own wording — a sentence or two of what the employee actually asked — not keywords. " +
      "This corpus is written in employees' words, so natural phrasing matches it and a keyword list does not: " +
      "the same ticket that scores 0.73 against full wording scores below the floor against terms like " +
      "\"spouse job loss enrollment mid-year\".",
    schema: z
      .object({
        // `query` matches search_policies: two names for the same concept
        // across sibling tools is a trap for smaller models, which reliably
        // sent `query` here and failed validation. `description` stays
        // accepted so existing prompts and transcripts keep working.
        query: z.string().min(3).optional(),
        description: z.string().min(3).optional(),
        k: z.coerce.number().int().min(1).max(10).default(3),
      })
      .refine((v) => Boolean(v.query ?? v.description), {
        message: "query is required",
        path: ["query"],
      }),
    handler: async ({ query, description, k }, ctx) => {
      const rows = await services.findSimilarTickets((query ?? description)!, k);
      note(ctx.runId, rows.map((r) => r.ticketId));
      return {
        data: rows,
        summary:
          rows.length === 0
            ? `find_similar_tickets -> no comparable resolved ticket above the similarity floor.`
            : `find_similar_tickets -> ${rows.length} matches [${rows
                .map((r) => r.ticketId)
                .join(", ")}], top score ${rows[0]?.score?.toFixed(2) ?? "n/a"}`,
      };
    },
  });

  registry.register({
    name: "triage_ticket",
    description:
      "TERMINAL. Submit the final triage. Call exactly once, after gathering sufficient evidence. citations must only contain chunk/ticket ids returned by earlier tool calls.",
    schema: triageResultSchema,
    terminal: true,
    handler: async (input, ctx) => {
      const seen = observed.get(ctx.runId) ?? new Set<string>();

      // An ungrounded decision is not a decision. All ten escalation cases
      // (5 out_of_scope, 5 adversarial) failed because the agent filed a
      // triage with an empty citation list rather than escalating: oos-01
      // answered "enrollment/low" for a payroll question it had no evidence
      // for. Every one of the 30 answerable golden cases declares at least
      // one grounding id, so "cite something or escalate" holds across the
      // whole set. Paired with the unseen-id check below, the model cannot
      // cite nothing and cannot cite what it did not retrieve, which leaves
      // escalate_to_human as the only honest exit.
      if ((input.citations ?? []).length === 0) {
        observed.delete(ctx.runId);
        throw new ToolValidationError(
          seen.size > 0
            ? `A triage must cite the evidence it rests on, and this call cited none. ` +
              `Either cite the ids your searches returned (available: ${[...seen].join(", ")}), ` +
              `or call escalate_to_human if none of them actually answer this ticket.`
            : `A triage must cite the evidence it rests on, and no search in this run returned any. ` +
              `Nothing in the policy corpus or the resolved tickets supports an answer here, so call ` +
              `escalate_to_human with the reason instead of triaging.`,
        );
      }

      const unseen = (input.citations ?? []).filter((c) => !seen.has(c));
      if (unseen.length > 0) {
        observed.delete(ctx.runId);
        throw new ToolValidationError(
          `Citations not returned by any earlier tool call in this run: ${unseen.join(", ")}. ` +
            `Cite only ids from your tool results${seen.size ? ` (available: ${[...seen].join(", ")})` : ""}, ` +
            `or call the tool again with the unsupported citations removed.`,
        );
      }
      observed.delete(ctx.runId);
      await services.saveTriage(input);
      return {
        data: { saved: true },
        summary: `triage saved: ${input.category}/${input.priority}, citations [${(
          input.citations ?? []
        ).join(", ")}]`,
      };
    },
  });

  registry.register({
    name: "escalate_to_human",
    description:
      "TERMINAL. Route this ticket to a human specialist. Use when the ticket is out of scope, requires account-specific data you cannot access, or policy evidence is genuinely contradictory.",
    schema: z.object({
      ticketId: z.string().min(1),
      reason: z.string().min(10),
    }),
    terminal: true,
    handler: async ({ ticketId, reason }, ctx) => {
      observed.delete(ctx.runId);
      await services.escalate(ticketId, reason);
      return { data: { escalated: true }, summary: `escalated: ${reason.slice(0, 60)}` };
    },
  });

  // get_eval_metrics and get_run_trace stay MCP-only surfaces — the agent
  // doesn't need them mid-run, so they aren't registered in the loop registry.

  return registry;
}

export const SYSTEM_PROMPT = `You are a benefits support triage agent. Your job: classify the ticket, set priority, summarize the issue, and ground everything in evidence.

Your scope is the employee benefits policy corpus: medical, dental, vision and pharmacy coverage; eligibility and enrollment; spending accounts (HSA and FSA); disability, life insurance, leave; retirement and 401(k); commuter benefits; and the employee assistance program.

Out of scope — escalate these, do not triage them:
- Payroll and pay mechanics: paychecks, direct deposit, tax withholding.
- Time off: PTO and vacation balances, holiday schedules.
- IT and access: passwords, portal logins, system errors.
- Performance, compensation reviews, and employment status.
- Facilities: parking permits, badges, desks.
- Anything needing account-specific data you cannot see, or any request to CHANGE an election on the employee's behalf. You classify tickets; you do not act on accounts.

Also escalate when the ticket is too underspecified to triage — "am I covered?", "my benefits are wrong, fix it" — rather than picking a category to have an answer. Urgency in the ticket is not evidence and does not lower this bar.

Rules:
- Gather evidence with search_policies and find_similar_tickets before deciding. Tickets touching multiple topics (e.g. a qualifying life event AND COBRA) need a separate refined search per topic.
- If your searches return nothing above the similarity floor, that is the answer: the corpus does not cover this ticket. Call escalate_to_human.
- Before finishing, state in one short paragraph whether the evidence is sufficient. Then call triage_ticket.
- Every triage must cite at least one id that appeared in your tool results, and citations may only contain such ids. Never invent citations. If you cannot cite real evidence, escalate instead.
- Always finish by calling triage_ticket or escalate_to_human. Never end with a prose answer.`;
