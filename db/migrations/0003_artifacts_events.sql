-- migration: artifacts, event log, outbox, dead letters
-- generated from db/schema.sql; that file stays the readable whole-schema reference.


-- =====================================================================
-- 6. Artifacts and their lifecycle           (§11.2)
--    Postgres holds metadata, content hash and reference. Bytes live in
--    the object store. No large binary content in Postgres (§20).
-- =====================================================================

CREATE TABLE artifacts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    namespace_id        uuid NOT NULL REFERENCES namespaces(id) ON DELETE RESTRICT,
    tenant_ref          text NOT NULL,

    thread_id           uuid REFERENCES threads(id) ON DELETE SET NULL,
    produced_by_run_id  uuid REFERENCES runs(id) ON DELETE SET NULL,
    produced_by_step_id uuid REFERENCES steps(id) ON DELETE SET NULL,

    content_hash        text   NOT NULL,       -- content-addressed dedup
    storage_uri         text   NOT NULL,
    media_type          text   NOT NULL,
    size_bytes          bigint NOT NULL CHECK (size_bytes >= 0),
    encryption_key_ref  text   NOT NULL,

    version             integer NOT NULL DEFAULT 1,
    parent_artifact_id  uuid REFERENCES artifacts(id) ON DELETE SET NULL,

    -- Lifecycle: retention, TTL, GC, legal hold (§11.2). A dispute transcript
    -- under legal hold must survive TTL expiry, so GC consults both.
    retention_policy    text,
    expires_at          timestamptz,
    legal_hold          boolean NOT NULL DEFAULT false,
    state               artifact_state NOT NULL DEFAULT 'live',
    deleted_at          timestamptz,

    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),

    -- Dedup is per org so one tenant's bytes never resolve into another's.
    UNIQUE (org_id, content_hash)
);
CREATE INDEX artifacts_thread_idx ON artifacts (thread_id, created_at DESC);
CREATE INDEX artifacts_gc_idx     ON artifacts (expires_at)
    WHERE state = 'live' AND legal_hold = false AND expires_at IS NOT NULL;

ALTER TABLE runs
    ADD CONSTRAINT runs_input_artifact_fk  FOREIGN KEY (input_artifact_id)
        REFERENCES artifacts(id) ON DELETE SET NULL,
    ADD CONSTRAINT runs_output_artifact_fk FOREIGN KEY (output_artifact_id)
        REFERENCES artifacts(id) ON DELETE SET NULL;
ALTER TABLE steps
    ADD CONSTRAINT steps_input_artifact_fk  FOREIGN KEY (input_artifact_id)
        REFERENCES artifacts(id) ON DELETE SET NULL,
    ADD CONSTRAINT steps_output_artifact_fk FOREIGN KEY (output_artifact_id)
        REFERENCES artifacts(id) ON DELETE SET NULL;
ALTER TABLE tool_invocations
    ADD CONSTRAINT tool_inv_request_artifact_fk  FOREIGN KEY (request_artifact_id)
        REFERENCES artifacts(id) ON DELETE SET NULL,
    ADD CONSTRAINT tool_inv_response_artifact_fk FOREIGN KEY (response_artifact_id)
        REFERENCES artifacts(id) ON DELETE SET NULL;
ALTER TABLE checkpoints
    ADD CONSTRAINT checkpoints_state_artifact_fk FOREIGN KEY (state_artifact_id)
        REFERENCES artifacts(id) ON DELETE RESTRICT;

-- =====================================================================
-- 7. Event log — the system of record        (§0.2, §15.1)
--    Append-only. Total order per run via `seq`. Every row carries a
--    schema_version; upcasters lift historical rows at read time.
-- =====================================================================

CREATE TABLE events (
    id                 uuid NOT NULL DEFAULT gen_random_uuid(),
    run_id             uuid NOT NULL,
    seq                bigint NOT NULL,        -- allocated from runs.last_event_seq
    occurred_at        timestamptz NOT NULL DEFAULT now(),

    schema_version     integer NOT NULL,       -- §0.2, non-negotiable
    event_type         text    NOT NULL,       -- §15.1 taxonomy, e.g. 'run.waiting'

    thread_id          uuid NOT NULL,
    parent_run_id      uuid,
    step_id            uuid,
    agent_version_id   uuid NOT NULL,

    org_id             uuid NOT NULL,
    namespace_id       uuid NOT NULL,
    tenant_ref         text NOT NULL,

    -- §15.1 what makes a multi-agent execution one distributed trace
    trace_id           text,
    span_id            text,
    causation_id       text,
    correlation_id     text,
    principal_id       uuid,
    delegation_chain   jsonb NOT NULL DEFAULT '[]'::jsonb,

    -- Adapter-owned. Distinguishes native / MCP / HTTP / A2A without letting
    -- protocol shapes into the core columns (§0.3, §8.1).
    protocol_metadata  jsonb NOT NULL DEFAULT '{}'::jsonb,

    payload            jsonb NOT NULL,

    PRIMARY KEY (run_id, seq, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Postgres requires the partition key in the PK, so (run_id, seq) uniqueness
-- is not enforced across partitions by the index alone. Sequence allocation
-- is what actually guarantees it: writers take the row lock with
--   UPDATE runs SET last_event_seq = last_event_seq + 1
--     WHERE id = $1 RETURNING last_event_seq
-- inside the same transaction as the INSERT. That serialises allocation per
-- run and yields the total per-run ordering §4.5 promises.
CREATE INDEX events_run_seq_idx    ON events (run_id, seq);
CREATE INDEX events_type_idx       ON events (event_type, occurred_at DESC);
CREATE INDEX events_trace_idx      ON events (trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX events_causation_idx  ON events (causation_id) WHERE causation_id IS NOT NULL;
CREATE INDEX events_tenant_idx     ON events (org_id, namespace_id, tenant_ref, occurred_at DESC);

-- Monthly partitions; retention is a DETACH + DROP of the oldest, not a
-- mass DELETE. Replay-corpus partitions are exported before dropping (§0.2).
CREATE TABLE events_default PARTITION OF events DEFAULT;
-- e.g. CREATE TABLE events_2026_09 PARTITION OF events
--        FOR VALUES FROM ('2026-09-01Z') TO ('2026-10-01Z');

-- Registry of event schema versions and the upcasters that lift them (§0.2).
CREATE TABLE event_schema_versions (
    event_type       text    NOT NULL,
    schema_version   integer NOT NULL,
    json_schema      jsonb   NOT NULL,
    upcaster_ref     text,                     -- module handling v(n) -> v(n+1)
    introduced_at    timestamptz NOT NULL DEFAULT now(),
    retired_at       timestamptz,
    PRIMARY KEY (event_type, schema_version)
);

-- §4.5 transactional outbox: the side-effect half of effectively-once.
-- Written in the same transaction as the state change it accompanies.
CREATE TABLE outbox (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id             uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_id            uuid REFERENCES steps(id) ON DELETE CASCADE,
    tool_invocation_id uuid REFERENCES tool_invocations(id) ON DELETE CASCADE,
    destination        text NOT NULL,
    idempotency_key    text NOT NULL,
    payload            jsonb NOT NULL,
    status             text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','sent','failed','abandoned')),
    attempts           integer NOT NULL DEFAULT 0,
    next_attempt_at    timestamptz NOT NULL DEFAULT now(),
    last_error         jsonb,
    sent_at            timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (destination, idempotency_key)
);
CREATE INDEX outbox_pending_idx ON outbox (next_attempt_at)
    WHERE status = 'pending';

-- §4.4 dead-letter handling: a stuck run must be diagnosable at 2am (§0.8).
CREATE TABLE dead_letters (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id         uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_id        uuid REFERENCES steps(id) ON DELETE SET NULL,
    reason         text NOT NULL,
    error          jsonb NOT NULL,
    attempts       integer NOT NULL,
    last_worker    text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    acknowledged_by uuid REFERENCES principals(id),
    acknowledged_at timestamptz,
    replayed_run_id uuid REFERENCES runs(id) ON DELETE SET NULL
);
CREATE INDEX dead_letters_open_idx ON dead_letters (created_at DESC)
    WHERE acknowledged_at IS NULL;
