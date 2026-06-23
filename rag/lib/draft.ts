import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db/client";
import { retrievalLog } from "../db/schema";
import { retrieve, type RetrievalResult } from "./retrieval";
import { DRAFT_MODEL, MIN_SIMILARITY } from "./config";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface DraftResult {
  abstained: boolean;
  abstainReason?: string;
  draft?: string;
  citations: { id: number; verified: boolean }[];
  retrieval: RetrievalResult;
}

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

function buildUserPrompt(caseText: string, r: RetrievalResult): string {
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

/** Parse [policy:NN] markers out of the model's draft. */
function parseCitations(text: string): number[] {
  const ids = new Set<number>();
  for (const m of text.matchAll(/\[policy:(\d+)\]/g)) ids.add(Number(m[1]));
  return [...ids];
}

export async function draftResponse(caseText: string): Promise<DraftResult> {
  const retrieval = await retrieve(caseText);

  // ABSTENTION: if the best policy match is too weak, don't draft — route to a
  // human. A triage agent that knows when not to answer beats one that always
  // produces something.
  if (retrieval.topSimilarity < MIN_SIMILARITY) {
    await logRetrieval(caseText, retrieval, [], "low_similarity");
    return {
      abstained: true,
      abstainReason: "No sufficiently relevant policy found; routed to human.",
      citations: [],
      retrieval,
    };
  }

  const msg = await anthropic.messages.create({
    model: DRAFT_MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: buildUserPrompt(caseText, retrieval) }],
  });

  const draft = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // CITATION VERIFICATION: every id the model cited must be one we actually
  // retrieved. An id outside the retrieved set is a fabricated citation and
  // gets flagged for the reviewer rather than silently trusted.
  const retrievedIds = new Set(retrieval.policy.map((p) => p.id));
  const cited = parseCitations(draft);
  const citations = cited.map((id) => ({
    id,
    verified: retrievedIds.has(id),
  }));

  await logRetrieval(
    caseText,
    retrieval,
    citations.filter((c) => c.verified).map((c) => c.id),
    null
  );

  return { abstained: false, draft, citations, retrieval };
}

async function logRetrieval(
  caseText: string,
  r: RetrievalResult,
  citedPolicyIds: number[],
  abstained: string | null
) {
  await db.insert(retrievalLog).values({
    caseText,
    retrievedPolicyIds: JSON.stringify(r.policy.map((p) => p.id)),
    retrievedTicketIds: JSON.stringify(r.precedents.map((p) => p.id)),
    citedPolicyIds: JSON.stringify(citedPolicyIds),
    topSimilarity: r.topSimilarity,
    abstained,
  });
}
