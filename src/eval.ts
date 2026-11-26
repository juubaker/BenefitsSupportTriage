/**
 * Reads the scorecard written by the eval suite in evals/.
 *
 * This previously read `./eval/results/latest.json` and expected the v1
 * DeepEval shape (four RAG metrics over a 15-case dataset). Neither matched
 * reality: the runner writes `evals/eval/scorecards/latest.json` in the v2
 * trajectory format, so the tool returned its placeholder on every call. It
 * now reads what is actually produced.
 *
 * `python -m run --suite smoke` inside evals/ writes to `--out`, default
 * `eval/scorecards/latest.json`, which is this path from the repo root.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const EVAL_REPORT_PATH =
  process.env.EVAL_REPORT_PATH ?? "./evals/eval/scorecards/latest.json";

/** One metric or bucket: how many cases passed out of how many. */
export interface ScoreEntry {
  pass: number;
  total: number;
  rate: number;
}

/** The shape build_scorecard() in evals/run.py emits. */
export interface EvalScorecard {
  suite: string;
  cases: number;
  cases_passed: number;
  case_pass_rate: number;
  by_metric: Record<string, ScoreEntry>;
  by_bucket: Record<string, ScoreEntry>;
  /**
   * `failed` carries each metric's explanation, not just its name. Older
   * scorecards wrote a bare string[]; both are read, so a scorecard committed
   * before that change still loads.
   */
  failures: Array<{
    case_id: string;
    failed: Array<string | { metric: string; score?: number; detail?: string }>;
  }>;
  providers?: {
    requested: string[];
    observed: string[];
    failed_over: string[];
  };
}

/** Normalizes either failures shape to { metric, detail }. */
function failedMetrics(
  failed: Array<string | { metric: string; score?: number; detail?: string }>,
): Array<{ metric: string; detail: string }> {
  return failed.map((f) =>
    typeof f === "string" ? { metric: f, detail: "" } : { metric: f.metric, detail: f.detail ?? "" },
  );
}

export type EvalReport =
  | ({ available: true; scorecard_path: string } & EvalScorecard)
  /**
   * Absence is reported as absence. The old placeholder returned zeros for
   * every metric, which is indistinguishable from a suite that genuinely
   * failed everything — the worst possible answer to "how good is this?".
   */
  | { available: false; scorecard_path: string; reason: string };

export async function readLatestEvalReport(
  path: string = EVAL_REPORT_PATH,
): Promise<EvalReport> {
  const scorecard_path = resolve(path);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return {
      available: false,
      scorecard_path,
      reason:
        "No scorecard found. Run the eval suite first: `cd evals && python -m run --suite smoke`.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { available: false, scorecard_path, reason: "Scorecard is not valid JSON." };
  }

  // A file in the old four-metric shape is not a v2 scorecard; say so rather
  // than reporting a pass rate of undefined.
  const card = parsed as Partial<EvalScorecard>;
  if (typeof card.case_pass_rate !== "number" || !card.by_metric) {
    return {
      available: false,
      scorecard_path,
      reason:
        "Scorecard is missing case_pass_rate or by_metric — it may be in the older DeepEval format.",
    };
  }

  return { available: true, scorecard_path, ...(parsed as EvalScorecard) };
}

/** Narrows a scorecard to one metric, keeping the context needed to read it. */
export function selectMetric(report: EvalReport, metric: string): unknown {
  if (!report.available) return report;
  if (metric === "all") return report;
  const entry = report.by_metric[metric];
  if (!entry) {
    return {
      available: false,
      scorecard_path: report.scorecard_path,
      reason: `Metric "${metric}" is not in this scorecard. Present: ${Object.keys(
        report.by_metric,
      ).join(", ")}.`,
    };
  }
  return {
    available: true,
    suite: report.suite,
    metric,
    ...entry,
    // Which cases failed this metric specifically — the actionable part —
    // with the reason, so the caller does not have to go to the database to
    // learn what the run actually decided.
    failing_cases: report.failures.flatMap((f) => {
      const hit = failedMetrics(f.failed).find((m) => m.metric === metric);
      return hit ? [{ case_id: f.case_id, detail: hit.detail }] : [];
    }),
  };
}
