import { retrieve } from "../lib/retrieval";

async function main() {
  const q = process.argv.slice(2).join(" ") || "Can I add my spouse after getting married?";
  const r = await retrieve(q);

  console.log(`\nQuery: ${q}\n`);
  console.log("POLICY HITS:");
  for (const p of r.policy) {
    console.log(`  [${p.id}] ${p.similarity.toFixed(3)}  ${p.docTitle} — ${p.section ?? ""}`);
  }
  console.log("\nPRECEDENT HITS:");
  for (const p of r.precedents) {
    console.log(`  [${p.id}] ${p.similarity.toFixed(3)}  ${p.category}: ${p.caseText.slice(0, 60)}`);
  }
  console.log(`\ntopSimilarity: ${r.topSimilarity.toFixed(3)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
