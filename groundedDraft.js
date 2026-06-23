// server/rag/groundedDraft.js
//
// Orchestrates the grounded draft: embed -> retrieve (via ragRepo) -> abstain?
// -> provider.draftGrounded(...) -> verify citations -> log. Provider-agnostic:
// it calls provider.draftGrounded({system, user}), so it respects LLM_PROVIDER
// exactly like your classify/draft routes. Pure orchestration + injected deps,
// so it's unit-testable without Postgres or a live LLM.

import { embed, toVectorLiteral } from "./embed.js";

const POLICY_K = Number(process.env.POLICY_K ?? 5);
const PRECEDENT_K = Number(process.env.PRECEDENT_K ?? 3);
const MIN_SIMILARITY = Number(process.env.MIN_SIMILARITY ?? 0.45);

const SYSTEM = `You are a benefits support triage assistant. You draft a first-pass
response to an employee's benefits question for a HUMAN reviewer to approve or edit.

Rules:
- Ground every factual claim in the POLICY PASSAGES provided. Cite the passage
  you used inline with its id, like [policy:12]. You may cite more than one.
- The PRECEDENTS are past approved answers to similar cases. Use them for tone,
  structure, and resolution path — do NOT cite them as policy.
- If no provided passage supports a claim, do not invent policy. Say what you
  can support, and explicitly flag what needs human confirmation.
- Be concise and plain-spoken. The reviewer is busy.`;

function buildUserPrompt(caseText, r) {
  const policy = r.policy
    .map(
      (p) =>
        `[policy:${p.id}] (${p.docTitle}${p.section ? " — " + p.section : ""})\n${p.chunkText}`
    )
    .join("\n\n");
  const precedents = r.precedents
    .map(
      (p, i) =>
        `Precedent ${i + 1} (category: ${p.category})\nCase: ${p.caseText}\nApproved response: ${p.approvedResponse}`
    )
    .join("\n\n");
  return [
    `INCOMING CASE:\n${caseText}`,
    `POLICY PASSAGES:\n${policy || "(none retrieved)"}`,
    `PRECEDENTS:\n${precedents || "(none retrieved)"}`,
    `Draft the reviewer-facing response now.`,
  ].join("\n\n---\n\n");
}

function parseCitations(text) {
  const ids = new Set();
  for (const m of text.matchAll(/\[policy:(\d+)\]/g)) ids.add(Number(m[1]));
  return [...ids];
}

/**
 * @param {object}  args
 * @param {string}  args.caseText
 * @param {object}  args.provider  providers.draft — must implement draftGrounded({system,user})
 * @param {object}  args.ragRepo   { searchPolicy, searchPrecedents, recordRetrievalLog }
 */
export async function runGroundedDraft({ caseText, provider, ragRepo }) {
  const vec = toVectorLiteral(await embed(caseText));

  const [policy, precedents] = await Promise.all([
    ragRepo.searchPolicy(vec, { k: POLICY_K, minSim: MIN_SIMILARITY }),
    ragRepo.searchPrecedents(vec, { k: PRECEDENT_K, minSim: MIN_SIMILARITY }),
  ]);
  const topSimilarity = policy.length ? policy[0].similarity : 0;
  const retrieval = { policy, precedents, topSimilarity };

  // Abstention: weak grounding -> route to a human instead of guessing.
  if (topSimilarity < MIN_SIMILARITY) {
    await ragRepo.recordRetrievalLog({
      caseText,
      retrieval,
      citedPolicyIds: [],
      abstained: "low_similarity",
    });
    return {
      abstained: true,
      abstainReason: "No sufficiently relevant policy found; routed to human.",
      citations: [],
      retrieval,
    };
  }

  const text = await provider.draftGrounded({
    system: SYSTEM,
    user: buildUserPrompt(caseText, retrieval),
  });
  const draft = (text || "").trim();

  // Citation verification: every cited id must be one we actually retrieved.
  const retrievedIds = new Set(policy.map((p) => p.id));
  const citations = parseCitations(draft).map((id) => ({
    id,
    verified: retrievedIds.has(id),
  }));

  await ragRepo.recordRetrievalLog({
    caseText,
    retrieval,
    citedPolicyIds: citations.filter((c) => c.verified).map((c) => c.id),
    abstained: null,
  });

  return { abstained: false, draft, citations, retrieval };
}
