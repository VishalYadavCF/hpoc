-- migration: enums, tenancy, identity, registries, agents, tools, governance
-- generated from db/schema.sql; that file stays the readable whole-schema reference.

-- =====================================================================
-- General Agent Platform — PostgreSQL schema
-- Derived from pwd.md (v3 consolidated). Section refs (§) point back to it.
--
-- Conventions
--   * snake_case, plural table names, uuid v7-ish surrogate keys.
--   * timestamptz everywhere; no naked `timestamp`.
--   * Every execution/memory/artifact row carries org_id + namespace_id +
--     tenant_ref from day one (§5.2 — "tenant columns land in Phase 1").
--   * Nothing framework- or protocol-shaped in the core model (§0.3).
--     MCP/A2A specifics live in adapter-owned registry tables and in the
--     `protocol_metadata` jsonb column, never in runs/steps/events shape.
--   * No cache tables. Caches are never in the replay path (§10).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;
-- pgvector + the memory tables land in Phase 2 (§0.6). Phase 1 needs neither.

-- =====================================================================
-- 0. Enumerations
-- =====================================================================

CREATE TYPE principal_kind      AS ENUM ('human','workload','service');
CREATE TYPE data_class          AS ENUM ('internal','regulated');
CREATE TYPE residency           AS ENUM ('internal','external');          -- §16.1

CREATE TYPE agent_lifetime      AS ENUM ('registered','ephemeral');       -- §18.1
CREATE TYPE environment         AS ENUM ('staging','production');
CREATE TYPE transport           AS ENUM ('sse','webhook','poll',
                                         'voice_webrtc','voice_telephony');

CREATE TYPE run_status          AS ENUM ('queued','running','tool_execution',
                                         'checkpointed','waiting','completed',
                                         'failed','cancelled','dead_letter');  -- §4.1
CREATE TYPE durability_tier     AS ENUM ('strict','relaxed');             -- §4.3
CREATE TYPE run_initiator       AS ENUM ('api','trigger','schedule','peer','sub_agent');

CREATE TYPE step_kind           AS ENUM ('model_call','tool_call','memory_op',
                                         'delegation','interaction','context_op');
CREATE TYPE step_status         AS ENUM ('pending','running','succeeded','failed',
                                         'cancelled','compensated');

CREATE TYPE tool_origin         AS ENUM ('native','http','function','mcp','peer'); -- §8.1
CREATE TYPE effect_class        AS ENUM ('read_only','idempotent','non_idempotent',
                                         'transactional','compensatable','essential',
                                         'human_approval_required','cacheable');    -- §8.3

CREATE TYPE interaction_kind    AS ENUM ('approval','question','clarification',
                                         'authentication','escalation');   -- §14.1
CREATE TYPE interaction_status  AS ENUM ('pending','resolved','expired','cancelled');

CREATE TYPE memory_tier         AS ENUM ('working','conversational','semantic',
                                         'episodic','procedural','external');  -- §6.1
CREATE TYPE memory_scope        AS ENUM ('org','tenant','user','agent','thread','run');
CREATE TYPE memory_provenance   AS ENUM ('user_input','model_output','tool_output',
                                         'peer_result','artifact','consolidated'); -- §6.4

CREATE TYPE artifact_state      AS ENUM ('live','expiring','deleted');
CREATE TYPE trigger_type        AS ENUM ('http','event','webhook','schedule','callback'); -- §18.2
CREATE TYPE mcp_transport       AS ENUM ('stdio','streamable_http');       -- §13.1
CREATE TYPE peer_binding        AS ENUM ('local','remote');                -- §13.4
CREATE TYPE speech_kind         AS ENUM ('stt','tts');

CREATE TYPE enforcement_level   AS ENUM ('org','namespace','tenant','agent','worker_pool',
                                         'model','tool','mcp_server','peer',
                                         'speech_provider');               -- §5.1
CREATE TYPE saturation_policy   AS ENUM ('queue','throttle','shed');

CREATE TYPE lineage_node_kind   AS ENUM ('run','step','tool_invocation','memory',
                                         'artifact','interaction','peer_result',
                                         'user_input','model_output');     -- §15.3
CREATE TYPE grant_source        AS ENUM ('service','user');                -- §16.2
CREATE TYPE registry_status     AS ENUM ('active','deprecated','disabled');

-- =====================================================================
-- 1. Tenancy hierarchy and identity          (§5.2, §0.1, §16.3)
--    Org -> Namespace (service) -> Tenant -> User
-- =====================================================================

CREATE TABLE orgs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug          citext NOT NULL UNIQUE,
    name          text   NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- §17.7: a namespace maps to exactly one owning team. This is the
-- enforcement point for the sub-agent / peer boundary (§13.3).
CREATE TABLE namespaces (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    slug          citext NOT NULL,
    owning_team   text   NOT NULL,
    owner_contact text   NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, slug),
    UNIQUE (id, org_id)                     -- composite target for FK fan-out
);

-- The consuming service's own customer. `tenant_ref` is the value callers
-- pass on every run; the row exists so quotas, budgets and residency can
-- hang off it.
CREATE TABLE tenants (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE RESTRICT,
    tenant_ref        text NOT NULL,
    display_name      text,
    data_class        data_class NOT NULL DEFAULT 'internal',
    residency_region  text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (namespace_id, tenant_ref)
);

-- Humans, agent workload identities and calling services share one table so
-- the delegation chain can reference a single principal type (§0.1).
CREATE TABLE principals (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    kind          principal_kind NOT NULL,
    subject       text NOT NULL,            -- IdP subject / workload identity URI
    display_name  text,
    disabled_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, kind, subject)
);

-- =====================================================================
-- 2. Control-plane registries                (§17.1 – §17.3, §9)
-- =====================================================================

-- §9 model gateway + §0.5 capability declarations. `capabilities` records
-- native_long_context / native_tool_loop / extended_thinking / native_memory
-- so agents can defer to native capability instead of compensating.
CREATE TABLE models (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                    uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    ref                       citext NOT NULL,
    provider                  text   NOT NULL,
    provider_model_id         text   NOT NULL,
    residency                 residency NOT NULL,
    region                    text,
    capabilities              jsonb  NOT NULL DEFAULT '{}'::jsonb,
    context_window_tokens     integer,
    max_output_tokens         integer,
    input_cost_micros_per_1k  bigint,
    output_cost_micros_per_1k bigint,
    fallback_model_id         uuid REFERENCES models(id) ON DELETE SET NULL,
    status                    registry_status NOT NULL DEFAULT 'active',
    created_at                timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, ref)
);

-- §17.2 prompts are versioned platform resources, never blobs in a spec.
CREATE TABLE prompts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    namespace_id  uuid NOT NULL REFERENCES namespaces(id) ON DELETE RESTRICT,
    ref           citext NOT NULL,
    owner         text   NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, ref)
);

CREATE TABLE prompt_versions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    prompt_id     uuid NOT NULL REFERENCES prompts(id) ON DELETE RESTRICT,
    version       integer NOT NULL,
    body          text    NOT NULL,
    content_hash  text    NOT NULL,          -- prompt-cache key input (§10)
    approved_by   uuid REFERENCES principals(id),
    approved_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (prompt_id, version),
    UNIQUE (prompt_id, content_hash)
);

-- §17.3 policies: tool permissions, model restrictions, residency, spend,
-- approval requirements, trust boundaries — referenced by many agents.
CREATE TABLE policies (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    ref           citext NOT NULL,
    owner         text   NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, ref)
);

CREATE TABLE policy_versions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id     uuid NOT NULL REFERENCES policies(id) ON DELETE RESTRICT,
    version       integer NOT NULL,
    document      jsonb   NOT NULL,
    content_hash  text    NOT NULL,
    approved_by   uuid REFERENCES principals(id),
    approved_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (policy_id, version)
);

-- §13.1/§13.2. Registry entry only — servers are referenced by id, never
-- defined inline in a spec (§18.5).
CREATE TABLE mcp_servers (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    namespace_id       uuid NOT NULL REFERENCES namespaces(id) ON DELETE RESTRICT,
    name               citext NOT NULL,
    mcp_transport      mcp_transport NOT NULL,
    endpoint_url       text,                 -- streamable_http
    command            text[],               -- stdio
    protocol_revision  text NOT NULL,        -- pinned dated revision, never "latest"
    residency          residency NOT NULL,
    allow_sampling     boolean NOT NULL DEFAULT false,   -- off by default (§13.1)
    rate_limit_qps     integer,              -- downstream limit is first-class (§5.1)
    status             registry_status NOT NULL DEFAULT 'active',
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, name),
    CONSTRAINT mcp_server_endpoint_ck CHECK (
        (mcp_transport = 'streamable_http' AND endpoint_url IS NOT NULL)
     OR (mcp_transport = 'stdio'           AND command      IS NOT NULL)
    )
);

-- §13.2 tool definitions are pinned by content hash; any change fails closed.
CREATE TABLE mcp_server_tools (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mcp_server_id      uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    tool_name          text NOT NULL,
    definition_hash    text NOT NULL,
    definition         jsonb NOT NULL,
    first_seen_at      timestamptz NOT NULL DEFAULT now(),
    approved_by        uuid REFERENCES principals(id),
    approved_at        timestamptz,
    superseded_at      timestamptz,          -- set when the server mutates the def
    UNIQUE (mcp_server_id, tool_name, definition_hash)
);

-- §13.2 approval is tenant-scoped: bound by one team != available to another.
CREATE TABLE mcp_server_approvals (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mcp_server_id  uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    namespace_id   uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    tenant_ref     text,                     -- NULL = whole namespace
    approved_by    uuid NOT NULL REFERENCES principals(id),
    approved_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at     timestamptz,
    UNIQUE (mcp_server_id, namespace_id, tenant_ref)
);

-- §13.6 peer registry. Callers name a peer; the registry resolves the binding.
CREATE TABLE peers (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE RESTRICT,
    name              citext NOT NULL,
    binding           peer_binding NOT NULL,
    local_agent_id    uuid,                  -- FK added after agents (below)
    endpoint_url      text,
    protocol_version  text NOT NULL,
    residency         residency NOT NULL,
    agent_card        jsonb,                 -- derived/received, not hand-registered
    card_signature    text,
    card_verified_at  timestamptz,
    status            registry_status NOT NULL DEFAULT 'active',
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, name),
    CONSTRAINT peer_binding_ck CHECK (
        (binding = 'local'  AND local_agent_id IS NOT NULL)
     OR (binding = 'remote' AND endpoint_url   IS NOT NULL AND agent_card IS NOT NULL)
    )
);

-- §12.3 speech providers, with the concurrency ceiling made explicit rather
-- than discovered through errors.
CREATE TABLE speech_providers (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                   uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    name                     citext NOT NULL,
    speech_kind              speech_kind NOT NULL,
    residency                residency NOT NULL,
    region                   text,
    languages                text[] NOT NULL DEFAULT '{}',
    cost_tier                text,
    max_concurrent_sessions  integer,
    status                   registry_status NOT NULL DEFAULT 'active',
    UNIQUE (org_id, name, speech_kind)
);

-- =====================================================================
-- 3. Agents, versions and their bindings     (§3, §17.4, §19)
-- =====================================================================

CREATE TABLE agents (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    namespace_id   uuid NOT NULL REFERENCES namespaces(id) ON DELETE RESTRICT,
    name           citext NOT NULL,
    owner          text   NOT NULL,
    description    text,
    expose_as_peer boolean NOT NULL DEFAULT false,   -- §13.6 card is derived
    archived_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (namespace_id, name),
    -- Composite key so child tables can FK on (namespace_id, agent_id) and
    -- get the same-namespace rule enforced structurally (§13.3).
    UNIQUE (id, namespace_id)
);

ALTER TABLE peers
    ADD CONSTRAINT peers_local_agent_fk
    FOREIGN KEY (local_agent_id) REFERENCES agents(id) ON DELETE RESTRICT;

-- Immutable materialised spec. Runs bind to a version, never to an agent.
-- Ephemeral versions are anonymous and content-addressed (§18.1) so runs
-- stay replayable.
CREATE TABLE agent_versions (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id              uuid REFERENCES agents(id) ON DELETE RESTRICT,
    org_id                uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    namespace_id          uuid NOT NULL REFERENCES namespaces(id) ON DELETE RESTRICT,
    lifetime              agent_lifetime NOT NULL,
    version               integer,                     -- NULL for ephemeral
    spec                  jsonb   NOT NULL,            -- full AgentSpec (§19)
    spec_hash             text    NOT NULL,

    -- Denormalised from `spec` only where the runtime enforces or joins on it.
    workload_identity_id  uuid NOT NULL REFERENCES principals(id),   -- §0.1
    model_id              uuid NOT NULL REFERENCES models(id),
    prompt_version_id     uuid REFERENCES prompt_versions(id),
    policy_version_id     uuid REFERENCES policy_versions(id),
    durability            durability_tier NOT NULL DEFAULT 'strict',
    transport             transport NOT NULL DEFAULT 'sse',
    data_class            data_class NOT NULL DEFAULT 'internal',
    tenant_isolation      text NOT NULL DEFAULT 'strict',
    max_steps             integer,
    max_tokens            bigint,
    max_cost_micros       bigint,
    step_timeout_ms       integer NOT NULL DEFAULT 30000,
    run_timeout_ms        integer NOT NULL DEFAULT 1800000,
    max_retries           smallint NOT NULL DEFAULT 3,
    max_concurrent_runs   integer,
    on_saturation         saturation_policy NOT NULL DEFAULT 'queue',
    overridable_fields    text[] NOT NULL DEFAULT '{}',  -- default deny (§18.5)
    created_by            uuid REFERENCES principals(id),
    created_at            timestamptz NOT NULL DEFAULT now(),

    UNIQUE (agent_id, version),
    UNIQUE (org_id, spec_hash),
    CONSTRAINT agent_version_lifetime_ck CHECK (
        (lifetime = 'registered' AND agent_id IS NOT NULL AND version IS NOT NULL)
     OR (lifetime = 'ephemeral'  AND agent_id IS NULL     AND version IS NULL)
    ),
    UNIQUE (id, namespace_id)
);

-- §8.1 unified tool registry. `origin` preserves protocol metadata so
-- observability can attribute latency and failure correctly (§8.1).
CREATE TABLE tools (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE RESTRICT,
    ref               citext  NOT NULL,          -- e.g. 'loan.balance.read'
    version           integer NOT NULL DEFAULT 1,
    origin            tool_origin NOT NULL,
    residency         residency   NOT NULL,
    description       text,
    input_schema      jsonb NOT NULL,
    output_schema     jsonb,
    default_effects   effect_class[] NOT NULL,   -- §8.3 declared, never inferred
    timeout_ms        integer NOT NULL DEFAULT 30000,
    max_retries       smallint NOT NULL DEFAULT 0,
    sandbox_profile   text NOT NULL,             -- §0.4 uniform isolation
    endpoint_url      text,                      -- origin = http
    mcp_server_id     uuid REFERENCES mcp_servers(id) ON DELETE RESTRICT,
    mcp_tool_name     text,
    definition_hash   text,                      -- pinned for origin = mcp
    status            registry_status NOT NULL DEFAULT 'active',
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, ref, version),
    CONSTRAINT tool_mcp_ck CHECK (
        origin <> 'mcp'
     OR (mcp_server_id IS NOT NULL AND mcp_tool_name IS NOT NULL
         AND definition_hash IS NOT NULL)
    ),
    CONSTRAINT tool_http_ck CHECK (origin <> 'http' OR endpoint_url IS NOT NULL)
);

-- Per-agent tool binding carrying the effect contract actually in force.
-- Explicit allowlist: never a whole server surface by default (§13.2).
CREATE TABLE agent_version_tools (
    agent_version_id       uuid NOT NULL REFERENCES agent_versions(id) ON DELETE CASCADE,
    tool_id                uuid NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
    effects                effect_class[] NOT NULL,
    cache_ttl_seconds      integer,
    cache_scope            text,                    -- 'tenant' | 'user' | 'agent'
    idempotency_key_tpl    text,                    -- e.g. '${runId}:${invoiceId}'
    compensation_tool_id   uuid REFERENCES tools(id) ON DELETE RESTRICT,
    PRIMARY KEY (agent_version_id, tool_id),

    -- §10: cacheability is declared and only ever for read-only tools.
    CONSTRAINT cacheable_is_read_only_ck CHECK (
        NOT ('cacheable' = ANY (effects)) OR 'read_only' = ANY (effects)
    ),
    CONSTRAINT cacheable_needs_ttl_ck CHECK (
        NOT ('cacheable' = ANY (effects)) OR cache_ttl_seconds IS NOT NULL
    ),
    -- §4.5: an idempotent tool is retried *with* a key, or it is not idempotent.
    CONSTRAINT idempotent_needs_key_ck CHECK (
        NOT ('idempotent' = ANY (effects)) OR idempotency_key_tpl IS NOT NULL
    ),
    -- §8.3: compensatable means a *named* inverse exists.
    CONSTRAINT compensatable_needs_inverse_ck CHECK (
        NOT ('compensatable' = ANY (effects)) OR compensation_tool_id IS NOT NULL
    ),
    CONSTRAINT effect_exclusivity_ck CHECK (
        NOT ('read_only' = ANY (effects) AND 'non_idempotent' = ANY (effects))
    )
);

-- §13.3 enforced structurally: a sub-agent must live in the caller's own
-- namespace. Cross-namespace invocation goes over A2A, always.
CREATE TABLE agent_version_sub_agents (
    agent_version_id  uuid NOT NULL,
    namespace_id      uuid NOT NULL,
    sub_agent_id      uuid NOT NULL,
    alias             text NOT NULL,
    PRIMARY KEY (agent_version_id, sub_agent_id),
    FOREIGN KEY (agent_version_id, namespace_id)
        REFERENCES agent_versions(id, namespace_id) ON DELETE CASCADE,
    FOREIGN KEY (sub_agent_id, namespace_id)
        REFERENCES agents(id, namespace_id) ON DELETE RESTRICT
);

CREATE TABLE agent_version_peers (
    agent_version_id  uuid NOT NULL REFERENCES agent_versions(id) ON DELETE CASCADE,
    peer_id           uuid NOT NULL REFERENCES peers(id) ON DELETE RESTRICT,
    alias             text NOT NULL,
    PRIMARY KEY (agent_version_id, peer_id)
);

CREATE TABLE agent_version_mcp_servers (
    agent_version_id  uuid NOT NULL REFERENCES agent_versions(id) ON DELETE CASCADE,
    mcp_server_id     uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE RESTRICT,
    allowed_tools     text[] NOT NULL,          -- explicit allowlist, no wildcard
    allow_sampling    boolean NOT NULL DEFAULT false,
    PRIMARY KEY (agent_version_id, mcp_server_id),
    CONSTRAINT mcp_allowlist_non_empty_ck CHECK (cardinality(allowed_tools) > 0)
);

CREATE TABLE agent_version_speech (
    agent_version_id    uuid NOT NULL REFERENCES agent_versions(id) ON DELETE CASCADE,
    speech_provider_id  uuid NOT NULL REFERENCES speech_providers(id) ON DELETE RESTRICT,
    speech_kind         speech_kind NOT NULL,
    PRIMARY KEY (agent_version_id, speech_kind)
);

-- §18.2 generic execution triggers; domain scheduling stays in the caller.
CREATE TABLE triggers (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    pinned_version_id uuid REFERENCES agent_versions(id) ON DELETE SET NULL,
    trigger_type      trigger_type NOT NULL,
    event_source      text,
    event_type        text,
    webhook_path      text,
    cron_expression   text,
    timezone          text NOT NULL DEFAULT 'UTC',
    config            jsonb NOT NULL DEFAULT '{}'::jsonb,
    enabled           boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT trigger_shape_ck CHECK (
        (trigger_type = 'event'    AND event_source IS NOT NULL AND event_type IS NOT NULL)
     OR (trigger_type = 'webhook'  AND webhook_path IS NOT NULL)
     OR (trigger_type = 'schedule' AND cron_expression IS NOT NULL)
     OR (trigger_type IN ('http','callback'))
    )
);
CREATE UNIQUE INDEX triggers_webhook_path_uq
    ON triggers (webhook_path) WHERE webhook_path IS NOT NULL;
CREATE INDEX triggers_event_idx
    ON triggers (event_source, event_type) WHERE enabled AND trigger_type = 'event';

-- §17.4 deployment, canary and shadow rollout.
CREATE TABLE deployments (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id               uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    environment            environment NOT NULL,
    agent_version_id       uuid NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
    canary_percent         smallint NOT NULL DEFAULT 100
                             CHECK (canary_percent BETWEEN 0 AND 100),
    shadow_from_version_id uuid REFERENCES agent_versions(id) ON DELETE SET NULL,
    promotion_eval_run_id  uuid,                 -- FK added after eval_runs
    state                  text NOT NULL DEFAULT 'active'
                             CHECK (state IN ('active','rolling','rolled_back','retired')),
    promoted_by            uuid REFERENCES principals(id),
    promoted_at            timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX deployments_active_uq
    ON deployments (agent_id, environment) WHERE state = 'active';

-- §17.5 admission control. Rejections are explicit; silent narrowing is a bug.
CREATE TABLE admission_decisions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id       uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    spec_hash          text NOT NULL,
    agent_version_id   uuid REFERENCES agent_versions(id) ON DELETE SET NULL,
    caller_principal_id uuid NOT NULL REFERENCES principals(id),
    approved           boolean NOT NULL,
    rejection_reasons  jsonb NOT NULL DEFAULT '[]'::jsonb,
    checks             jsonb NOT NULL DEFAULT '{}'::jsonb,
    decided_at         timestamptz NOT NULL DEFAULT now()
);
-- §18.5: rising distinct inline-spec cardinality per caller is the signal
-- that a service is interpolating variable content into its system prompt.
CREATE INDEX admission_spec_hash_idx
    ON admission_decisions (caller_principal_id, spec_hash, decided_at DESC);

-- =====================================================================
-- 4. Authorization, credentials and governance   (§16.2, §16.3, §5.1)
-- =====================================================================

-- effective capability = spec ∩ service grant ∩ user grant (§16.2).
-- Both halves of the intersection live here, distinguished by grant_source.
CREATE TABLE capability_grants (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    grant_source       grant_source NOT NULL,
    namespace_id       uuid REFERENCES namespaces(id) ON DELETE CASCADE,
    grantee_principal_id uuid REFERENCES principals(id) ON DELETE CASCADE,
    resource_kind      text NOT NULL
                         CHECK (resource_kind IN ('tool','model','mcp_server','peer',
                                                  'prompt','policy','memory_scope')),
    resource_id        uuid NOT NULL,
    tenant_ref         text,                    -- NULL = all tenants in namespace
    constraints        jsonb NOT NULL DEFAULT '{}'::jsonb,
    granted_by         uuid NOT NULL REFERENCES principals(id),
    granted_at         timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz,
    revoked_at         timestamptz,
    CONSTRAINT grant_subject_ck CHECK (
        (grant_source = 'service' AND namespace_id IS NOT NULL)
     OR (grant_source = 'user'    AND grantee_principal_id IS NOT NULL)
    )
);
CREATE INDEX capability_grants_lookup_idx
    ON capability_grants (org_id, resource_kind, resource_id)
    WHERE revoked_at IS NULL;

-- §16.3 broker audit trail. No secret material is stored — only the fact of
-- issuance, its audience, and who it was minted on behalf of.
CREATE TABLE credential_grants (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                 uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    run_id                 uuid NOT NULL,
    step_id                uuid,
    workload_identity_id   uuid NOT NULL REFERENCES principals(id),
    on_behalf_of_principal_id uuid REFERENCES principals(id),
    audience               text   NOT NULL,
    scopes                 text[] NOT NULL,
    tenant_ref             text,
    token_id               text   NOT NULL,     -- jti; never the token itself
    issued_at              timestamptz NOT NULL DEFAULT now(),
    expires_at             timestamptz NOT NULL,
    revoked_at             timestamptz,
    UNIQUE (token_id)
);

-- §5.1 backpressure declared per level; every level states its saturation
-- response rather than queueing without a bound.
CREATE TABLE backpressure_policies (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    level             enforcement_level NOT NULL,
    scope_ref         text NOT NULL,           -- id or ref of the thing limited
    max_concurrency   integer,
    max_rate_per_sec  numeric(12,3),
    queue_depth_limit integer,
    on_saturation     saturation_policy NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, level, scope_ref),
    CONSTRAINT queue_needs_bound_ck CHECK (
        on_saturation <> 'queue' OR queue_depth_limit IS NOT NULL
    )
);

-- §5.2 hierarchical budgets; §13.5 delegation decrements the *originating*
-- tenant's ceiling.
CREATE TABLE budgets (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    level             enforcement_level NOT NULL,
    scope_ref         text NOT NULL,
    period            text NOT NULL CHECK (period IN ('hour','day','month','total')),
    limit_micros      bigint  NOT NULL,
    spent_micros      bigint  NOT NULL DEFAULT 0,
    period_started_at timestamptz NOT NULL DEFAULT now(),
    resets_at         timestamptz,
    UNIQUE (org_id, level, scope_ref, period)
);
