/**
 * Ingest pipeline. Run with:  npx tsx rag/scripts/ingest.ts
 *
 * Reads:
 *   rag/docs/policies/*.{md,txt}   -> chunked + embedded into policy_chunks
 *   rag/docs/resolved-tickets.json -> embedded into resolved_tickets
 *
 * resolved-tickets.json shape:
 *   [{ "caseText": "...", "category": "Eligibility", "approvedResponse": "..." }, ...]
 *
 * In production you'd source resolved tickets straight from your existing
 * cases table (the ones a reviewer approved) instead of a JSON file — the
 * embedding step is identical.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { db } from "../db/client";
import { policyChunks, resolvedTickets } from "../db/schema";
import { chunkText } from "../lib/chunk";
import { embed } from "../lib/embeddings";

const DOCS_DIR = join(__dirname, "..", "docs");
const POLICY_DIR = join(DOCS_DIR, "policies");

async function ingestPolicies() {
  if (!existsSync(POLICY_DIR)) {
    console.log("No policies/ dir found, skipping policy ingest.");
    return;
  }
  const files = readdirSync(POLICY_DIR).filter((f) =>
    [".md", ".txt"].includes(extname(f))
  );

  let total = 0;
  for (const file of files) {
    const raw = readFileSync(join(POLICY_DIR, file), "utf8");
    const docTitle = basename(file, extname(file));
    const chunks = chunkText(raw);

    for (const c of chunks) {
      const embedding = await embed(c.text);
      await db.insert(policyChunks).values({
        docTitle,
        section: c.section ?? null,
        chunkText: c.text,
        sourceUrl: null, // set if you host the policy docs somewhere
        embedding,
      });
      total++;
    }
    console.log(`  ${file}: ${chunks.length} chunks`);
  }
  console.log(`Policy ingest complete: ${total} chunks.`);
}

async function ingestTickets() {
  const path = join(DOCS_DIR, "resolved-tickets.json");
  if (!existsSync(path)) {
    console.log("No resolved-tickets.json found, skipping ticket ingest.");
    return;
  }
  const rows = JSON.parse(readFileSync(path, "utf8")) as {
    caseText: string;
    category: string;
    approvedResponse: string;
  }[];

  for (const r of rows) {
    const embedding = await embed(r.caseText); // embed the QUESTION, not the answer
    await db.insert(resolvedTickets).values({
      caseText: r.caseText,
      category: r.category,
      approvedResponse: r.approvedResponse,
      embedding,
    });
  }
  console.log(`Ticket ingest complete: ${rows.length} precedents.`);
}

async function main() {
  console.log("Ingesting policies...");
  await ingestPolicies();
  console.log("Ingesting resolved tickets...");
  await ingestTickets();
  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
