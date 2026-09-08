-- migration: skills registry (§17.2-adjacent) and knowledge collections (§6.1 semantic tier)
--
-- These arrived as one request ("skills and knowledge base -- or is it the same as vector
-- search?") but they are two different things, and the honest answer is encoded here:
--
--   RETRIEVAL is the same mechanism. A knowledge chunk and a semantic memory record are
--   both embedded with the same Embedder and searched by cosine distance. There is one
--   embedding contract in this system, not two.
--
--   LIFECYCLE is not the same, which is why this is not just more rows in memory_records.
--   A memory record is LEARNED: it is written by a run, decays, is superseded, carries
--   salience and access counts, and belongs to one tenant. A knowledge chunk is AUTHORED:
--   it is ingested from a document, replaced wholesale when that document is re-ingested,
--   deleted when the document is deleted, and shared by every tenant in the namespace.
--   Overloading memory_records would have meant a `superseded_by` that never fires, a
--   `salience` nobody sets, and no way to answer "which document did this come from" --
--   which is the first question anyone asks of a knowledge base.
--
-- Skills are neither. A skill is CONTROL-PLANE CONTENT: named, versioned, immutable
-- procedural instructions that may carry tool bindings and knowledge collections. It is
-- registry material like an agent version, and it goes through admission for the reason
-- below.

-- §16.2. A skill that carries tools WIDENS capability, so it must be grantable, and a
-- collection is readable data, so it must be grantable too. Without these two values a
-- skill would be a capability-laundering path: "I hold no grant for payments.refund, but
-- I can attach the skill that calls it."
ALTER TABLE capability_grants DROP CONSTRAINT capability_grants_resource_kind_check;
ALTER TABLE capability_grants ADD CONSTRAINT capability_grants_resource_kind_check
    CHECK (resource_kind IN ('tool','model','mcp_server','peer','prompt','policy',
                             'memory_scope','skill','knowledge_collection'));

-- ---------------------------------------------------------------------------
-- Knowledge
-- ---------------------------------------------------------------------------

-- A named, authored corpus. Namespace-scoped for the same reason agents are: the
-- ownership boundary is the protocol boundary, and reaching another team's corpus goes
-- over an explicit share, not a lucky name collision.
CREATE TABLE knowledge_collections (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id  uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    name          citext NOT NULL,
    description   text,

    -- Recorded, not assumed. Vectors from two embedders are not comparable, so a
    -- collection states which one produced its chunks and search refuses a mismatch
    -- rather than returning a confidently wrong ranking.
    embedder_id   text NOT NULL,
    dimensions    integer NOT NULL,

    status        registry_status NOT NULL DEFAULT 'active',
    created_by    uuid REFERENCES principals(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    archived_at   timestamptz,

    UNIQUE (namespace_id, name),
    -- Lets a composite FK pin cross-namespace attachment out of existence structurally,
    -- the same trick agent_versions uses for sub-agents (§13.3).
    UNIQUE (id, namespace_id)
);

-- One ingested source. `content_hash` makes re-ingestion idempotent: pushing the same
-- bytes twice is a no-op rather than a duplicated corpus, which matters because the
-- obvious way to keep a KB fresh is a nightly job that re-pushes everything.
CREATE TABLE knowledge_documents (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_id uuid NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    source_uri    text,
    title         text,
    content_hash  text NOT NULL,
    -- Kept so a re-chunk (different chunk size, different overlap) does not require the
    -- caller to still have the source. A corpus that cannot be rebuilt is a corpus that
    -- is stuck with whichever chunking parameters it was born with.
    body          text NOT NULL,
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    chunk_count   integer NOT NULL DEFAULT 0,
    indexed_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),

    UNIQUE (collection_id, content_hash),
    -- Lets knowledge_chunks reference (document, collection) as a pair, so a chunk's
    -- collection cannot drift away from its document's.
    UNIQUE (id, collection_id)
);

CREATE TABLE knowledge_chunks (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id   uuid NOT NULL,
    -- Denormalised from the document so search filters by collection without a join.
    -- The FK below is COMPOSITE, so the denormalised value cannot drift: a chunk whose
    -- collection_id disagrees with its document's is not merely wrong, it is unwritable.
    -- Without that, a bad update would leak one collection's text into another's results
    -- with nothing to notice -- and a knowledge base leaking across a boundary is exactly
    -- the failure the namespace scoping above exists to prevent.
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
-- Same index type and ops class as memory_embeddings: one embedding contract means one
-- distance metric, and mixing cosine here with L2 there would make scores incomparable
-- across the two retrieval paths a single agent uses in the same step. hnsw rather than
-- ivfflat for the same reason as there -- ivfflat's lists are built from whatever rows
-- exist at CREATE INDEX time, and a corpus is empty when its migration runs.
CREATE INDEX knowledge_chunks_vec_idx ON knowledge_chunks
    USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Skills
-- ---------------------------------------------------------------------------

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

-- Immutable once published, exactly like an agent version.
--
-- The alternative -- a mutable `skills.instructions` column -- lets someone change what a
-- published agent does without republishing that agent. If the skill also carries tools,
-- that is capability widening with no admission check and no new spec hash, and the run
-- that misbehaves afterwards is attributed to an agent version whose recorded spec never
-- changed. Version pinning is what keeps §17.5 meaningful once skills exist.
CREATE TABLE skill_versions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id      uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id  uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    version       integer NOT NULL,

    -- The procedural content. Passed to the adapter, never auto-prepended to a prompt by
    -- the platform: §0.5 makes every compensating mechanism measurable, and a platform
    -- that silently injects text makes "did the skill help" unanswerable.
    instructions  text NOT NULL,
    -- One line telling the model WHEN this applies. Separate from `instructions` because
    -- selection and execution have different budgets: an agent holding twelve skills can
    -- afford twelve hints in context but not twelve full bodies.
    when_to_use   text,

    spec_hash     text NOT NULL,
    status        registry_status NOT NULL DEFAULT 'active',
    published_by  uuid REFERENCES principals(id),
    published_at  timestamptz NOT NULL DEFAULT now(),

    UNIQUE (skill_id, version),
    UNIQUE (id, namespace_id)
);

CREATE INDEX skill_versions_lookup_idx ON skill_versions (skill_id, status, version DESC);

-- Tools a skill brings with it. `effects` is copied from the tool's declared contract at
-- publish time rather than referenced, for the same reason agent_version_tools copies it:
-- the contract a version was admitted against must not change under it later.
CREATE TABLE skill_version_tools (
    skill_version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
    tool_id          uuid NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
    effects          effect_class[] NOT NULL,
    PRIMARY KEY (skill_version_id, tool_id)
);

-- Collections a skill reads from. Composite FK on (collection_id, namespace_id) so a
-- skill physically cannot cite another namespace's corpus -- checked by the database
-- rather than by a service method someone can forget to call.
CREATE TABLE skill_version_collections (
    skill_version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
    collection_id    uuid NOT NULL,
    namespace_id     uuid NOT NULL,
    PRIMARY KEY (skill_version_id, collection_id),
    FOREIGN KEY (collection_id, namespace_id)
        REFERENCES knowledge_collections(id, namespace_id) ON DELETE CASCADE
);

-- Which skill VERSIONS an agent version is pinned to. `ord` is stored because skill order
-- is part of the spec's meaning; deriving it from a join returns whatever the planner
-- felt like, which is how the sub-agent ordering bug happened.
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

-- Collections an agent version reads directly, without a skill in between. A KB attached
-- for background grounding is not a procedure, and forcing it to wear a skill wrapper
-- would make every "just give it the docs" case invent an empty skill.
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
