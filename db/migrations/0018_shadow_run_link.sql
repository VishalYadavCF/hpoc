-- migration: link a shadow run back to the run it shadows (§15.5)
--
-- Nullable and ON DELETE SET NULL: a shadow run is a normal `runs` row in every other
-- respect (durable, leased, budgeted, observable), so it must not be able to block the
-- primary run's retention by existing, nor take the primary down if the shadow itself is
-- ever pruned.
ALTER TABLE runs
  ADD COLUMN shadow_of_run_id uuid REFERENCES runs(id) ON DELETE SET NULL;

CREATE INDEX runs_shadow_of_run_id_idx ON runs (shadow_of_run_id) WHERE shadow_of_run_id IS NOT NULL;
