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
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector (§11.3)

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
CREATE TYPE run_initiator       AS ENUM ('api','trigger','schedule','peer','sub_agent','shadow');

-- 'peer_call' is separate from 'delegation' deliberately: a peer call crosses a
-- TRUST boundary (§13.3), with different failure semantics and different people
-- to page. A trace that cannot tell them apart cannot answer either question.
CREATE TYPE step_kind           AS ENUM ('model_call','tool_call','memory_op',
                                         'delegation','peer_call','interaction',
                                         'context_op');
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
CREATE TYPE peer_binding        AS ENUM ('local','remote','inbound');      -- §13.4, 0032
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
    -- Where the provider lives, and the NAME of the credential -- never its value.
    -- §16.3: the platform stores names, the secret store holds values.
    base_url                  text,
    credential_ref            text,
    status                    registry_status NOT NULL DEFAULT 'active',
    created_at                timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, ref),
    -- An external model with no endpoint or no credential is a registry entry that fails
    -- on first use. Refused at write time instead (§9).
    CONSTRAINT models_external_needs_endpoint_ck
        CHECK (residency <> 'external' OR (base_url IS NOT NULL AND credential_ref IS NOT NULL))
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
    card_fetched_at   timestamptz,
    -- Verifies the card, and held HERE rather than inside it: a document carrying the key
    -- that verifies it proves only that its author owns a keypair.
    public_key        text,
    -- §13.5: failure is CONTAINED by default, propagation opt-in. Per RELATIONSHIP, not
    -- per call site -- "the pricing team's service is advisory" and "the ledger is
    -- load-bearing" are different answers that should not be re-decided at each call.
    failure_mode      text NOT NULL DEFAULT 'contain'
                        CHECK (failure_mode IN ('contain', 'propagate')),
    -- A remote peer is egress (§16.1). No ceiling means an unbounded hold on one of our
    -- runs, decided by someone else's runtime.
    timeout_ms        integer NOT NULL DEFAULT 300000,
    -- §15.4: what we are willing to believe from this peer about identity and tenancy.
    -- The default is the strict reading -- the peer speaks for itself and nobody else.
    inbound_trust     text NOT NULL DEFAULT 'self'
                        CHECK (inbound_trust IN ('self', 'delegated_identity')),
    -- How this caller expects `message/send` answered (0032): `task` is A2A 0.3.0, `message`
    -- is one synchronous kind:"message" result, the dialect agentorchestratorsvc speaks.
    reply_mode        text NOT NULL DEFAULT 'task'
                        CHECK (reply_mode IN ('task', 'message')),
    status            registry_status NOT NULL DEFAULT 'active',
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, name),
    -- `inbound` (0032): a caller identity we accept but never call -- no agent of ours, no
    -- endpoint, no card. Compared as text so this matches what the migration could write.
    CONSTRAINT peer_binding_ck CHECK (
        (binding::text = 'local'   AND local_agent_id IS NOT NULL)
     OR (binding::text = 'remote'  AND endpoint_url   IS NOT NULL AND agent_card IS NOT NULL)
     OR (binding::text = 'inbound' AND local_agent_id IS NULL
                                   AND endpoint_url   IS NULL
                                   AND agent_card     IS NULL)
    ),
    -- A local peer's card is derived, so it has no signature to verify and no endpoint to
    -- fetch from.
    CONSTRAINT peer_local_has_no_remote_material_ck
        CHECK (binding = 'remote' OR (public_key IS NULL AND endpoint_url IS NULL))
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
    CONSTRAINT agent_version_lifetime_ck CHECK (
        (lifetime = 'registered' AND agent_id IS NOT NULL AND version IS NOT NULL)
     OR (lifetime = 'ephemeral'  AND agent_id IS NULL     AND version IS NULL)
    ),
    UNIQUE (id, namespace_id)
);

-- Uniqueness is scoped to the ephemeral lifetime deliberately: the index exists to
-- COLLAPSE repeated inline specs onto one version (§18.1), which is wrong for registered
-- versions -- two of those may share a spec and still be distinct release points.
CREATE UNIQUE INDEX agent_versions_ephemeral_spec_hash_uq
    ON agent_versions (org_id, spec_hash) WHERE lifetime = 'ephemeral';
CREATE INDEX agent_versions_spec_hash_idx ON agent_versions (org_id, spec_hash);

-- §8.1 unified tool registry. `origin` preserves protocol metadata so
-- observability can attribute latency and failure correctly (§8.1).
-- A grantable FAMILY of tools an inline spec may instantiate (§18.5).
--
-- The caller supplies the SHAPE (name, description, schema, path, arg placement). The
-- template supplies the CONTRACT (effects, residency, sandbox, timeout) and the reachable
-- origin. If a caller could declare its own effects, a payment tool self-declared
-- `read_only` would skip its approval gate and be cached, and §4.5 and §8.3 would become
-- advisory -- so nothing in a spec can touch the fields above the endpoint below.
CREATE TABLE tool_templates (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
    namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE RESTRICT,
    ref               citext  NOT NULL,          -- e.g. 'relay.piece'
    version           integer NOT NULL DEFAULT 1,
    description       text,

    -- THE CONTRACT. Inherited by every instantiation; not expressible in a spec.
    default_effects   effect_class[] NOT NULL,   -- §8.3 declared, never inferred
    residency         residency   NOT NULL,
    sandbox_profile   text    NOT NULL,          -- §0.4 uniform isolation
    timeout_ms        integer NOT NULL DEFAULT 30000,
    max_retries       smallint NOT NULL DEFAULT 0,

    -- THE REACHABLE SURFACE. The origin is fixed here; a spec supplies only a path below
    -- the prefix, so an instantiation cannot point the tool at a different host.
    endpoint_url      text    NOT NULL,
    allowed_methods   text[]  NOT NULL DEFAULT ARRAY['POST'],
    path_prefix       text    NOT NULL,
    -- Accept headers and API version pins. NEVER credentials: those are minted per call
    -- by the broker against the endpoint's audience (§16.3).
    static_headers    jsonb   NOT NULL DEFAULT '{}'::jsonb,
    -- A third-party API's own credential, by NAME (migration 0033). The secret store resolves
    -- it per call and the broker sends it INSTEAD of its platform token. NULL means the
    -- broker's token, which is right for any first-party service.
    credential_ref    text CHECK (credential_ref IS NULL OR credential_ref <> ''),

    -- A ceiling on how many tools one spec may instantiate. Without it a caller can put
    -- four hundred tools in a model's context and turn a prompt-size problem into an
    -- accuracy problem nobody attributes to the platform.
    max_instances     integer NOT NULL DEFAULT 32 CHECK (max_instances BETWEEN 1 AND 128),

    status            registry_status NOT NULL DEFAULT 'active',
    created_at        timestamptz NOT NULL DEFAULT now(),

    UNIQUE (org_id, ref, version),
    -- The sandbox's SSRF guard compares a resolved URL's origin to `endpoint_url`, and the
    -- prefix check below is a string comparison: a relative prefix would match nothing.
    CONSTRAINT tool_template_prefix_ck CHECK (path_prefix LIKE '/%'),
    CONSTRAINT tool_template_methods_ck CHECK (
        allowed_methods <@ ARRAY['GET','POST','PUT','PATCH','DELETE']
        AND cardinality(allowed_methods) > 0
    ),
    -- §10: cacheability is declared and only ever for read-only tools. Same rule as
    -- `agent_version_tools`, applied a level up so an instantiation cannot inherit an
    -- impossible contract.
    CONSTRAINT tool_template_cacheable_ck CHECK (
        NOT ('cacheable' = ANY (default_effects)) OR 'read_only' = ANY (default_effects)
    )
);

CREATE INDEX tool_templates_ref_idx ON tool_templates (org_id, ref) WHERE status = 'active';

ALTER TABLE tool_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_templates_tenant ON tool_templates
    USING (org_id::text = current_setting('app.org_id', true)
           OR current_setting('app.bypass_rls', true) = 'on');
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_templates TO hpoc_app;

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
    endpoint_url      text,                      -- origin = http; the ORIGIN plus any fixed prefix

    -- §8.1: the request SHAPE is data too. Without these, `origin = 'http'` meant only
    -- "POST to endpoint_url with the arguments as a JSON body" -- a first-party RPC call
    -- wearing the name of a protocol, which pushed every third-party API behind a shim
    -- service whose sole job was to accept our one hardcoded shape.
    http_method       text NOT NULL DEFAULT 'POST'
                        CHECK (http_method IN ('GET','POST','PUT','PATCH','DELETE')),
    -- RFC 6570 notation. `{name}` is one percent-encoded segment, so a value cannot
    -- invent a segment the template did not declare; `{+name}` allows `/` for APIs that
    -- take a file path in one position, and is the only way to get a slash through.
    path_template     text,
    -- Where arguments the template did not consume go. NULL means by method: query for
    -- GET and DELETE, body otherwise.
    arg_placement     text CHECK (arg_placement IS NULL
                                  OR arg_placement IN ('query','body','none')),
    -- Nests the MODEL's arguments under this key in the body, leaving bound arguments free to
    -- address the top level. NULL keeps them flat. Exists because a request body is not always
    -- the argument list: ap-executor's execute route wants
    -- `{ action, merchantId, auth, input: {...} }`, and asking the model to produce that nesting
    -- itself does not survive contact with a real one.
    arg_wrapper_key   text CHECK (arg_wrapper_key IS NULL OR arg_wrapper_key <> ''),
    -- Accept headers and API version pins. NEVER credentials: those are minted per call
    -- by the broker (§16.3) and are not registry data.
    static_headers    jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Copied from the template on instantiation, like endpoint_url (migration 0033).
    credential_ref    text CHECK (credential_ref IS NULL OR credential_ref <> ''),
    -- §8.1 `origin = 'function'`: the tool's own body, handed to the sandbox on stdin.
    -- Data rather than a baked image, for the same reason the HTTP shape above is data --
    -- a tool edit is an UPDATE, not a rebuild and a deploy. The harness in
    -- src/adapters/sandbox/harness.ts defines the calling convention.
    code_runtime      text CHECK (code_runtime IS NULL OR code_runtime IN ('node','python')),
    code_source       text,

    mcp_server_id     uuid REFERENCES mcp_servers(id) ON DELETE RESTRICT,
    mcp_tool_name     text,
    definition_hash   text,                      -- pinned for origin = mcp
    -- Set when this row was INSTANTIATED from a tool_template by an inline spec (§18.5).
    -- NULL for a registered tool. The template is what makes an instantiated tool
    -- revocable as a class, and `spec_hash` content-addresses the shape so a consuming
    -- service issuing the same node config ten thousand times gets one row.
    template_id       uuid REFERENCES tool_templates(id) ON DELETE RESTRICT,
    spec_hash         text,
    status            registry_status NOT NULL DEFAULT 'active',
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, ref, version),
    CONSTRAINT tool_mcp_ck CHECK (
        origin <> 'mcp'
     OR (mcp_server_id IS NOT NULL AND mcp_tool_name IS NOT NULL
         AND definition_hash IS NOT NULL)
    ),
    CONSTRAINT tool_http_ck CHECK (origin <> 'http' OR endpoint_url IS NOT NULL),
    -- The sandbox's SSRF guard compares the resolved URL's origin to `endpoint_url`, so a
    -- template with no endpoint would have nothing to be checked against.
    CONSTRAINT tool_template_needs_endpoint_ck
        CHECK (path_template IS NULL OR endpoint_url IS NOT NULL),
    -- A body on GET or DELETE is not portable and several servers reject it outright.
    CONSTRAINT tool_no_body_on_get_ck
        CHECK (arg_placement <> 'body' OR http_method NOT IN ('GET','DELETE')),
    -- Nesting is only meaningful when the arguments are in the body at all; in `query` or
    -- `none` there is no object to nest into, and ignoring it there would make a
    -- misconfiguration invisible.
    CONSTRAINT tool_arg_wrapper_needs_body
        CHECK (arg_wrapper_key IS NULL OR arg_placement IS NULL OR arg_placement = 'body'),
    -- A runtime with no body, or a body with no runtime, is a tool that cannot run.
    CONSTRAINT tool_code_pairing_ck
        CHECK ((code_runtime IS NULL) = (code_source IS NULL)),
    -- `origin = 'function'` MEANS there is code and the platform runs it. Without this a
    -- function tool can be registered that does nothing, which is the state migration
    -- 0021 exists to end.
    CONSTRAINT tool_function_needs_code_ck
        CHECK (origin <> 'function' OR code_source IS NOT NULL)
);

-- One row per distinct instantiated shape: a consuming service issuing the same node
-- config ten thousand times gets one tool and one cache key (§18.1's reasoning, applied
-- to tools instead of agent versions).
-- Not partial: ON CONFLICT cannot target a partial index without repeating its predicate,
-- and NULLs are distinct in a unique index, so registered tools coexist without collision.
CREATE UNIQUE INDEX tools_instantiated_hash_idx ON tools (org_id, spec_hash);

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
    -- Arguments the platform binds and the MODEL NEVER SEES: merged in after the model
    -- answers, and stripped from the schema it was shown (ai-agent's `fixed` field mode).
    fixed_args             jsonb NOT NULL DEFAULT '{}'::jsonb,
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
    PRIMARY KEY (agent_version_id, peer_id),
    -- Two peers under one alias would make dispatch ambiguous, and the ambiguity would be
    -- resolved by whichever row the planner returned first.
    CONSTRAINT agent_version_peers_alias_unique UNIQUE (agent_version_id, alias)
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
    -- The tenancy a fired run executes under. Taken from the caller who ATTACHED the
    -- trigger, because an external webhook caller has no identity headers -- the trigger
    -- row is what supplies tenancy on the ingress path.
    tenant_ref        text,
    enabled           boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT trigger_shape_ck CHECK (
        (trigger_type = 'event'    AND event_source IS NOT NULL AND event_type IS NOT NULL)
     OR (trigger_type = 'webhook'  AND webhook_path IS NOT NULL)
     OR (trigger_type = 'schedule' AND cron_expression IS NOT NULL)
     OR (trigger_type IN ('http','callback'))
    ),
    -- An enabled trigger with no tenancy would fire a run with nowhere to charge it and
    -- no isolation scope. Disabled rows may lack one, so the trigger can be created before
    -- its tenancy is decided.
    CONSTRAINT triggers_need_tenant_ck CHECK (NOT enabled OR tenant_ref IS NOT NULL)
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
    -- Who promoted past a failing or absent eval gate, and why. NULL is the normal case.
    -- Without a recorded override, a gate gets bypassed by editing the table during an
    -- incident and nobody ever knows (§16.4).
    gate_overridden_by     uuid REFERENCES principals(id),
    gate_override_reason   text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT deployment_override_needs_reason_ck
        CHECK (gate_overridden_by IS NULL OR gate_override_reason IS NOT NULL)
);
-- One live row per STATE, not one live row overall: during a genuine canary the old
-- version is `active` while the new one is `rolling`, so that pair is correct. What is
-- not correct is two rows for the SAME version in different states -- a canary promote
-- leaving a `rolling` row behind, a later rollback adding an `active` one, and the
-- environment then reported twice. Hence three partial indexes rather than one.
CREATE UNIQUE INDEX deployments_active_uq
    ON deployments (agent_id, environment) WHERE state = 'active';
CREATE UNIQUE INDEX deployments_rolling_uq
    ON deployments (agent_id, environment) WHERE state = 'rolling';
CREATE UNIQUE INDEX deployments_live_version_uq
    ON deployments (agent_id, environment, agent_version_id)
    WHERE state IN ('active', 'rolling');

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
                         CHECK (resource_kind IN ('tool','tool_template','model','mcp_server','peer',
                                                  'prompt','policy','memory_scope',
                                                  'skill','knowledge_collection')),
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
    -- §15.5: a shadow run is a real, budgeted, observable run, linked back to the run it
    -- shadows so the two can be compared. ON DELETE SET NULL: the shadow must never be
    -- able to block the primary run's retention, nor take it down if pruned first.
    shadow_of_run_id       uuid REFERENCES runs(id) ON DELETE SET NULL,

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
    -- §18.4 async mode: where to deliver the outcome when nobody holds a connection. The
    -- outbox row is written in the run's terminal transaction, so "completed but the
    -- caller was never told" is not a reachable state.
    delivery               jsonb,

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
CREATE INDEX runs_shadow_of_run_id_idx ON runs (shadow_of_run_id) WHERE shadow_of_run_id IS NOT NULL;

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
    -- Incremented on every claim, and READ by claim()'s `attempts < maxAttempts` cap
    -- plus the scheduler's lockExhausted() sweep. A worker that dies before recording
    -- its own failure cannot dead-letter itself, so without this cap a run that reliably
    -- crashes its worker cycles claim -> crash -> reclaim -> claim forever.
    attempts           integer NOT NULL DEFAULT 0,
    lease_owner        text,                   -- worker instance id
    -- Fencing token. Incremented on every claim; the worker carries it and every durable
    -- write asserts it. Heartbeats only shorten the split-brain window -- a worker stalled
    -- in GC can lose its lease, have the run reclaimed, then wake and write into a run it
    -- no longer owns. This is what makes that impossible rather than merely unlikely, and
    -- it is the one thing Conductor's `popped` boolean cannot express.
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
    -- Which agent version did the work. NULL means the run's own version, which is every
    -- step until an in-process sub-agent (§13.3) reasons inside its caller's run.
    agent_version_id   uuid REFERENCES agent_versions(id),
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
-- Attribution: "all steps this agent version did", across runs it did not own.
CREATE INDEX steps_agent_version_idx ON steps (agent_version_id) WHERE agent_version_id IS NOT NULL;

-- §8.1 one row per tool execution regardless of origin, with the effect
-- contract snapshotted as it was at invocation time.
CREATE TABLE tool_invocations (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The step's id, but NOT a foreign key (0031). A non-idempotent invocation is committed
    -- before its side effect, on its own connection, so the guard in §4.5 has something to
    -- find after a crash -- and at that moment the step row is still uncommitted in the
    -- transaction awaiting the tool call. A join to `steps` that returns nothing is the honest
    -- answer: it says that step never committed.
    step_id                uuid NOT NULL,
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
-- §4.5's guard runs once per resumed run, before the framework is driven. Partial, because
-- `running` is a vanishing fraction of the table and the only status it ever asks about.
CREATE INDEX tool_invocations_running_idx ON tool_invocations (run_id) WHERE status = 'running';

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

-- LangGraph's own checkpoint store (migration 0026).
--
-- Separate from `checkpoints` above because the two model different things: ours is keyed
-- (run_id, step_seq) and holds the pendingAction / pendingDelegation / pendingPeerCall a
-- suspended run resumes into; LangGraph keys (thread_id, checkpoint_ns, checkpoint_id),
-- keeps a parent pointer for forked threads, and needs a second relation for the pending
-- writes of an interrupted task.
--
-- `bytea` rather than `jsonb` because SerializerProtocol.dumpsTyped returns
-- [type, Uint8Array] and may produce encodings JSON cannot round-trip.
--
-- org_id is NOT NULL and RLS-scoped: a checkpoint holds a run's whole conversation state,
-- so an unscoped table here would be a way around every policy added in 0020 and 0023.
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
CREATE INDEX langgraph_checkpoints_thread_idx
    ON langgraph_checkpoints (thread_id, checkpoint_ns, checkpoint_id DESC);
CREATE INDEX langgraph_checkpoints_org_idx ON langgraph_checkpoints (org_id);

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

    -- Dedup is scoped to the TENANT, not the org. Scoped to the org, two tenants storing
    -- identical bytes -- the same template, the same checkout, the same empty document --
    -- collide, and the second resolves to the first's row along with its tenant_ref.
    -- Named explicitly so it matches what migration 0010 created. Dedup is scoped to the
    -- TENANT, not the org: org-wide dedup would let one tenant's upload satisfy another
    -- tenant's write and hand it a reference to bytes it never sent.
    CONSTRAINT artifacts_tenant_content_hash_key
        UNIQUE (org_id, namespace_id, tenant_ref, content_hash)
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

-- §15.2 OTLP export high-water mark. One row by construction: the CHECK makes a second
-- row unrepresentable, so a race cannot produce two disagreeing cursors.
CREATE TABLE trace_export_cursor (
    id                boolean PRIMARY KEY DEFAULT true CHECK (id),
    exported_through  timestamptz NOT NULL,
    updated_at        timestamptz NOT NULL DEFAULT now()
);

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

-- =====================================================================
-- 8. Memory                                  (§6)
-- =====================================================================

-- §6.2 cross-tenant memory sharing, decided by the CONSUMING service.
--
-- The conflict: a shared knowledge corpus is deliberately cross-merchant and PII-stripped,
-- because one merchant's successful build teaches the next. §5.2 makes tenant isolation
-- structural, and `scope = 'org'` could hold such a row but could not express "derived
-- from tenant A, intentionally readable by tenant B, because redacted".
--
-- Resolved as a CAPABILITY opted into per namespace, not a platform default: sharing
-- merchant-derived data is a decision only the service owning those merchants can make.
CREATE TABLE memory_sharing_policies (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id        uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    -- Per-tier: a service may share learned procedures while keeping episodic history
    -- strictly per-tenant.
    tiers               memory_tier[] NOT NULL,
    -- "We stripped it" has to be a recorded claim, not an assumption.
    redaction_policy    text NOT NULL,
    -- Off unless someone turns it on, and revocable without deleting the corpus others
    -- may have built on.
    enabled             boolean NOT NULL DEFAULT false,
    approved_by         uuid NOT NULL REFERENCES principals(id),
    approved_at         timestamptz NOT NULL DEFAULT now(),
    revoked_at          timestamptz,
    UNIQUE (org_id, namespace_id)
);

CREATE TABLE memory_records (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id       uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    tenant_ref         text NOT NULL,

    tier               memory_tier  NOT NULL,
    scope              memory_scope NOT NULL,
    -- Exactly one of these is populated, matching `scope` (see check below).
    scope_user_id      uuid REFERENCES principals(id) ON DELETE CASCADE,
    scope_agent_id     uuid REFERENCES agents(id) ON DELETE CASCADE,
    scope_thread_id    uuid REFERENCES threads(id) ON DELETE CASCADE,
    scope_run_id       uuid REFERENCES runs(id) ON DELETE CASCADE,

    content            text,
    structured         jsonb,
    artifact_id        uuid REFERENCES artifacts(id) ON DELETE SET NULL,  -- tier=external

    -- §6.4 provenance survives to retrieval time so "this is hearsay from
    -- peer X" stays answerable instead of being a policy hope.
    provenance         memory_provenance NOT NULL,
    source_run_id      uuid REFERENCES runs(id) ON DELETE SET NULL,
    source_step_id     uuid REFERENCES steps(id) ON DELETE SET NULL,
    source_peer_id     uuid REFERENCES peers(id) ON DELETE SET NULL,
    trusted            boolean NOT NULL DEFAULT false,

    -- §6.3 transcript fidelity: for conversational/episodic rows this records
    -- what the user actually received, not what the model generated. Voice
    -- barge-in truncates to played_offset_ms.
    delivered          boolean,
    played_offset_ms   integer,

    salience           real NOT NULL DEFAULT 0,
    access_count       integer NOT NULL DEFAULT 0,
    last_accessed_at   timestamptz,
    consolidated_from  uuid[] NOT NULL DEFAULT '{}',
    superseded_by      uuid REFERENCES memory_records(id) ON DELETE SET NULL,
    expires_at         timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    -- §6.2 opt-in cross-tenant pool membership. False for every record by default.
    -- `source_tenant_ref` is retained so §15.3 lineage can still answer "where did this
    -- claim come from" across the tenant boundary -- which is exactly what redaction
    -- otherwise destroys.
    shared             boolean NOT NULL DEFAULT false,
    sharing_policy_id  uuid REFERENCES memory_sharing_policies(id) ON DELETE SET NULL,
    source_tenant_ref  text,

    -- A shared row must NAME the policy that admitted it. Without this, flipping one
    -- boolean would be enough to expose a tenant's data with nothing recording who allowed it.
    CONSTRAINT memory_shared_needs_policy_ck
        CHECK (NOT shared OR (sharing_policy_id IS NOT NULL AND source_tenant_ref IS NOT NULL)),
    CONSTRAINT memory_scope_ref_ck CHECK (
        CASE scope
          WHEN 'org'    THEN scope_user_id IS NULL AND scope_agent_id IS NULL
                         AND scope_thread_id IS NULL AND scope_run_id IS NULL
          WHEN 'tenant' THEN scope_user_id IS NULL AND scope_agent_id IS NULL
                         AND scope_thread_id IS NULL AND scope_run_id IS NULL
          WHEN 'user'   THEN scope_user_id   IS NOT NULL
          WHEN 'agent'  THEN scope_agent_id  IS NOT NULL   -- registered agents only (§20)
          WHEN 'thread' THEN scope_thread_id IS NOT NULL
          WHEN 'run'    THEN scope_run_id    IS NOT NULL
        END
    ),
    CONSTRAINT memory_body_ck CHECK (
        content IS NOT NULL OR structured IS NOT NULL OR artifact_id IS NOT NULL
    ),
    CONSTRAINT memory_external_tier_ck CHECK (
        tier <> 'external' OR artifact_id IS NOT NULL
    )
);
CREATE INDEX memory_scope_idx  ON memory_records (org_id, namespace_id, tenant_ref, scope, tier)
    WHERE superseded_by IS NULL;
CREATE INDEX memory_thread_idx ON memory_records (scope_thread_id, created_at)
    WHERE scope_thread_id IS NOT NULL;
CREATE INDEX memory_expiry_idx ON memory_records (expires_at) WHERE expires_at IS NOT NULL;

-- Embeddings are keyed by model so a re-embed lands alongside the old vector
-- rather than replacing it mid-migration. §11.3: pgvector is the default,
-- not the contract — this table is the seam an alternative store replaces.
CREATE TABLE memory_embeddings (
    memory_id      uuid NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
    -- The EMBEDDER's identity string ("gemini:gemini-embedding-001@768"), not a row in
    -- `models`. An embedder is not an inference model and is not in that registry, so
    -- there is deliberately no FK here -- and the string carries the output dimension,
    -- because two embedders at different widths are not comparable and must not collide.
    model_id       text NOT NULL,
    dimensions     smallint NOT NULL,
    -- Matches EMBEDDING_DIMENSIONS on the Embedder port. Changing it is a migration AND a
    -- re-embed; both indexes that store vectors assert it at boot rather than returning a
    -- confidently wrong ranking.
    embedding      vector(768) NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (memory_id, model_id)
);
CREATE INDEX memory_embeddings_ann_idx ON memory_embeddings
    USING hnsw (embedding vector_cosine_ops);

-- =====================================================================
-- 9. Lineage                                 (§15.3)
--    Provenance traversable, not merely tagged: "where did this come from?"
-- =====================================================================

CREATE TABLE lineage_edges (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    tenant_ref    text NOT NULL,
    derived_kind  lineage_node_kind NOT NULL,
    derived_id    uuid NOT NULL,
    source_kind   lineage_node_kind NOT NULL,
    source_id     uuid NOT NULL,
    relation      text NOT NULL,          -- 'consolidated_from','produced_by','cited'
    run_id        uuid REFERENCES runs(id) ON DELETE SET NULL,
    observed_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (derived_kind, derived_id, source_kind, source_id, relation),
    CONSTRAINT lineage_no_self_ck CHECK (
        NOT (derived_kind = source_kind AND derived_id = source_id)
    )
);
CREATE INDEX lineage_forward_idx  ON lineage_edges (derived_kind, derived_id);
CREATE INDEX lineage_backward_idx ON lineage_edges (source_kind, source_id);

-- =====================================================================
-- 10. Cost, evaluation and feedback          (§9, §15.5)
-- =====================================================================

-- Attributed to org / namespace / tenant / agent / run (§9). Partitioned for
-- retention alongside `events`.
CREATE TABLE usage_ledger (
    id                  uuid NOT NULL DEFAULT gen_random_uuid(),
    occurred_at         timestamptz NOT NULL DEFAULT now(),
    org_id              uuid NOT NULL,
    namespace_id        uuid NOT NULL,
    tenant_ref          text NOT NULL,
    agent_version_id    uuid,
    run_id              uuid,
    step_id             uuid,
    kind                text NOT NULL
                          CHECK (kind IN ('model_tokens','tool_call','speech_seconds',
                                          'storage_bytes','egress')),
    model_id            uuid,
    provider            text,
    input_tokens        bigint NOT NULL DEFAULT 0,
    output_tokens       bigint NOT NULL DEFAULT 0,
    cached_input_tokens bigint NOT NULL DEFAULT 0,
    quantity            numeric(20,6) NOT NULL DEFAULT 0,
    cost_micros         bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE TABLE usage_ledger_default PARTITION OF usage_ledger DEFAULT;
CREATE INDEX usage_tenant_idx ON usage_ledger
    (org_id, namespace_id, tenant_ref, occurred_at DESC);
CREATE INDEX usage_run_idx    ON usage_ledger (run_id);

CREATE TABLE eval_suites (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id  uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    ref           citext NOT NULL,
    description   text,
    -- §0.5: the mechanism this suite exists to justify. A compensating
    -- mechanism with no suite proving benefit is removed, not retained.
    mechanism_under_test text
        CHECK (mechanism_under_test IS NULL OR mechanism_under_test IN
              ('summarization','compaction','memory_tiers','planning_scaffold',
               'sub_agents','retrieval','eviction','skills','knowledge',
               'model_cache','peers','none')),
    -- The bar this suite must clear, on the SUITE rather than per run: a threshold
    -- supplied at call time can be lowered until it passes, and then measures nothing.
    min_score           numeric(6,4) NOT NULL DEFAULT 0.7
                          CHECK (min_score >= 0 AND min_score <= 1),
    -- §0.5: how much better the mechanism must make things to justify keeping it. Zero
    -- would mean any positive noise counts as benefit.
    min_mechanism_delta numeric(6,4) NOT NULL DEFAULT 0.05
                          CHECK (min_mechanism_delta >= 0 AND min_mechanism_delta <= 1),
    -- How many times each case runs. Defaults to 1 so a suite behaves as it always did;
    -- above 1, the spread across trials is what separates noise from a regression (§0.5).
    -- On the suite rather than per call: a value passed at call time can be tuned until
    -- the answer is the one you wanted.
    trials_per_case     integer NOT NULL DEFAULT 1
                          CHECK (trials_per_case BETWEEN 1 AND 20),
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, ref)
);

CREATE TABLE eval_cases (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    eval_suite_id  uuid NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
    name           text NOT NULL,
    input          jsonb NOT NULL,
    expectation    jsonb NOT NULL,
    weight         real NOT NULL DEFAULT 1,
    -- Named rather than inferred from the shape of `expectation`. `budget` grades latency
    -- and cost rather than text, which is what makes "did compaction make it cheaper" a
    -- measurable question instead of a story.
    grader         text NOT NULL DEFAULT 'contains'
                     CHECK (grader IN ('exact','contains','not_contains','regex',
                                       'json_path','budget','llm_judge')),
    -- Cases that only make sense with the mechanism ON would score zero in the OFF arm
    -- and manufacture a delta that proves nothing.
    ab_comparable  boolean NOT NULL DEFAULT true,
    UNIQUE (eval_suite_id, name)
);

CREATE TABLE eval_runs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    eval_suite_id     uuid NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
    agent_version_id  uuid NOT NULL REFERENCES agent_versions(id) ON DELETE CASCADE,
    -- The A/B that makes §0.5 measurable: same suite, mechanism on vs off.
    mechanism_enabled boolean,
    score             numeric(6,4),
    -- Standard error of `score` across trials. NULL for a single-trial run: one sample has
    -- no measurable spread, and storing 0 would claim precision rather than absence.
    score_stderr      numeric(6,4),
    passed            boolean,
    min_score         numeric(6,4),
    started_at        timestamptz NOT NULL DEFAULT now(),
    ended_at          timestamptz,

    -- The other arm of the A/B. Self-referential rather than a separate comparison
    -- table: the delta is a property of the pair, and a third row holding it could
    -- disagree with both.
    baseline_eval_run_id uuid REFERENCES eval_runs(id) ON DELETE SET NULL,
    -- The version actually executed. For the OFF arm this is a DIFFERENT,
    -- separately-admitted version -- one spec field flipped -- because a runtime override
    -- would be testing a configuration that could never be deployed.
    executed_version_id  uuid REFERENCES agent_versions(id) ON DELETE SET NULL,

    cases_total       integer NOT NULL DEFAULT 0,
    cases_passed      integer NOT NULL DEFAULT 0,
    cases_errored     integer NOT NULL DEFAULT 0,
    p50_latency_ms    integer,
    total_cost_micros bigint NOT NULL DEFAULT 0,

    -- Recorded, not recomputed at read time: the thresholds that produced it can change,
    -- and a historical decision must stay explainable under the rules actually applied.
    verdict           text CHECK (verdict IS NULL OR verdict IN
                        ('passed','failed','mechanism_justified',
                         'mechanism_not_justified','inconclusive')),
    CONSTRAINT eval_run_baseline_not_self_ck
        CHECK (baseline_eval_run_id IS DISTINCT FROM id)
);
CREATE INDEX eval_runs_suite_version_idx
    ON eval_runs (eval_suite_id, agent_version_id, started_at DESC);

-- §15.5's gate, per agent AND environment: staging should be promotable on a smoke suite
-- while production demands the full one, and a single gate per agent would force one of
-- those to be wrong.
CREATE TABLE promotion_gates (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    agent_id       uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    environment    environment NOT NULL,
    eval_suite_id  uuid NOT NULL REFERENCES eval_suites(id) ON DELETE RESTRICT,
    min_score      numeric(6,4) NOT NULL DEFAULT 0.7
                     CHECK (min_score >= 0 AND min_score <= 1),
    -- An escape hatch that is RECORDED. Without one, a gate gets bypassed by editing the
    -- table during an incident and nobody knows it happened; an override that must name a
    -- person and a reason is auditable (§16.4).
    allow_override boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent_id, environment)
);
CREATE INDEX promotion_gates_lookup_idx ON promotion_gates (agent_id, environment);

CREATE INDEX eval_runs_version_idx ON eval_runs (agent_version_id, started_at DESC);

ALTER TABLE deployments
    ADD CONSTRAINT deployments_eval_run_fk
    FOREIGN KEY (promotion_eval_run_id) REFERENCES eval_runs(id) ON DELETE SET NULL;

-- One row per TRIAL. Keying on (run, case) alone made a repeat an ON CONFLICT no-op, so
-- the extra trials would have been discarded and the variance computed from one sample.
CREATE TABLE eval_case_results (
    eval_run_id   uuid NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
    eval_case_id  uuid NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
    trial         smallint NOT NULL DEFAULT 1,
    run_id        uuid REFERENCES runs(id) ON DELETE SET NULL,
    score         numeric(6,4),
    passed        boolean NOT NULL,
    detail        jsonb,
    PRIMARY KEY (eval_run_id, eval_case_id, trial)
);

-- §15.5 production feedback closing the loop back onto the version.
CREATE TABLE feedback (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    tenant_ref        text NOT NULL,
    run_id            uuid REFERENCES runs(id) ON DELETE CASCADE,
    thread_id         uuid REFERENCES threads(id) ON DELETE CASCADE,
    interaction_id    uuid REFERENCES interactions(id) ON DELETE SET NULL,
    agent_version_id  uuid NOT NULL REFERENCES agent_versions(id) ON DELETE CASCADE,
    principal_id      uuid REFERENCES principals(id),
    rating            smallint CHECK (rating BETWEEN -1 AND 5),
    label             text,        -- 'task_success','human_correction','rejected'
    comment           text,
    correction        jsonb,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_version_idx ON feedback (agent_version_id, created_at DESC);

-- =====================================================================
-- 11. Audit                                  (§16.4)
--    Control-plane mutations and authorization decisions. Separate from
--    `events`, which is the execution system of record.
-- =====================================================================

CREATE TABLE audit_log (
    id             uuid NOT NULL DEFAULT gen_random_uuid(),
    occurred_at    timestamptz NOT NULL DEFAULT now(),
    org_id         uuid NOT NULL,
    namespace_id   uuid,
    tenant_ref     text,
    actor_principal_id uuid NOT NULL,
    on_behalf_of_principal_id uuid,
    action         text NOT NULL,          -- 'agent.promote','grant.revoke', ...
    resource_kind  text NOT NULL,
    resource_id    uuid,
    outcome        text NOT NULL CHECK (outcome IN ('allowed','denied','error')),
    reason         text,
    source_ip      inet,
    detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
CREATE INDEX audit_actor_idx    ON audit_log (actor_principal_id, occurred_at DESC);
CREATE INDEX audit_resource_idx ON audit_log (resource_kind, resource_id, occurred_at DESC);

-- =====================================================================
-- 11b. Skills and knowledge                  (§6.1 semantic, §17.5)
--    Two things that arrive together and are not the same thing.
--
--    A KNOWLEDGE COLLECTION is an authored corpus. Retrieval over it is
--    the same mechanism as semantic memory recall -- same Embedder, same
--    cosine distance -- but its LIFECYCLE is not: it is ingested from a
--    document, replaced when that document is re-ingested, deleted when
--    the document is deleted, and readable by every tenant in the
--    namespace. memory_records has none of those, which is why this is
--    not more rows there.
--
--    A SKILL is control-plane content: named, versioned, immutable
--    procedural instructions that may carry tools and collections. It is
--    versioned for the reason agent specs are -- a mutable skill would
--    change what a published agent does, and what it is allowed to do,
--    without a new spec hash or an admission decision (§17.5).
-- =====================================================================

CREATE TABLE knowledge_collections (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id  uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    name          citext NOT NULL,
    description   text,
    -- Recorded, not assumed. Vectors from two embedders are not comparable,
    -- so search refuses a mismatch instead of ranking nonsense.
    embedder_id   text NOT NULL,
    dimensions    integer NOT NULL,
    status        registry_status NOT NULL DEFAULT 'active',
    created_by    uuid REFERENCES principals(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    archived_at   timestamptz,
    UNIQUE (namespace_id, name),
    UNIQUE (id, namespace_id)                -- for composite FKs below
);

CREATE TABLE knowledge_documents (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id uuid NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    source_uri    text,
    title         text,
    -- Makes re-ingestion idempotent: the obvious way to keep a corpus fresh
    -- is a nightly job that re-pushes everything, and that must not re-embed
    -- an unchanged document every night.
    content_hash  text NOT NULL,
    body          text NOT NULL,             -- kept so a re-chunk needs no source
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    chunk_count   integer NOT NULL DEFAULT 0,
    indexed_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (collection_id, content_hash),
    UNIQUE (id, collection_id)
);

CREATE TABLE knowledge_chunks (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id   uuid NOT NULL,
    -- Denormalised for filtered search; the composite FK makes a chunk whose
    -- collection disagrees with its document's UNWRITABLE rather than merely
    -- wrong -- a knowledge base leaking across a boundary is the failure the
    -- namespace scoping exists to prevent.
    collection_id uuid NOT NULL,
    ord           integer NOT NULL,
    content       text NOT NULL,
    embedding     vector(768),
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (document_id, ord),
    FOREIGN KEY (document_id, collection_id)
        REFERENCES knowledge_documents(id, collection_id) ON DELETE CASCADE
);
CREATE INDEX knowledge_chunks_collection_idx ON knowledge_chunks (collection_id);
CREATE INDEX knowledge_chunks_vec_idx ON knowledge_chunks
    USING hnsw (embedding vector_cosine_ops);

CREATE TABLE skills (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id  uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    name          citext NOT NULL,
    description   text,
    created_by    uuid REFERENCES principals(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    archived_at   timestamptz,
    UNIQUE (namespace_id, name)
);

CREATE TABLE skill_versions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id      uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id  uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    version       integer NOT NULL,
    instructions  text,                      -- JSON-authored body; NULL when content_uri is set
    content_uri   text,                      -- uploaded body's object-store URI; NULL when instructions is set
    when_to_use   text,                      -- cheap enough to hold 12 in context
    spec_hash     text NOT NULL,
    status        registry_status NOT NULL DEFAULT 'active',
    published_by  uuid REFERENCES principals(id),
    published_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (skill_id, version),
    UNIQUE (id, namespace_id),
    CONSTRAINT skill_versions_content_source_chk CHECK ((instructions IS NOT NULL) <> (content_uri IS NOT NULL))
);
CREATE INDEX skill_versions_lookup_idx ON skill_versions (skill_id, status, version DESC);

-- `effects` is COPIED from the tool's declared contract at publish time, not
-- referenced: the contract a version was admitted against must not change
-- under it later, or retry and compensation rules stop matching what was
-- approved (§8.3).
CREATE TABLE skill_version_tools (
    skill_version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
    tool_id          uuid NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
    effects          effect_class[] NOT NULL,
    PRIMARY KEY (skill_version_id, tool_id)
);

CREATE TABLE skill_version_collections (
    skill_version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
    collection_id    uuid NOT NULL,
    namespace_id     uuid NOT NULL,
    PRIMARY KEY (skill_version_id, collection_id),
    FOREIGN KEY (collection_id, namespace_id)
        REFERENCES knowledge_collections(id, namespace_id) ON DELETE CASCADE
);

-- An agent pins skill VERSIONS. Publishing v4 never reaches back into an
-- agent admitted against v3; `ord` is stored because skill order is part of
-- the spec's meaning and a join returns whatever the planner felt like.
CREATE TABLE agent_version_skills (
    agent_version_id uuid NOT NULL,
    skill_version_id uuid NOT NULL,
    namespace_id     uuid NOT NULL,
    ord              integer NOT NULL,
    PRIMARY KEY (agent_version_id, skill_version_id),
    FOREIGN KEY (agent_version_id, namespace_id)
        REFERENCES agent_versions(id, namespace_id) ON DELETE CASCADE,
    FOREIGN KEY (skill_version_id, namespace_id)
        REFERENCES skill_versions(id, namespace_id) ON DELETE RESTRICT,
    UNIQUE (agent_version_id, ord)
);

-- Collections read directly, without a skill in between: a corpus attached
-- for background grounding is not a procedure, and forcing it to wear a
-- skill wrapper would make every "just give it the docs" case invent an
-- empty skill.
CREATE TABLE agent_version_collections (
    agent_version_id uuid NOT NULL,
    collection_id    uuid NOT NULL,
    namespace_id     uuid NOT NULL,
    PRIMARY KEY (agent_version_id, collection_id),
    FOREIGN KEY (agent_version_id, namespace_id)
        REFERENCES agent_versions(id, namespace_id) ON DELETE CASCADE,
    FOREIGN KEY (collection_id, namespace_id)
        REFERENCES knowledge_collections(id, namespace_id) ON DELETE RESTRICT
);

-- =====================================================================
-- 11c. A2A                                   (§13.4, §13.5, §13.6)
--    §13.4: "If a second event store appears for A2A, the design has
--    gone wrong." A2A concepts map onto primitives that already exist:
--      Task -> Run · contextId -> Thread · states -> run status ·
--      input-required -> waiting + Interaction · updates -> event log
--      projections · subscription -> SSE with Last-Event-ID ·
--      push -> the async webhook path.
--    So almost nothing below is state. What IS here is the minimum A2A
--    cannot derive: which peers exist, and the id another runtime
--    minted for a task of ours.
--
--    `peers` and `agent_version_peers` are defined in section 3 with the
--    other registries; the columns below extend them.
-- =====================================================================

CREATE TABLE peer_tasks (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    run_id             uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_id            uuid NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    peer_id            uuid NOT NULL REFERENCES peers(id) ON DELETE RESTRICT,
    binding            peer_binding NOT NULL,

    -- Exactly one. A local task IS a child run in this event log; a remote
    -- task is an opaque id in someone else's.
    child_run_id       uuid REFERENCES runs(id) ON DELETE CASCADE,
    remote_task_id     text,
    remote_context_id  text,

    -- The normalised state shared by BOTH bindings. Remote vocabularies are
    -- translated into this at the adapter; §13.4's conformance requirement is
    -- that the states are the same whichever binding served the call.
    state              text NOT NULL DEFAULT 'submitted'
        CHECK (state IN ('submitted','working','input_required','completed','failed','cancelled')),
    error              jsonb,
    last_observed_at   timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT peer_task_binding_ck CHECK (
        (binding = 'local'  AND child_run_id IS NOT NULL AND remote_task_id IS NULL)
     OR (binding = 'remote' AND remote_task_id IS NOT NULL AND child_run_id IS NULL)
    ),
    -- One dispatch per step. A retried step reuses its task: dispatching twice
    -- to a peer we cannot compensate is §8.3 in its least recoverable form.
    UNIQUE (step_id)
);
CREATE INDEX peer_tasks_run_idx ON peer_tasks (run_id);
CREATE INDEX peer_tasks_remote_idx ON peer_tasks (peer_id, remote_task_id)
    WHERE remote_task_id IS NOT NULL;

-- A2A push notifications are §12.1's async webhook transport under another
-- name, so this records a destination and the existing outbox delivers it.
CREATE TABLE a2a_push_configs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    run_id        uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    url           text NOT NULL,
    token_ref     text,          -- a REFERENCE, never the token (§16.3)
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id)
);

-- =====================================================================
-- 11d. Query-shape indexes                   (§9 migration 0009, plus later)
--    Added after measuring the console's and the ops surface's real queries.
--    Listed here because an index is part of the schema a reader needs: the
--    difference between an Index Scan and a Seq Scan on `steps` is the
--    difference between a trace view that loads and one that times out.
-- =====================================================================

CREATE INDEX runs_version_status_idx    ON runs (agent_version_id, status, created_at DESC);
CREATE INDEX runs_trace_lookup_idx      ON runs (trace_id) WHERE trace_id IS NOT NULL;
-- INCLUDE, not a composite key: the latency columns are payload for the trace
-- projection, never predicates, so they belong in the leaf and not the b-tree.
CREATE INDEX steps_kind_latency_idx     ON steps (run_id, kind) INCLUDE (latency_ms, status);
CREATE INDEX tool_invocations_health_idx ON tool_invocations (tool_id, status, created_at DESC);
CREATE INDEX feedback_version_created_idx ON feedback (agent_version_id, created_at DESC);
CREATE INDEX feedback_thread_idx        ON feedback (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX artifacts_run_idx          ON artifacts (produced_by_run_id)
    WHERE produced_by_run_id IS NOT NULL;
CREATE INDEX memory_agent_idx           ON memory_records (scope_agent_id, tier, created_at DESC)
    WHERE scope_agent_id IS NOT NULL;
CREATE INDEX memory_shared_idx          ON memory_records (org_id, namespace_id, tier)
    WHERE shared = true AND superseded_by IS NULL;
CREATE INDEX triggers_schedule_idx      ON triggers (trigger_type, enabled)
    WHERE trigger_type = 'schedule' AND enabled;
-- =====================================================================
-- 12. Row-level security                     (§5.2, §16.4)
--    Tenant columns are present from Phase 1. Enforcement on `runs` is now
--    live (migrations 0019-0020) via a second, non-owning connecting role
--    (`hpoc_app`) so the policy below is not silently bypassed by table
--    ownership -- the classic RLS gotcha. Migrations, seeding and the test
--    fixtures keep running as the owner (superuser locally), which always
--    bypasses RLS; api/worker/scheduler adopt it by pointing
--    APP_DATABASE_URL at hpoc_app (src/platform/config/env.schema.ts).
--    Extending this to sibling tenant-scoped tables is future work — see
--    src/platform/persistence/tenant-connection.ts for the session-pinning
--    mechanism this depends on, and its call sites (ContextMiddleware,
--    RunLoop) for what already sets app.org_id per request/run.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hpoc_app') THEN
    CREATE ROLE hpoc_app LOGIN PASSWORD 'hpoc_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE hpoc TO hpoc_app;
GRANT USAGE ON SCHEMA public TO hpoc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hpoc_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hpoc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hpoc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hpoc_app;

-- No FORCE: policies already apply to every role but the owner and a superuser, and
-- hpoc_app is neither. Compared as TEXT rather than cast to uuid: current_setting
-- returns '' (not NULL) once a session GUC has been touched and reset, and an
-- `AND`-guarded cast is not safe against that -- Postgres does not guarantee AND
-- evaluates its inputs left to right (manual §4.2.14). '' or NULL never equals a real
-- UUID's text form, in any evaluation order, so comparing as text needs no guard at all.
--
-- Applied to EVERY table carrying org_id (migration 0023), with three deliberate
-- exceptions: namespaces, principals and tenants. ContextMiddleware reads exactly those
-- to turn request headers into an identity, and it cannot pin a connection to an org it
-- has not resolved yet -- protecting them would make every request fail to authenticate.
-- They hold identity, not tenant content, which is what makes the trade sound.
--
-- Partitioned parents (events, audit_log, usage_ledger) are enabled at the parent, which
-- is what the application queries; a query aimed directly at a partition would use that
-- partition's own policies instead.

ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY runs_tenant_isolation ON runs
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE a2a_push_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY a2a_push_configs_tenant_isolation ON a2a_push_configs
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE admission_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY admission_decisions_tenant_isolation ON admission_decisions
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_versions_tenant_isolation ON agent_versions
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY agents_tenant_isolation ON agents
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY artifacts_tenant_isolation ON artifacts
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE backpressure_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY backpressure_policies_tenant_isolation ON backpressure_policies
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY budgets_tenant_isolation ON budgets
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE capability_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY capability_grants_tenant_isolation ON capability_grants
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE credential_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY credential_grants_tenant_isolation ON credential_grants
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE eval_suites ENABLE ROW LEVEL SECURITY;
CREATE POLICY eval_suites_tenant_isolation ON eval_suites
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_tenant_isolation ON events
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY feedback_tenant_isolation ON feedback
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY interactions_tenant_isolation ON interactions
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE knowledge_collections ENABLE ROW LEVEL SECURITY;
CREATE POLICY knowledge_collections_tenant_isolation ON knowledge_collections
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY knowledge_documents_tenant_isolation ON knowledge_documents
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE lineage_edges ENABLE ROW LEVEL SECURITY;
CREATE POLICY lineage_edges_tenant_isolation ON lineage_edges
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE mcp_servers ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_servers_tenant_isolation ON mcp_servers
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE memory_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_records_tenant_isolation ON memory_records
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE memory_sharing_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_sharing_policies_tenant_isolation ON memory_sharing_policies
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE models ENABLE ROW LEVEL SECURITY;
CREATE POLICY models_tenant_isolation ON models
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE peer_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY peer_tasks_tenant_isolation ON peer_tasks
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE peers ENABLE ROW LEVEL SECURITY;
CREATE POLICY peers_tenant_isolation ON peers
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY policies_tenant_isolation ON policies
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE promotion_gates ENABLE ROW LEVEL SECURITY;
CREATE POLICY promotion_gates_tenant_isolation ON promotion_gates
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE prompts ENABLE ROW LEVEL SECURITY;
CREATE POLICY prompts_tenant_isolation ON prompts
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE skill_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY skill_versions_tenant_isolation ON skill_versions
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY skills_tenant_isolation ON skills
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE speech_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY speech_providers_tenant_isolation ON speech_providers
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY steps_tenant_isolation ON steps
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY threads_tenant_isolation ON threads
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE tool_invocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tool_invocations_tenant_isolation ON tool_invocations
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE tools ENABLE ROW LEVEL SECURITY;
CREATE POLICY tools_tenant_isolation ON tools
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

ALTER TABLE usage_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_ledger_tenant_isolation ON usage_ledger
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.org_id', true)
  );

-- =====================================================================
-- Deliberately absent
--   * No cache tables. A cache hit and a cache miss must produce identical
--     replayable history, so caches never touch the event log (§10).
--   * No A2A task table, no MCP session table. Tasks map onto runs and
--     contextId onto threads; the protocol is stateless (§13.4, §20).
--   * No business-state tables. Agent-produced business data is an artifact
--     the consuming service commits to its own store (§3.1).
--   * No blobs. Large content is an artifact reference (§11.2, §20).
-- =====================================================================
