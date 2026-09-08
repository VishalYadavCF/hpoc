-- migration: LangGraph's own checkpoint store, backed by Postgres
--
-- DeepAgents runs on LangGraph, and LangGraph persists through `BaseCheckpointSaver`.
-- ap-executor has no resume today only because it has no database to point that interface
-- at; we have one, so the whole of "surviving a crash mid-run" is a storage adapter rather
-- than a feature to build.
--
-- ## Why not reuse `checkpoints`
--
-- That table stores OUR `CheckpointState` -- adapter state plus the pendingAction /
-- pendingDelegation / pendingPeerCall a suspended run resumes into -- keyed by
-- (run_id, step_seq). LangGraph keys by (thread_id, checkpoint_ns, checkpoint_id), keeps a
-- parent pointer for forked threads, and needs a second relation for the pending writes of
-- an interrupted task. Forcing one model into the other's shape would corrupt both; the
-- `checkpoint_body_ck` and `durability` columns do not apply here at all.
--
-- ## Tenancy is not optional here
--
-- A checkpoint holds the full conversation state of a run, so an unscoped checkpoint table
-- would be a way around every RLS policy added in 0020 and 0023. `org_id` is therefore
-- NOT NULL and carries the same policy. The saver reads it from the RunnableConfig's
-- `configurable`, which is how per-call scope reaches an interface that only knows about
-- thread ids.
--
-- ## Why bytea rather than jsonb
--
-- `SerializerProtocol.dumpsTyped` returns `[type, Uint8Array]` and is allowed to produce
-- encodings JSON cannot round-trip. Storing the bytes it gives us, with the type tag it
-- gives us, keeps the serializer's contract intact instead of assuming it is always JSON.

CREATE TABLE langgraph_checkpoints (
    org_id               uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    thread_id            text NOT NULL,
    checkpoint_ns        text NOT NULL DEFAULT '',
    checkpoint_id        text NOT NULL,
    parent_checkpoint_id text,
    type                 text,
    checkpoint           bytea NOT NULL,
    metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

-- `list()` walks a thread newest-first, and `getTuple()` with no checkpoint_id asks for
-- the latest. checkpoint_id is a sortable time-ordered id, so ordering by it descending is
-- the same as ordering by time without trusting clocks across writers.
CREATE INDEX langgraph_checkpoints_thread_idx
    ON langgraph_checkpoints (thread_id, checkpoint_ns, checkpoint_id DESC);
CREATE INDEX langgraph_checkpoints_org_idx ON langgraph_checkpoints (org_id);

-- Writes belonging to a checkpoint that has not finished its step -- how an interrupted
-- task resumes without re-executing what it already did.
CREATE TABLE langgraph_checkpoint_writes (
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    thread_id     text NOT NULL,
    checkpoint_ns text NOT NULL DEFAULT '',
    checkpoint_id text NOT NULL,
    task_id       text NOT NULL,
    idx           integer NOT NULL,
    channel       text NOT NULL,
    type          text,
    value         bytea,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

CREATE INDEX langgraph_checkpoint_writes_org_idx ON langgraph_checkpoint_writes (org_id);

ALTER TABLE langgraph_checkpoints       ENABLE ROW LEVEL SECURITY;
ALTER TABLE langgraph_checkpoints       FORCE  ROW LEVEL SECURITY;
ALTER TABLE langgraph_checkpoint_writes ENABLE ROW LEVEL SECURITY;
ALTER TABLE langgraph_checkpoint_writes FORCE  ROW LEVEL SECURITY;

-- Compared AS TEXT, not cast to uuid: `current_setting(x, true)` returns '' rather than
-- NULL once a GUC has been set and reset in a session, and ''::uuid throws. Postgres also
-- does not guarantee AND short-circuits (manual 4.2.14), so a `<> ''` guard would not save
-- the cast. This is the same shape as the policies in 0020 and 0023.
CREATE POLICY langgraph_checkpoints_tenant ON langgraph_checkpoints
    USING (current_setting('app.bypass_rls', true) = 'on'
           OR org_id::text = current_setting('app.org_id', true))
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
           OR org_id::text = current_setting('app.org_id', true));

CREATE POLICY langgraph_checkpoint_writes_tenant ON langgraph_checkpoint_writes
    USING (current_setting('app.bypass_rls', true) = 'on'
           OR org_id::text = current_setting('app.org_id', true))
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
           OR org_id::text = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON langgraph_checkpoints       TO hpoc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON langgraph_checkpoint_writes TO hpoc_app;
