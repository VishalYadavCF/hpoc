-- migration: extend row-level security to every org-scoped table (§5.2, §16.4)
--
-- 0020 enabled RLS on `runs` alone. Everything beside it -- the steps that hold model
-- inputs and tool arguments, the events that hold both again, memory, artifacts, lineage,
-- the whole registry -- was still protected only by the WHERE clauses application code
-- remembers to write. That is the gap this closes: `runs` was the proof of concept, and a
-- tenancy boundary that covers one table out of thirty-four is not a boundary.
--
-- The line drawn here is "carries org_id". Three org-scoped tables are deliberately
-- EXCLUDED, and the reason is a bootstrap cycle rather than an oversight:
--
--   namespaces, principals, tenants
--
-- ContextMiddleware reads exactly those three to turn request headers into an identity,
-- and it cannot pin a connection to an org it has not yet resolved. Protecting them would
-- make every request fail to authenticate. They hold identity, not tenant content, so the
-- trade is sound -- but it IS a trade, and it is why it is written down here.
--
-- The policy is the same shape as 0020's, for the same reasons documented there:
-- `app.bypass_rls` for the platform-internal sweeps that must see across every tenant by
-- design, and a TEXT comparison rather than a uuid cast, because `current_setting` returns
-- '' once a session has reset the GUC and Postgres does not guarantee an AND short-
-- circuits before the cast (manual §4.2.14).
--
-- Partitioned parents (events, audit_log, usage_ledger) are enabled at the parent, which
-- is what the application queries. A query aimed directly at a partition uses that
-- partition's own policies -- nothing here does that, but it is worth knowing before
-- someone writes the first one.

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
