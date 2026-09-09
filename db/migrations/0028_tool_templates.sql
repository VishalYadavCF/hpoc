-- §18.5, revisited: an inline spec may now DEFINE a tool, not only select one.
--
-- The original rule -- "an inline spec selects from capability the caller already holds,
-- it never widens authority" -- was coherent and wrong for the workload §18.1 exists to
-- serve. ap-executor's ai-agent node lets a workflow author pick any piece and action in
-- the node, with no registration step. Under refs-only there was no path for that at all,
-- which made the ephemeral path unusable by the consumer it was designed for.
--
-- What changes is WHERE authority is granted, not how much. A grant used to name one tool
-- row, so a tool that did not exist could not be reachable. It now names a TEMPLATE: a
-- fixed origin, a path prefix, a method set, and -- decisively -- the effect contract.
--
-- The caller supplies the SHAPE. The template supplies the CONTRACT. That split is the
-- whole security argument: if a caller could declare its own effects, a payment tool
-- self-declared `read_only` would skip its approval gate AND be cached, and §4.5 and §8.3
-- would become advisory. Nothing below lets an instantiation touch effects, residency,
-- sandbox profile or origin.
--
-- For ap-executor this widens nothing in practice: every dynamic piece tool targets one
-- origin -- the executor's own API -- and the executor already enforces which pieces a
-- workflow's author may use. One template grant covers the catalogue.
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

-- A grant may now name a template. Everything else about grants is unchanged: still
-- per-namespace, still per-tenant-optional, still revocable, still checked at admission.
ALTER TABLE capability_grants DROP CONSTRAINT IF EXISTS capability_grants_resource_kind_check;
ALTER TABLE capability_grants ADD CONSTRAINT capability_grants_resource_kind_check
    CHECK (resource_kind IN ('tool','tool_template','model','mcp_server','peer',
                             'prompt','policy','memory_scope','skill','knowledge_collection'));

-- Which template produced this tool, and the hash of the shape it was produced from.
--
-- `template_id` is what makes an instantiated tool revocable as a class: revoking the
-- template's grant stops the next admission, and the column is how an operator finds
-- every row that came from it. NULL means a registered tool, which is every existing row.
--
-- `spec_hash` content-addresses the instantiation, so a consuming service issuing the
-- same node config ten thousand times gets ONE tool row and one cache key -- the same
-- reasoning as ephemeral agent versions in §18.1.
ALTER TABLE tools
    ADD COLUMN template_id uuid REFERENCES tool_templates(id) ON DELETE RESTRICT,
    ADD COLUMN spec_hash   text;

-- Not partial, deliberately. ON CONFLICT can only target a partial index by repeating its
-- predicate, which no query builder here emits -- and it does not need to be partial:
-- Postgres treats NULLs as distinct in a unique index, so every registered tool (spec_hash
-- NULL) coexists without collision.
CREATE UNIQUE INDEX tools_instantiated_hash_idx ON tools (org_id, spec_hash);

-- Arguments the platform binds and the MODEL NEVER SEES.
--
-- ai-agent's per-field modes: `agent` lets the model fill a field, `fixed` pins it at
-- authoring time, `leave_empty` omits it. `fixed` is the interesting one -- today a fixed
-- value would have to be described to the model and trusted to be echoed back. Binding it
-- here is both simpler and safer: it is merged into the arguments after the model has
-- answered, and stripped from the schema the model was shown, so it cannot be argued with.
ALTER TABLE agent_version_tools
    ADD COLUMN fixed_args jsonb NOT NULL DEFAULT '{}'::jsonb;
