-- migration: a least-privileged role for the running application (§5.2 RLS)
--
-- Postgres RLS policies are skipped for the table owner and for a superuser, by design --
-- neither is "a query", both are administration. Every table here is owned by the role
-- these migrations run as, which is exactly why the commented-out
-- `ALTER TABLE runs ENABLE ROW LEVEL SECURITY` a few migrations back would have been a
-- silent no-op: the app connects as that same owning role today.
--
-- `hpoc_app` is a second role that owns nothing. Migrations and seeding keep running as
-- the owner (superuser locally, via `DATABASE_URL`); api/worker/scheduler connect as
-- `hpoc_app` once an operator points `APP_DATABASE_URL` at it -- see
-- src/platform/config/env.schema.ts. Until that env var is set, nothing here changes any
-- runtime behaviour: this migration only prepares the role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hpoc_app') THEN
    -- Local-dev password only. A real deployment mints this from its secret store and
    -- never puts it in a migration file.
    CREATE ROLE hpoc_app LOGIN PASSWORD 'hpoc_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE hpoc TO hpoc_app;
GRANT USAGE ON SCHEMA public TO hpoc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hpoc_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hpoc_app;

-- Every migration after this one adds tables and sequences the app must reach without a
-- follow-up GRANT -- otherwise this role silently falls further out of date each release.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hpoc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hpoc_app;
