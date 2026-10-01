export interface Chunk {
  text: string;
  section?: string;
  planType?: string;
  // Stable citation id from a `{#chunk-...}` heading attribute. Golden eval
  // cases reference these, so they must survive re-ingest (serial ids don't).
  chunkKey?: string;
}

// Sections that apply to one specific plan type rather than to plans in
// general. Matched against the chunk's `section` heading, not free-text
// keyword sniffing — the same word (e.g. "dental") can appear inside a
// general-eligibility sentence without making that chunk dental-specific.
const SECTION_PLAN_TYPE: Record<string, string> = {
  "eligibility and limits": "HDHP", // HSA section — HDHP-only by policy
  "hsa contribution limits for 2026": "HDHP",
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
 * human-readable citation label for free. A heading may end in `{#key}`; the
 * section's first chunk gets that key, later chunks get `key-2`, `key-3`, ...
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
  let currentKey: string | undefined;
  let keyCount = 0;

  const push = (text: string) => {
    keyCount++;
    const chunkKey = currentKey && (keyCount === 1 ? currentKey : `${currentKey}-${keyCount}`);
    chunks.push({ text, section: currentSection, planType: inferPlanType(currentSection), chunkKey });
  };

  const flush = () => {
    const text = buf.trim();
    if (text) push(text);
    // carry overlap from the tail of the last chunk
    buf = overlapChars > 0 ? text.slice(-overlapChars) : "";
  };

  for (const block of blocks) {
    const heading = block.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      // headings start a new logical section; flush what we had
      if (buf.trim()) flush();
      const attr = heading[1].match(/^(.*?)\s*\{#([\w-]+)\}\s*$/);
      currentSection = (attr ? attr[1] : heading[1]).trim();
      currentKey = attr?.[2];
      keyCount = 0;
      buf = "";
      continue;
    }

    if ((buf + "\n\n" + block).length > maxChars && buf.trim()) {
      flush();
    }
    buf = buf ? `${buf}\n\n${block}` : block;
  }
  if (buf.trim()) push(buf.trim());

  return chunks;
}
