/**
 * Reads the latest report produced by your DeepEval Python sidecar harness
 * (the 15-case golden dataset / four RAG metrics / parametrized pytest
 * suite). Assumes the harness writes a JSON summary somewhere your Node
 * process can read — adjust EVAL_REPORT_PATH to match your actual output
 * location (e.g. `eval/results/latest.json`).
 */

import { readFile } from "node:fs/promises";

const EVAL_REPORT_PATH =
  process.env.EVAL_REPORT_PATH ?? "./eval/results/latest.json";

export interface EvalReport {
  run_id: string;
  run_at: string;
  contextual_precision: number;
  contextual_recall: number;
  faithfulness: number;
  answer_relevancy: number;
  case_count: number;
  passing: number;
}

export async function readLatestEvalReport(): Promise<EvalReport> {
  try {
    const raw = await readFile(EVAL_REPORT_PATH, "utf-8");
    return JSON.parse(raw) as EvalReport;
  } catch (err) {
    // Fail soft with a clear placeholder rather than crashing the tool —
    // useful for demoing this server before the eval harness has run yet.
    return {
      run_id: "no-run-found",
      run_at: new Date(0).toISOString(),
      contextual_precision: 0,
      contextual_recall: 0,
      faithfulness: 0,
      answer_relevancy: 0,
      case_count: 0,
      passing: 0,
    };
  }
}
