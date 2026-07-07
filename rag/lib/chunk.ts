export interface Chunk {
  text: string;
  section?: string;
  planType?: string;
}

// Sections that apply to one specific plan type rather than to plans in
// general. Matched against the chunk's `section` heading, not free-text
// keyword sniffing — the same word (e.g. "dental") can appear inside a
// general-eligibility sentence without making that chunk dental-specific.
const SECTION_PLAN_TYPE: Record<string, string> = {
  "eligibility and limits": "HDHP", // HSA section — HDHP-only by policy
};

export function inferPlanType(section: string | undefined): string | undefined {
  if (!section) return undefined;
  return SECTION_PLAN_TYPE[section.trim().toLowerCase()];
}

/**
 * Splits policy text into overlapping chunks suitable for embedding.
 *
 * Strategy: prefer natural boundaries (paragraphs), pack them up to ~maxChars,
 * and carry a small overlap into the next chunk so a fact that straddles a
 * boundary is still retrievable. This is deliberately simple and dependency
 * free; swap in a token-aware splitter later if you need precise sizing.
 *
 * It also recognizes Markdown-style headings (`#`, `##`, ...) and tags every
 * chunk with the most recent heading as its `section`, which gives you a
 * human-readable citation label for free.
 */
export function chunkText(
  raw: string,
  opts: { maxChars?: number; overlapChars?: number } = {}
): Chunk[] {
  const maxChars = opts.maxChars ?? 900;
  const overlapChars = opts.overlapChars ?? 150;

  const blocks = raw
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const chunks: Chunk[] = [];
  let buf = "";
  let currentSection: string | undefined;

  const flush = () => {
    const text = buf.trim();
    if (text) chunks.push({ text, section: currentSection, planType: inferPlanType(currentSection) });
    // carry overlap from the tail of the last chunk
    buf = overlapChars > 0 ? text.slice(-overlapChars) : "";
  };

  for (const block of blocks) {
    const heading = block.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      // headings start a new logical section; flush what we had
      if (buf.trim()) flush();
      currentSection = heading[1].trim();
      buf = "";
      continue;
    }

    if ((buf + "\n\n" + block).length > maxChars && buf.trim()) {
      flush();
    }
    buf = buf ? `${buf}\n\n${block}` : block;
  }
  if (buf.trim())
    chunks.push({ text: buf.trim(), section: currentSection, planType: inferPlanType(currentSection) });

  return chunks;
}
