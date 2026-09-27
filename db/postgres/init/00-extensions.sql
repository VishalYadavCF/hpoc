-- =====================================================================
-- Extension bootstrap. Runs once, on first initialisation of the volume.
--
-- Extensions are created HERE and not in db/migrations/, because two of
-- them do not tolerate being created by a migration:
--   * timescaledb must be created before the objects that use it and
--     dislikes sharing a transaction with unrelated DDL,
--   * pg_cron can only be created in the database named by
--     cron.database_name.
-- Migrations only consume the types they provide (notably `vector`).
-- =====================================================================

\set ON_ERROR_STOP on

-- Required. A missing one here is a broken image, so fail loudly.
DO $$
DECLARE
    ext  text;
    reqd text[] := ARRAY[
        'pgcrypto',        -- gen_random_uuid()          (schema.sql)
        'citext',          -- case-insensitive text      (schema.sql)
        'vector',          -- pgvector: vector(1536), hnsw index  (§11.3)
        'timescaledb'      -- hypertables, continuous aggregates  (time series)
    ];
BEGIN
    FOREACH ext IN ARRAY reqd LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = ext) THEN
            RAISE EXCEPTION 'required extension % is not available in this image', ext;
        END IF;
        EXECUTE format('CREATE EXTENSION IF NOT EXISTS %I CASCADE', ext);
        RAISE NOTICE 'extension % created', ext;
    END LOOP;
END $$;

-- Optional. Availability varies by base image; warn and carry on.
DO $$
DECLARE
    ext  text;
    opt  text[] := ARRAY[
        -- caching
        'pg_prewarm',              -- relation preload into shared_buffers + autoprewarm
        'pg_cron',                 -- scheduled jobs: matview refresh, retention
        -- observability
        'pg_stat_statements',      -- normalised query stats
        'pg_buffercache',          -- what is actually resident in shared_buffers
        'pgstattuple',             -- table / index bloat measurement
        'pg_visibility',           -- visibility map inspection (vacuum debugging)
        'pg_wait_sampling',        -- sampled wait events, per query id
        'pg_stat_kcache',          -- real CPU + filesystem I/O per query
        'hypopg',                  -- hypothetical indexes: test before building
        'amcheck',                 -- index corruption checks
        -- vector / time series extras
        'vectorscale',             -- StreamingDiskANN index for pgvector
        'timescaledb_toolkit'      -- hyperfunctions
    ];
BEGIN
    FOREACH ext IN ARRAY opt LOOP
        IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = ext) THEN
            BEGIN
                EXECUTE format('CREATE EXTENSION IF NOT EXISTS %I CASCADE', ext);
                RAISE NOTICE 'extension % created', ext;
            EXCEPTION WHEN OTHERS THEN
                RAISE WARNING 'extension % available but failed to create: %', ext, SQLERRM;
            END;
        ELSE
            RAISE WARNING 'extension % not available in this image - skipped', ext;
        END IF;
    END LOOP;
END $$;

-- Scratch databases (db/reference.sh's hpoc_reference, test databases) are
-- created fresh and need the same types available.
-- Templating them into template1 means every future createdb inherits them.
\c template1
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;
