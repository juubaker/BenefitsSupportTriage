// server/llm/shared.js
// Prompt builders shared across all adapters. Keep adapters thin — they
// translate transport, not semantics. If a prompt needs to change, change
// it once here.

export const CLASSIFY_SYSTEM =
  'You are a triage assistant for an Oracle HCM Cloud Benefits support team. ' +
  'Classify support posts into one of the provided categories. ' +
  'Respond with JSON only, no prose, no code fences.';

export const DRAFT_SYSTEM =
  'You are a senior Oracle HCM Cloud Benefits implementation consultant. ' +
  'You write concise, technically grounded answers for support posts. ' +
  'Reference setup task names (e.g., Manage Plans and Programs, Manage Eligibility Profiles), ' +
  'specific flows or processes, and Fast Formula or BI Publisher tables when relevant. ' +
  'Stay under 120 words. Plain text. No markdown headings.';

export function buildClassifyPrompt({ title, body, categories }) {
  return (
    `Categories (use the exact label):\n${categories.map((l) => `- ${l}`).join('\n')}\n\n` +
    `Post title: ${title}\n` +
    `Post body: ${body}\n\n` +
    `Return JSON: {"category": "<exact label>", "confidence": <0..1>, "reasoning": "<one sentence>"}`
  );
}

export function buildDraftPrompt({ title, body }) {
  return (
    `Draft a support reply for the following post:\n\n` +
    `Title: ${title}\n` +
    `Body: ${body}\n\n` +
    `Reply directly. Do not include greetings or sign-offs.`
  );
}

/**
 * Pull a JSON object out of a text response. Handles bare JSON, ```json
 * fences, and JSON embedded in prose. Throws if no object is found.
 */
export function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in model response');
  return JSON.parse(cleaned.slice(start, end + 1));
}
