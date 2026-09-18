-- Terminal output of an agent run: the triage decision, or the escalation.
-- Separate from agent_runs (mechanics of the run) so a run can be replayed
-- or re-scored without losing what was actually decided.
CREATE TABLE IF NOT EXISTS triage_results (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id          text NOT NULL,
  run_id             uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  category           text,
  priority           text,
  summary            text,
  citations          jsonb NOT NULL DEFAULT '[]'::jsonb,
  escalated          boolean NOT NULL DEFAULT false,
  escalation_reason  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS triage_results_ticket_idx ON triage_results (ticket_id);
CREATE INDEX IF NOT EXISTS triage_results_run_idx ON triage_results (run_id);

-- Stable, human-meaningful citation key for a policy chunk (e.g. "chunk-qle-12").
-- The eval goldens cite these slugs; without the column, citations fall back to
-- "chunk-<serial id>" and grounding checks cannot match the golden dataset.
ALTER TABLE policy_chunks ADD COLUMN IF NOT EXISTS chunk_key text;
CREATE UNIQUE INDEX IF NOT EXISTS policy_chunks_chunk_key_idx
  ON policy_chunks (chunk_key) WHERE chunk_key IS NOT NULL;
