-- migration: threads, runs, queue, steps, tool invocations, checkpoints, interactions
-- generated from db/schema.sql; that file stays the readable whole-schema reference.


-- =====================================================================
-- 5. Execution: threads, runs, steps, tool invocations   (§3, §4)
--    Thread carries continuity (workspace, artifacts, memory);
--    Run carries execution (retries, checkpoints, leases). §3.
-- =====================================================================

CREATE TABLE threads (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE RESTRICT,
    tenant_ref        text NOT NULL,
    tenant_id         uuid REFERENCES tenants(id) ON DELETE RESTRICT,
    agent_id          uuid REFERENCES agents(id) ON DELETE RESTRICT,
    user_principal_id uuid REFERENCES principals(id),
    external_ref      text,        -- caller's own correlation handle
    title             text,
    status            text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','archived')),
    metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    archived_at       timestamptz,
    UNIQUE (namespace_id, external_ref)
);
CREATE INDEX threads_tenant_idx ON threads (org_id, namespace_id, tenant_ref, updated_at DESC);

-- The unit of durability, delegation and cost (§3).
CREATE TABLE runs (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id              uuid NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
    agent_version_id       uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
    org_id                 uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    namespace_id           uuid NOT NULL REFERENCES namespaces(id) ON DELETE RESTRICT,
    tenant_ref             text NOT NULL,
    tenant_id              uuid REFERENCES tenants(id) ON DELETE RESTRICT,

    status                 run_status NOT NULL DEFAULT 'queued',
    durability             durability_tier NOT NULL,
    initiator              run_initiator NOT NULL,
    trigger_id             uuid REFERENCES triggers(id) ON DELETE SET NULL,

    -- §0.1 delegation chain: which human authorised this, through which
    -- chain of agents, exercising whose permissions.
    parent_run_id          uuid REFERENCES runs(id) ON DELETE RESTRICT,
    root_run_id            uuid REFERENCES runs(id) ON DELETE RESTRICT,
    delegation_depth       smallint NOT NULL DEFAULT 0,
    delegation_chain       jsonb NOT NULL DEFAULT '[]'::jsonb,
    caller_principal_id    uuid NOT NULL REFERENCES principals(id),
    on_behalf_of_principal_id uuid REFERENCES principals(id),
    authorizing_human_id   uuid REFERENCES principals(id),

    -- §4.4 / §4.5
    idempotency_key        text,
    attempt                integer NOT NULL DEFAULT 1,

    input                  jsonb,
    input_artifact_id      uuid,               -- FK added after artifacts
    output                 jsonb,
    output_artifact_id     uuid,
    error                  jsonb,

    -- §15.1 correlation
    trace_id               text,
    correlation_id         text,
    causation_id           text,

    -- Ordering cursor for the event log; allocated in the same transaction
    -- as the event insert, which is what gives total order per run (§4.5).
    last_event_seq         bigint NOT NULL DEFAULT 0,
    last_checkpoint_id     uuid,               -- FK added after checkpoints
    forked_from_checkpoint_id uuid,

    -- Budget and cost accounting (§9, §13.5)
    max_cost_micros        bigint,
    cost_micros            bigint NOT NULL DEFAULT 0,
    input_tokens           bigint NOT NULL DEFAULT 0,
    output_tokens          bigint NOT NULL DEFAULT 0,
    step_count             integer NOT NULL DEFAULT 0,

    deadline_at            timestamptz,
    queued_at              timestamptz NOT NULL DEFAULT now(),
    started_at             timestamptz,
    ended_at               timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT run_depth_ck    CHECK (delegation_depth BETWEEN 0 AND 16),  -- §4.6
    CONSTRAINT run_no_self_ck  CHECK (parent_run_id IS DISTINCT FROM id),
    CONSTRAINT run_root_ck     CHECK (
        (parent_run_id IS NULL AND delegation_depth = 0)
     OR (parent_run_id IS NOT NULL AND root_run_id IS NOT NULL AND delegation_depth > 0)
    ),
    CONSTRAINT run_terminal_ck CHECK (
        status NOT IN ('completed','failed','cancelled','dead_letter')
        OR ended_at IS NOT NULL
    )
);

-- Idempotent run creation, per caller.
CREATE UNIQUE INDEX runs_idempotency_uq
    ON runs (namespace_id, tenant_ref, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX runs_active_idx     ON runs (status, deadline_at)
    WHERE status IN ('queued','running','tool_execution','waiting','checkpointed');
CREATE INDEX runs_thread_idx     ON runs (thread_id, created_at DESC);
CREATE INDEX runs_parent_idx     ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX runs_tenant_idx     ON runs (org_id, namespace_id, tenant_ref, created_at DESC);
CREATE INDEX runs_trace_idx      ON runs (trace_id) WHERE trace_id IS NOT NULL;

ALTER TABLE credential_grants
    ADD CONSTRAINT credential_grants_run_fk
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;

-- §4.4 durable queue. Kept out of `runs` so lease heartbeats do not churn
-- the wide row. Claimed with SELECT ... FOR UPDATE SKIP LOCKED; a worker
-- that dies mid-step has its lease expire and the run returns to the queue.
CREATE TABLE run_queue (
    run_id             uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    worker_pool        text NOT NULL DEFAULT 'default',
    priority           smallint NOT NULL DEFAULT 100,
    visible_at         timestamptz NOT NULL DEFAULT now(),
    attempts           integer NOT NULL DEFAULT 0,
    lease_owner        text,                   -- worker instance id
    -- Fencing token. Incremented on every claim; the worker carries it and every
    -- durable write asserts it. Heartbeats only shorten the split-brain window --
    -- a worker stalled in GC can lose its lease, have the run reclaimed, then wake
    -- and write into a run it no longer owns. This is what makes that impossible.
    lease_epoch        bigint NOT NULL DEFAULT 0,
    lease_expires_at   timestamptz,
    heartbeat_at       timestamptz,
    enqueued_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT lease_pair_ck CHECK (
        (lease_owner IS NULL     AND lease_expires_at IS NULL)
     OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
);
CREATE INDEX run_queue_claimable_idx
    ON run_queue (worker_pool, priority, visible_at)
    WHERE lease_owner IS NULL;
CREATE INDEX run_queue_expired_lease_idx
    ON run_queue (lease_expires_at)
    WHERE lease_owner IS NOT NULL;

-- One durable increment (§3). seq is dense and per-run.
CREATE TABLE steps (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id             uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq                integer NOT NULL,
    parent_step_id     uuid REFERENCES steps(id) ON DELETE SET NULL,
    kind               step_kind NOT NULL,
    status             step_status NOT NULL DEFAULT 'pending',
    attempt            smallint NOT NULL DEFAULT 1,

    org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id       uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    tenant_ref         text NOT NULL,

    -- model_call detail (§9). fallback_from_model_id makes a silent provider
    -- switch diagnosable.
    model_id             uuid REFERENCES models(id),
    fallback_from_model_id uuid REFERENCES models(id),
    prompt_version_id    uuid REFERENCES prompt_versions(id),
    input_tokens         integer,
    output_tokens        integer,
    cached_input_tokens  integer,
    cost_micros          bigint,

    input              jsonb,
    input_artifact_id  uuid,
    output             jsonb,
    output_artifact_id uuid,
    error              jsonb,

    checkpoint_id      uuid,
    trace_id           text,
    span_id            text,

    started_at         timestamptz,
    ended_at           timestamptz,
    latency_ms         integer,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, seq)
);
CREATE INDEX steps_run_idx    ON steps (run_id, seq);
CREATE INDEX steps_status_idx ON steps (status) WHERE status IN ('pending','running');

-- §8.1 one row per tool execution regardless of origin, with the effect
-- contract snapshotted as it was at invocation time.
CREATE TABLE tool_invocations (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    step_id                uuid NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    run_id                 uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    thread_id              uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    org_id                 uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id           uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    tenant_ref             text NOT NULL,

    tool_id                uuid NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
    origin                 tool_origin NOT NULL,
    effects                effect_class[] NOT NULL,
    definition_hash        text,                 -- pinned MCP definition (§13.2)
    tool_version           integer NOT NULL,

    idempotency_key        text,
    attempt                smallint NOT NULL DEFAULT 1,

    -- §16.2 the resolved three-way intersection, recorded per call.
    authorized_principal_id uuid REFERENCES principals(id),
    capability_decision    jsonb NOT NULL DEFAULT '{}'::jsonb,
    credential_grant_id    uuid REFERENCES credential_grants(id) ON DELETE SET NULL,
    interaction_id         uuid,                 -- set for human_approval_required
    sandbox_profile        text NOT NULL,        -- §0.4
    sandbox_instance_id    text,

    request                jsonb,
    request_artifact_id    uuid,
    response               jsonb,
    response_artifact_id   uuid,
    error                  jsonb,
    status                 step_status NOT NULL DEFAULT 'pending',

    -- §8.3 compensation: the inverse invocation points back at what it undid.
    compensates_invocation_id uuid REFERENCES tool_invocations(id) ON DELETE SET NULL,

    -- Adapter-owned; never interpreted by the core runtime (§0.3).
    protocol_metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,

    started_at             timestamptz,
    ended_at               timestamptz,
    latency_ms             integer,
    created_at             timestamptz NOT NULL DEFAULT now()
);
-- §4.5 effectively-once for tools that declare idempotency support.
CREATE UNIQUE INDEX tool_invocations_idempotency_uq
    ON tool_invocations (tool_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX tool_invocations_run_idx  ON tool_invocations (run_id, created_at);
CREATE INDEX tool_invocations_tool_idx ON tool_invocations (tool_id, created_at DESC);

-- §4.2 resumable state snapshot at a step boundary. Forking and time-travel
-- both hang off parent_checkpoint_id.
CREATE TABLE checkpoints (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_seq              integer NOT NULL,
    schema_version        integer NOT NULL,     -- §0.2
    parent_checkpoint_id  uuid REFERENCES checkpoints(id) ON DELETE SET NULL,
    state                 jsonb,                -- inline for small states
    state_artifact_id     uuid,                 -- offloaded when large (§11.2)
    state_hash            text NOT NULL,
    durability            durability_tier NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, step_seq, created_at),
    CONSTRAINT checkpoint_body_ck CHECK (
        (state IS NOT NULL) <> (state_artifact_id IS NOT NULL)
    )
);
CREATE INDEX checkpoints_run_idx ON checkpoints (run_id, step_seq DESC);

ALTER TABLE runs  ADD CONSTRAINT runs_last_checkpoint_fk
    FOREIGN KEY (last_checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL;
ALTER TABLE runs  ADD CONSTRAINT runs_forked_from_fk
    FOREIGN KEY (forked_from_checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL;
ALTER TABLE steps ADD CONSTRAINT steps_checkpoint_fk
    FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL;

-- §14 durable request for human input, independent of channel. One row
-- serves approvals, MCP elicitation/sampling prompts and A2A input-required.
CREATE TABLE interactions (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                 uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    thread_id              uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    step_id                uuid REFERENCES steps(id) ON DELETE SET NULL,
    org_id                 uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id           uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    tenant_ref             text NOT NULL,

    kind                   interaction_kind NOT NULL,
    status                 interaction_status NOT NULL DEFAULT 'pending',
    prompt                 jsonb NOT NULL,
    response_schema        jsonb,

    -- §14.3 the interaction climbs the delegation chain to whoever can answer,
    -- carrying the originating user identity with it.
    originating_run_id     uuid REFERENCES runs(id) ON DELETE SET NULL,
    originating_principal_id uuid REFERENCES principals(id),
    delegation_chain       jsonb NOT NULL DEFAULT '[]'::jsonb,
    required_authorization jsonb NOT NULL DEFAULT '{}'::jsonb,

    responder_principal_id uuid REFERENCES principals(id),
    response               jsonb,

    expires_at             timestamptz NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    resolved_at            timestamptz,
    CONSTRAINT interaction_resolution_ck CHECK (
        status <> 'resolved'
        OR (responder_principal_id IS NOT NULL AND resolved_at IS NOT NULL)
    )
);
CREATE INDEX interactions_pending_idx ON interactions (expires_at)
    WHERE status = 'pending';
CREATE INDEX interactions_run_idx     ON interactions (run_id, created_at DESC);

ALTER TABLE tool_invocations
    ADD CONSTRAINT tool_invocations_interaction_fk
    FOREIGN KEY (interaction_id) REFERENCES interactions(id) ON DELETE SET NULL;
