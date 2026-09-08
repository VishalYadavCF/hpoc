-- migration: async delivery and trigger tenancy
--
-- Two gaps that made §18.2 (triggers) and §18.4 (webhook delivery mode) unreachable.

-- Where to deliver a run's outcome when the caller is not holding a connection.
-- §18.4: mode is delivery, not durability -- the run is durable either way, and this
-- only says how the outcome gets back.
ALTER TABLE runs ADD COLUMN delivery jsonb;

-- A trigger fires without a caller, so it must carry the tenancy the run will execute
-- under. §5.2 makes tenant_ref a first-class run parameter; a trigger with nowhere to get
-- one would have to invent it at dispatch time.
ALTER TABLE triggers ADD COLUMN tenant_ref text;

-- A trigger that can fire but names no tenant is a run that cannot be created. Better to
-- reject it at registration than to discover it when the schedule comes round at 3am.
ALTER TABLE triggers
  ADD CONSTRAINT triggers_need_tenant_ck
  CHECK (NOT enabled OR tenant_ref IS NOT NULL);

CREATE INDEX triggers_schedule_idx ON triggers (trigger_type, enabled)
  WHERE trigger_type = 'schedule' AND enabled;
