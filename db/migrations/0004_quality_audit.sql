-- migration: lineage, usage ledger, evals, feedback, audit log
-- generated from db/schema.sql; that file stays the readable whole-schema reference.


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
               'sub_agents','retrieval','none')),
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
    UNIQUE (eval_suite_id, name)
);

CREATE TABLE eval_runs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    eval_suite_id     uuid NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
    agent_version_id  uuid NOT NULL REFERENCES agent_versions(id) ON DELETE CASCADE,
    -- The A/B that makes §0.5 measurable: same suite, mechanism on vs off.
    mechanism_enabled boolean,
    score             numeric(6,4),
    passed            boolean,
    min_score         numeric(6,4),
    started_at        timestamptz NOT NULL DEFAULT now(),
    ended_at          timestamptz
);
CREATE INDEX eval_runs_version_idx ON eval_runs (agent_version_id, started_at DESC);

ALTER TABLE deployments
    ADD CONSTRAINT deployments_eval_run_fk
    FOREIGN KEY (promotion_eval_run_id) REFERENCES eval_runs(id) ON DELETE SET NULL;

CREATE TABLE eval_case_results (
    eval_run_id   uuid NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
    eval_case_id  uuid NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
    run_id        uuid REFERENCES runs(id) ON DELETE SET NULL,
    score         numeric(6,4),
    passed        boolean NOT NULL,
    detail        jsonb,
    PRIMARY KEY (eval_run_id, eval_case_id)
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
