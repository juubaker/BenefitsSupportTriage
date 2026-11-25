// @vitest-environment node
//
// get_eval_metrics returned a placeholder on every call for two independent
// reasons: it read a path nothing writes, in a format nothing produces. These
// tests pin both to what evals/run.py actually emits.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestEvalReport, selectMetric, EVAL_REPORT_PATH } from "./eval.js";

/** A scorecard in the exact shape build_scorecard() produces. */
const SCORECARD = {
  suite: "smoke",
  cases: 10,
  cases_passed: 8,
  case_pass_rate: 0.8,
  by_metric: {
    escalation_correctness: { pass: 10, total: 10, rate: 1.0 },
    outcome_correctness: { pass: 8, total: 10, rate: 0.8 },
  },
  by_bucket: {
    base: { pass: 2, total: 2, rate: 1.0 },
    multihop: { pass: 0, total: 2, rate: 0.0 },
  },
  failures: [
    { case_id: "multihop-01", failed: ["outcome_correctness"] },
    { case_id: "multihop-02", failed: ["outcome_correctness"] },
  ],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eval-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, body: string) {
  const p = join(dir, name);
  await writeFile(p, body, "utf-8");
  return p;
}

describe("readLatestEvalReport", () => {
  it("reads the v2 scorecard the suite writes", async () => {
    const p = await write("latest.json", JSON.stringify(SCORECARD));

    const r = await readLatestEvalReport(p);

    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.case_pass_rate).toBe(0.8);
    expect(r.by_bucket.multihop.rate).toBe(0);
    expect(r.scorecard_path).toContain("latest.json");
  });

  it("reports absence as absence, not as a zero score", async () => {
    // The old placeholder returned 0 for every metric, which is
    // indistinguishable from a suite that genuinely failed everything.
    const r = await readLatestEvalReport(join(dir, "nope.json"));

    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.reason).toMatch(/python -m run --suite smoke/);
    expect(JSON.stringify(r)).not.toContain('"case_pass_rate":0');
  });

  it("rejects the older four-metric format instead of reporting it as a scorecard", async () => {
    const p = await write(
      "old.json",
      JSON.stringify({
        run_id: "x",
        contextual_precision: 0.9,
        faithfulness: 0.8,
        answer_relevancy: 0.95,
      }),
    );

    const r = await readLatestEvalReport(p);

    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.reason).toMatch(/older DeepEval format/);
  });

  it("does not crash on an unparseable file", async () => {
    const p = await write("bad.json", "{ not json");

    const r = await readLatestEvalReport(p);

    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.reason).toMatch(/not valid JSON/);
  });

  it("defaults to the path the runner actually writes", async () => {
    // --out defaults to eval/scorecards/latest.json, run from inside evals/.
    expect(EVAL_REPORT_PATH).toContain("evals/eval/scorecards/latest.json");
  });

  it("finds a scorecard written at the default relative location", async () => {
    await mkdir(join(dir, "evals", "eval", "scorecards"), { recursive: true });
    const p = join(dir, "evals", "eval", "scorecards", "latest.json");
    await writeFile(p, JSON.stringify(SCORECARD), "utf-8");

    const r = await readLatestEvalReport(p);

    expect(r.available).toBe(true);
  });
});

describe("selectMetric", () => {
  it("narrows to one metric and names the cases that failed it", async () => {
    const p = await write("latest.json", JSON.stringify(SCORECARD));
    const report = await readLatestEvalReport(p);

    const r = selectMetric(report, "outcome_correctness") as Record<string, unknown>;

    expect(r.metric).toBe("outcome_correctness");
    expect(r.rate).toBe(0.8);
    expect(r.failing_cases).toEqual(["multihop-01", "multihop-02"]);
  });

  it("lists what is present when a metric is absent", async () => {
    const p = await write("latest.json", JSON.stringify(SCORECARD));
    const report = await readLatestEvalReport(p);

    const r = selectMetric(report, "reasoning_quality") as Record<string, unknown>;

    expect(r.available).toBe(false);
    expect(String(r.reason)).toContain("escalation_correctness");
  });

  it("passes the unavailable report straight through", async () => {
    const report = await readLatestEvalReport(join(dir, "nope.json"));

    expect(selectMetric(report, "step_efficiency")).toBe(report);
  });

  it("returns the whole scorecard for all", async () => {
    const p = await write("latest.json", JSON.stringify(SCORECARD));
    const report = await readLatestEvalReport(p);

    expect(selectMetric(report, "all")).toBe(report);
  });
});
