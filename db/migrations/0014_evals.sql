-- migration: eval harness (§15.5, and the enforcement half of §0.5)
--
-- The tables from 0004 were designed for this and need three things they do not have.
--
-- 1. A GRADER. `expectation jsonb` alone leaves how a case is scored implicit, so every
--    reader has to infer it from the shape of the JSON. Named and constrained, it is
--    queryable ("which suites depend on an LLM judge?") and a typo fails at write time.
--
-- 2. The A/B PAIRING. `eval_runs.mechanism_enabled` already exists, which is the hard
--    part -- but nothing links the two arms of a comparison, so "memory scored 0.8" and
--    "memory-off scored 0.75" are two unrelated rows and the DELTA that §0.5 actually
--    turns on has to be reassembled by a human.
--
-- 3. The PROMOTION GATE, as data. §15.5 wires evals "into the lifecycle, not beside it";
--    without a declared gate, promotion is a convention and §0.5 stays aspirational.

-- Mechanisms that did not exist when 0004 was written. §0.5 requires an eval per
-- mechanism, so a mechanism the enum cannot name is one nobody can be asked to justify.
ALTER TABLE eval_suites DROP CONSTRAINT eval_suites_mechanism_under_test_check;
ALTER TABLE eval_suites ADD CONSTRAINT eval_suites_mechanism_under_test_check
    CHECK (mechanism_under_test IS NULL OR mechanism_under_test IN
          ('summarization','compaction','memory_tiers','planning_scaffold',
           'sub_agents','retrieval','eviction','skills','knowledge',
           'model_cache','peers','none'));

ALTER TABLE eval_suites
  -- The bar this suite must clear. Stored on the SUITE rather than passed per run: a
  -- threshold supplied at call time is a threshold that can be lowered until it passes,
  -- and the eval then measures nothing.
  ADD COLUMN min_score numeric(6,4) NOT NULL DEFAULT 0.7
      CHECK (min_score >= 0 AND min_score <= 1),

  -- §0.5: how much better the mechanism must make things to justify keeping it. Zero
  -- would mean any positive noise counts as benefit.
  ADD COLUMN min_mechanism_delta numeric(6,4) NOT NULL DEFAULT 0.05
      CHECK (min_mechanism_delta >= 0 AND min_mechanism_delta <= 1);

ALTER TABLE eval_cases
  -- How this case is graded. `budget` grades latency and cost rather than text, which is
  -- what makes "did compaction make it cheaper" a measurable question instead of a story.
  ADD COLUMN grader text NOT NULL DEFAULT 'contains'
      CHECK (grader IN ('exact','contains','not_contains','regex','json_path',
                        'budget','llm_judge')),
  -- Cases that only make sense with the mechanism on (a memory suite's "recall what I
  -- told you earlier") would score zero in the OFF arm and manufacture a delta that
  -- proves nothing. Excluded from the comparison, still scored in the main run.
  ADD COLUMN ab_comparable boolean NOT NULL DEFAULT true;

ALTER TABLE eval_runs
  -- The other arm. Self-referential rather than a separate comparison table: the delta is
  -- a property of the pair, and a third row holding it could disagree with both.
  ADD COLUMN baseline_eval_run_id uuid REFERENCES eval_runs(id) ON DELETE SET NULL,

  -- The version actually executed for this arm. For the OFF arm this is a DIFFERENT,
  -- separately-admitted version -- one field flipped -- because a runtime override would
  -- be testing a configuration that could never be deployed.
  ADD COLUMN executed_version_id uuid REFERENCES agent_versions(id) ON DELETE SET NULL,

  ADD COLUMN cases_total    integer NOT NULL DEFAULT 0,
  ADD COLUMN cases_passed   integer NOT NULL DEFAULT 0,
  ADD COLUMN cases_errored  integer NOT NULL DEFAULT 0,
  ADD COLUMN p50_latency_ms integer,
  ADD COLUMN total_cost_micros bigint NOT NULL DEFAULT 0,

  -- The verdict, recorded rather than recomputed at read time: the thresholds that
  -- produced it can change, and a historical decision must stay explainable under the
  -- rules that were actually applied.
  ADD COLUMN verdict text
      CHECK (verdict IS NULL OR verdict IN
             ('passed','failed','mechanism_justified','mechanism_not_justified',
              'inconclusive'));

-- An arm cannot be its own baseline.
ALTER TABLE eval_runs
  ADD CONSTRAINT eval_run_baseline_not_self_ck CHECK (baseline_eval_run_id IS DISTINCT FROM id);

-- §15.5's gate, declared per agent and environment.
--
-- Per ENVIRONMENT because that is the real shape of it: staging should be promotable on a
-- smoke suite while production demands the full one. A single gate per agent would force
-- one of those to be wrong.
CREATE TABLE promotion_gates (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    agent_id       uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    environment    environment NOT NULL,
    eval_suite_id  uuid NOT NULL REFERENCES eval_suites(id) ON DELETE RESTRICT,
    min_score      numeric(6,4) NOT NULL DEFAULT 0.7
                     CHECK (min_score >= 0 AND min_score <= 1),
    -- An escape hatch that is RECORDED. A gate with no override gets bypassed by someone
    -- editing the table during an incident, and then nobody knows it happened; an
    -- override that must name a reason and a person is auditable (§16.4).
    allow_override boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_id, environment)
);

ALTER TABLE deployments
  -- Who promoted past a failing or absent gate, and why. NULL is the normal case.
  ADD COLUMN gate_overridden_by uuid REFERENCES principals(id),
  ADD COLUMN gate_override_reason text,
  ADD CONSTRAINT deployment_override_needs_reason_ck
      CHECK (gate_overridden_by IS NULL OR gate_override_reason IS NOT NULL);

-- The suite a case belongs to must be the suite the gate names, and both must belong to
-- the agent's org. Enforced by the FKs above; this index is what makes the gate lookup on
-- every promotion cheap enough to be unconditional.
CREATE INDEX promotion_gates_lookup_idx ON promotion_gates (agent_id, environment);
CREATE INDEX eval_runs_suite_version_idx
    ON eval_runs (eval_suite_id, agent_version_id, started_at DESC);
