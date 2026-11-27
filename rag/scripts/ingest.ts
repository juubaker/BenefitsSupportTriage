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
import { eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { policyChunks, resolvedTickets } from "../db/schema.js";
import { chunkText } from "../lib/chunk.js";
import { embed } from "../lib/embeddings.js";

const DOCS_DIR = join(import.meta.dirname, "..", "docs");
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

    // The source file is the single source of truth for this doc's chunks —
    // replace rather than append, so re-running ingest doesn't duplicate rows.
    await db.delete(policyChunks).where(eq(policyChunks.docTitle, docTitle));

    for (const c of chunks) {
      const embedding = await embed(c.text);
      await db.insert(policyChunks).values({
        docTitle,
        section: c.section ?? null,
        chunkText: c.text,
        sourceUrl: null, // set if you host the policy docs somewhere
        planType: c.planType ?? null,
        chunkKey: c.chunkKey ?? null,
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
    key?: string;
    caseText: string;
    category: string;
    approvedResponse: string;
  }[];

  const missing = rows.filter((r) => !r.key?.trim()).length;
  if (missing > 0) {
    throw new Error(
      `${missing} ticket(s) in resolved-tickets.json have no "key". Citations are ` +
        `"R-<key>", and without one a ticket is cited by serial id, which changes ` +
        `on every ingest. Give each ticket a stable key such as "R-spouse-job-loss".`,
    );
  }
  const keys = rows.map((r) => r.key!.trim());
  const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (duplicates.length > 0) {
    // The upsert below would silently collapse them into one row.
    throw new Error(`Duplicate ticket key(s) in resolved-tickets.json: ${[...new Set(duplicates)].join(", ")}`);
  }

  // Upsert on the key rather than delete-all-then-insert. Deleting advanced
  // the serial sequence every run, so the same ticket's id kept changing and
  // any R-<id> stored in triage_results stopped meaning anything. Keyed rows
  // now keep their id across re-ingests.
  for (const r of rows) {
    const embedding = await embed(r.caseText); // embed the QUESTION, not the answer
    await db
      .insert(resolvedTickets)
      .values({
        ticketKey: r.key!.trim(),
        caseText: r.caseText,
        category: r.category,
        approvedResponse: r.approvedResponse,
        embedding,
      })
      .onConflictDoUpdate({
        target: resolvedTickets.ticketKey,
        set: {
          caseText: r.caseText,
          category: r.category,
          approvedResponse: r.approvedResponse,
          embedding,
        },
      });
  }

  // Anything left without a key predates this and can no longer be cited
  // stably, so it goes — including the rows the old delete-all would have
  // removed anyway.
  const removed = await db
    .delete(resolvedTickets)
    .where(isNull(resolvedTickets.ticketKey))
    .returning({ id: resolvedTickets.id });
  if (removed.length > 0) {
    console.log(`  removed ${removed.length} unkeyed row(s) from earlier ingests.`);
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
