-- migration: memory engine (§6)
--
-- Deferred out of Phase 1 deliberately: memory is Phase 2 in §0.6, and pgvector is the
-- only part of the schema that needs an extension beyond pgcrypto/citext.
--
-- The 768 dimension matches the default embedder. Changing embedding models is a
-- migration, not a config flip -- vectors from two models are not comparable, and a
-- column that silently accepted both would return nonsense rankings rather than an error.
-- The pgvector adapter asserts the embedder's dimension at boot for exactly that reason.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_records (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    namespace_id       uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
    tenant_ref         text NOT NULL,

    tier               memory_tier  NOT NULL,
    scope              memory_scope NOT NULL,
    -- Exactly one of these is populated, matching `scope`. A single polymorphic
    -- `scope_ref uuid` would have lost cascade delete: closing a thread must take its
    -- thread-scoped memory with it.
    scope_user_id      uuid REFERENCES principals(id) ON DELETE CASCADE,
    scope_agent_id     uuid REFERENCES agents(id) ON DELETE CASCADE,
    scope_thread_id    uuid REFERENCES threads(id) ON DELETE CASCADE,
    scope_run_id       uuid REFERENCES runs(id) ON DELETE CASCADE,

    content            text,
    structured         jsonb,
    artifact_id        uuid REFERENCES artifacts(id) ON DELETE SET NULL,

    -- §6.4. Provenance survives to retrieval time so "this claim is hearsay from peer X"
    -- stays answerable instead of being a policy hope.
    provenance         memory_provenance NOT NULL,
    source_run_id      uuid REFERENCES runs(id) ON DELETE SET NULL,
    source_step_id     uuid REFERENCES steps(id) ON DELETE SET NULL,
    source_peer_id     uuid REFERENCES peers(id) ON DELETE SET NULL,
    trusted            boolean NOT NULL DEFAULT false,

    -- §6.3. For conversational and episodic rows this records what the user actually
    -- RECEIVED, not what the model generated. Violating it corrupts episodic memory in a
    -- way that surfaces later as the agent referencing things never said aloud.
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

    CONSTRAINT memory_scope_ref_ck CHECK (
        CASE scope
          WHEN 'org'    THEN scope_user_id IS NULL AND scope_agent_id IS NULL
                         AND scope_thread_id IS NULL AND scope_run_id IS NULL
          WHEN 'tenant' THEN scope_user_id IS NULL AND scope_agent_id IS NULL
                         AND scope_thread_id IS NULL AND scope_run_id IS NULL
          WHEN 'user'   THEN scope_user_id   IS NOT NULL
          WHEN 'agent'  THEN scope_agent_id  IS NOT NULL
          WHEN 'thread' THEN scope_thread_id IS NOT NULL
          WHEN 'run'    THEN scope_run_id    IS NOT NULL
        END
    ),
    CONSTRAINT memory_body_ck CHECK (
        content IS NOT NULL OR structured IS NOT NULL OR artifact_id IS NOT NULL
    ),
    -- The external tier IS the offload path (§6.1); a row without an artifact is not
    -- offloaded, it is just a row claiming to be.
    CONSTRAINT memory_external_tier_ck CHECK (
        tier <> 'external' OR artifact_id IS NOT NULL
    )
);

CREATE INDEX memory_scope_idx ON memory_records (org_id, namespace_id, tenant_ref, scope, tier)
    WHERE superseded_by IS NULL;
CREATE INDEX memory_thread_idx ON memory_records (scope_thread_id, created_at)
    WHERE scope_thread_id IS NOT NULL;
CREATE INDEX memory_agent_idx ON memory_records (scope_agent_id, tier, created_at DESC)
    WHERE scope_agent_id IS NOT NULL;
CREATE INDEX memory_expiry_idx ON memory_records (expires_at) WHERE expires_at IS NOT NULL;

-- Keyed by model so a re-embed lands ALONGSIDE the old vector rather than replacing it
-- mid-migration -- otherwise a partial re-embed leaves the index half in each space.
CREATE TABLE memory_embeddings (
    memory_id      uuid NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
    model_id       text NOT NULL,
    dimensions     smallint NOT NULL,
    embedding      vector(768) NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (memory_id, model_id)
);

CREATE INDEX memory_embeddings_ann_idx ON memory_embeddings
    USING hnsw (embedding vector_cosine_ops);
