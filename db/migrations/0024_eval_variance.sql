-- migration: repeat trials so noise is distinguishable from regression (§0.5, §15.5)
--
-- Every case ran exactly once, so a non-deterministic agent's re-run was indistinguishable
-- from a real change: the same version evaluated twice could score 0.72 then 0.68 and the
-- promotion gate would pass, then fail, with nothing having changed. `judgeMechanism`
-- already admitted this in its own rationale text -- "this harness does no significance
-- testing" -- and answered by refusing to decide below a case-count floor. A case count is
-- a proxy for confidence; repeated trials measure it.
--
-- `trials_per_case` defaults to 1, so every existing suite behaves exactly as before and
-- opting in is a per-suite decision. It lives on the SUITE for the same reason `min_score`
-- does (schema.sql:1421): a value supplied at call time can be tuned until the answer is
-- the one you wanted.
ALTER TABLE eval_suites
  ADD COLUMN trials_per_case integer NOT NULL DEFAULT 1
    CHECK (trials_per_case BETWEEN 1 AND 20);

-- The observed spread of the run's score, as a standard error. NULL for a single-trial
-- run, which is honest: one sample has no measurable spread, and storing 0 would claim
-- perfect precision rather than absent information.
ALTER TABLE eval_runs
  ADD COLUMN score_stderr numeric(6,4);

-- One row per TRIAL, not per case. The old primary key (eval_run_id, eval_case_id) made a
-- second trial an ON CONFLICT DO NOTHING no-op -- the repeats would have been silently
-- discarded and the variance computed from one sample.
ALTER TABLE eval_case_results
  ADD COLUMN trial smallint NOT NULL DEFAULT 1;

ALTER TABLE eval_case_results
  DROP CONSTRAINT eval_case_results_pkey;

ALTER TABLE eval_case_results
  ADD PRIMARY KEY (eval_run_id, eval_case_id, trial);
