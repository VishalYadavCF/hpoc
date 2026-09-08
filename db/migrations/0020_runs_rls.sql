-- migration: row-level security on `runs` (§5.2)
--
-- No FORCE: policies already apply to every role except the table owner and a
-- superuser, and `hpoc_app` (migration 0019) is neither. FORCE would only matter if the
-- connecting role owned the table, which it deliberately does not.
--
-- `app.bypass_rls` exists for the platform-internal sweeps that must see across every
-- tenant by design -- lease reclaim, the dead-letter scan, the cron tick. Those are a
-- handful of identified call sites (withTenantConnection(pool, { bypass: true }, ...) at
-- their call sites), not a general escape hatch: nothing sets it from a request path.
--
-- Compared as TEXT, not cast to uuid: a released connection's session GUC is reset via
-- `set_config('app.org_id', NULL, false)`, and Postgres's `current_setting` then returns
-- '' (not NULL) for the rest of that session -- casting that to uuid throws. A guard like
-- `current_setting(...) <> '' AND org_id = ...::uuid` looks safe but is not: per the
-- manual (§4.2.14), Postgres does not guarantee AND evaluates its inputs left to right,
-- so the planner may still reach the cast. Comparing `org_id::text` against the raw
-- setting sidesteps the cast entirely -- '' or NULL never equals a real UUID's text form,
-- in any evaluation order.
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY runs_tenant_isolation ON runs
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );
