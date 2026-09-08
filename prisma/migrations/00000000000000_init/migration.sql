-- Extensions required by this datamodel.
-- See prisma/README.md for why they live here and not only in
-- db/postgres/init/00-extensions.sql.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "agent_lifetime" AS ENUM ('registered', 'ephemeral');

-- CreateEnum
CREATE TYPE "artifact_state" AS ENUM ('live', 'expiring', 'deleted');

-- CreateEnum
CREATE TYPE "data_class" AS ENUM ('internal', 'regulated');

-- CreateEnum
CREATE TYPE "durability_tier" AS ENUM ('strict', 'relaxed');

-- CreateEnum
CREATE TYPE "effect_class" AS ENUM ('read_only', 'idempotent', 'non_idempotent', 'transactional', 'compensatable', 'essential', 'human_approval_required', 'cacheable');

-- CreateEnum
CREATE TYPE "enforcement_level" AS ENUM ('org', 'namespace', 'tenant', 'agent', 'worker_pool', 'model', 'tool', 'mcp_server', 'peer', 'speech_provider');

-- CreateEnum
CREATE TYPE "environment" AS ENUM ('staging', 'production');

-- CreateEnum
CREATE TYPE "grant_source" AS ENUM ('service', 'user');

-- CreateEnum
CREATE TYPE "interaction_kind" AS ENUM ('approval', 'question', 'clarification', 'authentication', 'escalation');

-- CreateEnum
CREATE TYPE "interaction_status" AS ENUM ('pending', 'resolved', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "lineage_node_kind" AS ENUM ('run', 'step', 'tool_invocation', 'memory', 'artifact', 'interaction', 'peer_result', 'user_input', 'model_output');

-- CreateEnum
CREATE TYPE "mcp_transport" AS ENUM ('stdio', 'streamable_http');

-- CreateEnum
CREATE TYPE "memory_provenance" AS ENUM ('user_input', 'model_output', 'tool_output', 'peer_result', 'artifact', 'consolidated');

-- CreateEnum
CREATE TYPE "memory_scope" AS ENUM ('org', 'tenant', 'user', 'agent', 'thread', 'run');

-- CreateEnum
CREATE TYPE "memory_tier" AS ENUM ('working', 'conversational', 'semantic', 'episodic', 'procedural', 'external');

-- CreateEnum
CREATE TYPE "peer_binding" AS ENUM ('local', 'remote');

-- CreateEnum
CREATE TYPE "principal_kind" AS ENUM ('human', 'workload', 'service');

-- CreateEnum
CREATE TYPE "registry_status" AS ENUM ('active', 'deprecated', 'disabled');

-- CreateEnum
CREATE TYPE "residency" AS ENUM ('internal', 'external');

-- CreateEnum
CREATE TYPE "run_initiator" AS ENUM ('api', 'trigger', 'schedule', 'peer', 'sub_agent');

-- CreateEnum
CREATE TYPE "run_status" AS ENUM ('queued', 'running', 'tool_execution', 'checkpointed', 'waiting', 'completed', 'failed', 'cancelled', 'dead_letter');

-- CreateEnum
CREATE TYPE "saturation_policy" AS ENUM ('queue', 'throttle', 'shed');

-- CreateEnum
CREATE TYPE "speech_kind" AS ENUM ('stt', 'tts');

-- CreateEnum
CREATE TYPE "step_kind" AS ENUM ('model_call', 'tool_call', 'memory_op', 'delegation', 'interaction', 'context_op');

-- CreateEnum
CREATE TYPE "step_status" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'compensated');

-- CreateEnum
CREATE TYPE "tool_origin" AS ENUM ('native', 'http', 'function', 'mcp', 'peer');

-- CreateEnum
CREATE TYPE "transport" AS ENUM ('sse', 'webhook', 'poll', 'voice_webrtc', 'voice_telephony');

-- CreateEnum
CREATE TYPE "trigger_type" AS ENUM ('http', 'event', 'webhook', 'schedule', 'callback');

-- CreateTable
CREATE TABLE "admission_decisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "spec_hash" TEXT NOT NULL,
    "agent_version_id" UUID,
    "caller_principal_id" UUID NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "rejection_reasons" JSONB NOT NULL DEFAULT '[]',
    "checks" JSONB NOT NULL DEFAULT '{}',
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admission_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_version_mcp_servers" (
    "agent_version_id" UUID NOT NULL,
    "mcp_server_id" UUID NOT NULL,
    "allowed_tools" TEXT[],
    "allow_sampling" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "agent_version_mcp_servers_pkey" PRIMARY KEY ("agent_version_id","mcp_server_id")
);

-- CreateTable
CREATE TABLE "agent_version_peers" (
    "agent_version_id" UUID NOT NULL,
    "peer_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,

    CONSTRAINT "agent_version_peers_pkey" PRIMARY KEY ("agent_version_id","peer_id")
);

-- CreateTable
CREATE TABLE "agent_version_speech" (
    "agent_version_id" UUID NOT NULL,
    "speech_provider_id" UUID NOT NULL,
    "speech_kind" "speech_kind" NOT NULL,

    CONSTRAINT "agent_version_speech_pkey" PRIMARY KEY ("agent_version_id","speech_kind")
);

-- CreateTable
CREATE TABLE "agent_version_sub_agents" (
    "agent_version_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "sub_agent_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,

    CONSTRAINT "agent_version_sub_agents_pkey" PRIMARY KEY ("agent_version_id","sub_agent_id")
);

-- CreateTable
CREATE TABLE "agent_version_tools" (
    "agent_version_id" UUID NOT NULL,
    "tool_id" UUID NOT NULL,
    "effects" "effect_class"[],
    "cache_ttl_seconds" INTEGER,
    "cache_scope" TEXT,
    "idempotency_key_tpl" TEXT,
    "compensation_tool_id" UUID,

    CONSTRAINT "agent_version_tools_pkey" PRIMARY KEY ("agent_version_id","tool_id")
);

-- CreateTable
CREATE TABLE "agent_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID,
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "lifetime" "agent_lifetime" NOT NULL,
    "version" INTEGER,
    "spec" JSONB NOT NULL,
    "spec_hash" TEXT NOT NULL,
    "workload_identity_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "prompt_version_id" UUID,
    "policy_version_id" UUID,
    "durability" "durability_tier" NOT NULL DEFAULT 'strict',
    "transport" "transport" NOT NULL DEFAULT 'sse',
    "data_class" "data_class" NOT NULL DEFAULT 'internal',
    "tenant_isolation" TEXT NOT NULL DEFAULT 'strict',
    "max_steps" INTEGER,
    "max_tokens" BIGINT,
    "max_cost_micros" BIGINT,
    "step_timeout_ms" INTEGER NOT NULL DEFAULT 30000,
    "run_timeout_ms" INTEGER NOT NULL DEFAULT 1800000,
    "max_retries" SMALLINT NOT NULL DEFAULT 3,
    "max_concurrent_runs" INTEGER,
    "on_saturation" "saturation_policy" NOT NULL DEFAULT 'queue',
    "overridable_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "description" TEXT,
    "expose_as_peer" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "tenant_ref" TEXT NOT NULL,
    "thread_id" UUID,
    "produced_by_run_id" UUID,
    "produced_by_step_id" UUID,
    "content_hash" TEXT NOT NULL,
    "storage_uri" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "encryption_key_ref" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "parent_artifact_id" UUID,
    "retention_policy" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "state" "artifact_state" NOT NULL DEFAULT 'live',
    "deleted_at" TIMESTAMPTZ(6),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "org_id" UUID NOT NULL,
    "namespace_id" UUID,
    "tenant_ref" TEXT,
    "actor_principal_id" UUID NOT NULL,
    "on_behalf_of_principal_id" UUID,
    "action" TEXT NOT NULL,
    "resource_kind" TEXT NOT NULL,
    "resource_id" UUID,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "source_ip" INET,
    "detail" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");

-- CreateTable
CREATE TABLE "backpressure_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "level" "enforcement_level" NOT NULL,
    "scope_ref" TEXT NOT NULL,
    "max_concurrency" INTEGER,
    "max_rate_per_sec" DECIMAL(12,3),
    "queue_depth_limit" INTEGER,
    "on_saturation" "saturation_policy" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backpressure_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budgets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "level" "enforcement_level" NOT NULL,
    "scope_ref" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "limit_micros" BIGINT NOT NULL,
    "spent_micros" BIGINT NOT NULL DEFAULT 0,
    "period_started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resets_at" TIMESTAMPTZ(6),

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "grant_source" "grant_source" NOT NULL,
    "namespace_id" UUID,
    "grantee_principal_id" UUID,
    "resource_kind" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "tenant_ref" TEXT,
    "constraints" JSONB NOT NULL DEFAULT '{}',
    "granted_by" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "capability_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "step_seq" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "parent_checkpoint_id" UUID,
    "state" JSONB,
    "state_artifact_id" UUID,
    "state_hash" TEXT NOT NULL,
    "durability" "durability_tier" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "step_id" UUID,
    "workload_identity_id" UUID NOT NULL,
    "on_behalf_of_principal_id" UUID,
    "audience" TEXT NOT NULL,
    "scopes" TEXT[],
    "tenant_ref" TEXT,
    "token_id" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "credential_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dead_letters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "step_id" UUID,
    "reason" TEXT NOT NULL,
    "error" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL,
    "last_worker" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_by" UUID,
    "acknowledged_at" TIMESTAMPTZ(6),
    "replayed_run_id" UUID,

    CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "environment" "environment" NOT NULL,
    "agent_version_id" UUID NOT NULL,
    "canary_percent" SMALLINT NOT NULL DEFAULT 100,
    "shadow_from_version_id" UUID,
    "promotion_eval_run_id" UUID,
    "state" TEXT NOT NULL DEFAULT 'active',
    "promoted_by" UUID,
    "promoted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_case_results" (
    "eval_run_id" UUID NOT NULL,
    "eval_case_id" UUID NOT NULL,
    "run_id" UUID,
    "score" DECIMAL(6,4),
    "passed" BOOLEAN NOT NULL,
    "detail" JSONB,

    CONSTRAINT "eval_case_results_pkey" PRIMARY KEY ("eval_run_id","eval_case_id")
);

-- CreateTable
CREATE TABLE "eval_cases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "eval_suite_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "expectation" JSONB NOT NULL,
    "weight" REAL NOT NULL DEFAULT 1,

    CONSTRAINT "eval_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "eval_suite_id" UUID NOT NULL,
    "agent_version_id" UUID NOT NULL,
    "mechanism_enabled" BOOLEAN,
    "score" DECIMAL(6,4),
    "passed" BOOLEAN,
    "min_score" DECIMAL(6,4),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_suites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "ref" CITEXT NOT NULL,
    "description" TEXT,
    "mechanism_under_test" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_suites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_schema_versions" (
    "event_type" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "json_schema" JSONB NOT NULL,
    "upcaster_ref" TEXT,
    "introduced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(6),

    CONSTRAINT "event_schema_versions_pkey" PRIMARY KEY ("event_type","schema_version")
);

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "schema_version" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "thread_id" UUID NOT NULL,
    "parent_run_id" UUID,
    "step_id" UUID,
    "agent_version_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "tenant_ref" TEXT NOT NULL,
    "trace_id" TEXT,
    "span_id" TEXT,
    "causation_id" TEXT,
    "correlation_id" TEXT,
    "principal_id" UUID,
    "delegation_chain" JSONB NOT NULL DEFAULT '[]',
    "protocol_metadata" JSONB NOT NULL DEFAULT '{}',
    "payload" JSONB NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("run_id","seq","occurred_at")
) PARTITION BY RANGE ("occurred_at");

-- CreateTable
CREATE TABLE "feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "tenant_ref" TEXT NOT NULL,
    "run_id" UUID,
    "thread_id" UUID,
    "interaction_id" UUID,
    "agent_version_id" UUID NOT NULL,
    "principal_id" UUID,
    "rating" SMALLINT,
    "label" TEXT,
    "comment" TEXT,
    "correction" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "step_id" UUID,
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "tenant_ref" TEXT NOT NULL,
    "kind" "interaction_kind" NOT NULL,
    "status" "interaction_status" NOT NULL DEFAULT 'pending',
    "prompt" JSONB NOT NULL,
    "response_schema" JSONB,
    "originating_run_id" UUID,
    "originating_principal_id" UUID,
    "delegation_chain" JSONB NOT NULL DEFAULT '[]',
    "required_authorization" JSONB NOT NULL DEFAULT '{}',
    "responder_principal_id" UUID,
    "response" JSONB,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lineage_edges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "tenant_ref" TEXT NOT NULL,
    "derived_kind" "lineage_node_kind" NOT NULL,
    "derived_id" UUID NOT NULL,
    "source_kind" "lineage_node_kind" NOT NULL,
    "source_id" UUID NOT NULL,
    "relation" TEXT NOT NULL,
    "run_id" UUID,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lineage_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_server_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mcp_server_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "tenant_ref" TEXT,
    "approved_by" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "mcp_server_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_server_tools" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mcp_server_id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "definition_hash" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "superseded_at" TIMESTAMPTZ(6),

    CONSTRAINT "mcp_server_tools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_servers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "mcp_transport" "mcp_transport" NOT NULL,
    "endpoint_url" TEXT,
    "command" TEXT[],
    "protocol_revision" TEXT NOT NULL,
    "residency" "residency" NOT NULL,
    "allow_sampling" BOOLEAN NOT NULL DEFAULT false,
    "rate_limit_qps" INTEGER,
    "status" "registry_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_embeddings" (
    "memory_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "dimensions" SMALLINT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_embeddings_pkey" PRIMARY KEY ("memory_id","model_id")
);

-- CreateTable
CREATE TABLE "memory_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "tenant_ref" TEXT NOT NULL,
    "tier" "memory_tier" NOT NULL,
    "scope" "memory_scope" NOT NULL,
    "scope_user_id" UUID,
    "scope_agent_id" UUID,
    "scope_thread_id" UUID,
    "scope_run_id" UUID,
    "content" TEXT,
    "structured" JSONB,
    "artifact_id" UUID,
    "provenance" "memory_provenance" NOT NULL,
    "source_run_id" UUID,
    "source_step_id" UUID,
    "source_peer_id" UUID,
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "delivered" BOOLEAN,
    "played_offset_ms" INTEGER,
    "salience" REAL NOT NULL DEFAULT 0,
    "access_count" INTEGER NOT NULL DEFAULT 0,
    "last_accessed_at" TIMESTAMPTZ(6),
    "consolidated_from" UUID[] DEFAULT ARRAY[]::UUID[],
    "superseded_by" UUID,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "models" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "ref" CITEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_model_id" TEXT NOT NULL,
    "residency" "residency" NOT NULL,
    "region" TEXT,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "context_window_tokens" INTEGER,
    "max_output_tokens" INTEGER,
    "input_cost_micros_per_1k" BIGINT,
    "output_cost_micros_per_1k" BIGINT,
    "fallback_model_id" UUID,
    "status" "registry_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "namespaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "slug" CITEXT NOT NULL,
    "owning_team" TEXT NOT NULL,
    "owner_contact" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "namespaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orgs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orgs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "step_id" UUID,
    "tool_invocation_id" UUID,
    "destination" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" JSONB,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "peers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "binding" "peer_binding" NOT NULL,
    "local_agent_id" UUID,
    "endpoint_url" TEXT,
    "protocol_version" TEXT NOT NULL,
    "residency" "residency" NOT NULL,
    "agent_card" JSONB,
    "card_signature" TEXT,
    "card_verified_at" TIMESTAMPTZ(6),
    "status" "registry_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "peers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "ref" CITEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "policy_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "principals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "kind" "principal_kind" NOT NULL,
    "subject" TEXT NOT NULL,
    "display_name" TEXT,
    "disabled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "principals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "prompt_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "ref" CITEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_queue" (
    "run_id" UUID NOT NULL,
    "worker_pool" TEXT NOT NULL DEFAULT 'default',
    "priority" SMALLINT NOT NULL DEFAULT 100,
    "visible_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6),
    "heartbeat_at" TIMESTAMPTZ(6),
    "enqueued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_queue_pkey" PRIMARY KEY ("run_id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "thread_id" UUID NOT NULL,
    "agent_version_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "tenant_ref" TEXT NOT NULL,
    "tenant_id" UUID,
    "status" "run_status" NOT NULL DEFAULT 'queued',
    "durability" "durability_tier" NOT NULL,
    "initiator" "run_initiator" NOT NULL,
    "trigger_id" UUID,
    "parent_run_id" UUID,
    "root_run_id" UUID,
    "delegation_depth" SMALLINT NOT NULL DEFAULT 0,
    "delegation_chain" JSONB NOT NULL DEFAULT '[]',
    "caller_principal_id" UUID NOT NULL,
    "on_behalf_of_principal_id" UUID,
    "authorizing_human_id" UUID,
    "idempotency_key" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "input" JSONB,
    "input_artifact_id" UUID,
    "output" JSONB,
    "output_artifact_id" UUID,
    "error" JSONB,
    "trace_id" TEXT,
    "correlation_id" TEXT,
    "causation_id" TEXT,
    "last_event_seq" BIGINT NOT NULL DEFAULT 0,
    "last_checkpoint_id" UUID,
    "forked_from_checkpoint_id" UUID,
    "max_cost_micros" BIGINT,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "step_count" INTEGER NOT NULL DEFAULT 0,
    "deadline_at" TIMESTAMPTZ(6),
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "speech_providers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "speech_kind" "speech_kind" NOT NULL,
    "residency" "residency" NOT NULL,
    "region" TEXT,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cost_tier" TEXT,
    "max_concurrent_sessions" INTEGER,
    "status" "registry_status" NOT NULL DEFAULT 'active',

    CONSTRAINT "speech_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "parent_step_id" UUID,
    "kind" "step_kind" NOT NULL,
    "status" "step_status" NOT NULL DEFAULT 'pending',
    "attempt" SMALLINT NOT NULL DEFAULT 1,
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "tenant_ref" TEXT NOT NULL,
    "model_id" UUID,
    "fallback_from_model_id" UUID,
    "prompt_version_id" UUID,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cached_input_tokens" INTEGER,
    "cost_micros" BIGINT,
    "input" JSONB,
    "input_artifact_id" UUID,
    "output" JSONB,
    "output_artifact_id" UUID,
    "error" JSONB,
    "checkpoint_id" UUID,
    "trace_id" TEXT,
    "span_id" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "tenant_ref" TEXT NOT NULL,
    "display_name" TEXT,
    "data_class" "data_class" NOT NULL DEFAULT 'internal',
    "residency_region" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "threads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "tenant_ref" TEXT NOT NULL,
    "tenant_id" UUID,
    "agent_id" UUID,
    "user_principal_id" UUID,
    "external_ref" TEXT,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_invocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "step_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "tenant_ref" TEXT NOT NULL,
    "tool_id" UUID NOT NULL,
    "origin" "tool_origin" NOT NULL,
    "effects" "effect_class"[],
    "definition_hash" TEXT,
    "tool_version" INTEGER NOT NULL,
    "idempotency_key" TEXT,
    "attempt" SMALLINT NOT NULL DEFAULT 1,
    "authorized_principal_id" UUID,
    "capability_decision" JSONB NOT NULL DEFAULT '{}',
    "credential_grant_id" UUID,
    "interaction_id" UUID,
    "sandbox_profile" TEXT NOT NULL,
    "sandbox_instance_id" TEXT,
    "request" JSONB,
    "request_artifact_id" UUID,
    "response" JSONB,
    "response_artifact_id" UUID,
    "error" JSONB,
    "status" "step_status" NOT NULL DEFAULT 'pending',
    "compensates_invocation_id" UUID,
    "protocol_metadata" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tools" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "ref" CITEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "origin" "tool_origin" NOT NULL,
    "residency" "residency" NOT NULL,
    "description" TEXT,
    "input_schema" JSONB NOT NULL,
    "output_schema" JSONB,
    "default_effects" "effect_class"[],
    "timeout_ms" INTEGER NOT NULL DEFAULT 30000,
    "max_retries" SMALLINT NOT NULL DEFAULT 0,
    "sandbox_profile" TEXT NOT NULL,
    "endpoint_url" TEXT,
    "mcp_server_id" UUID,
    "mcp_tool_name" TEXT,
    "definition_hash" TEXT,
    "status" "registry_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "triggers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "pinned_version_id" UUID,
    "trigger_type" "trigger_type" NOT NULL,
    "event_source" TEXT,
    "event_type" TEXT,
    "webhook_path" TEXT,
    "cron_expression" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_ledger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "org_id" UUID NOT NULL,
    "namespace_id" UUID NOT NULL,
    "tenant_ref" TEXT NOT NULL,
    "agent_version_id" UUID,
    "run_id" UUID,
    "step_id" UUID,
    "kind" TEXT NOT NULL,
    "model_id" UUID,
    "provider" TEXT,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cached_input_tokens" BIGINT NOT NULL DEFAULT 0,
    "quantity" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "usage_ledger_pkey" PRIMARY KEY ("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");

-- CreateIndex
CREATE INDEX "admission_spec_hash_idx" ON "admission_decisions"("caller_principal_id", "spec_hash", "decided_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_agent_id_version_key" ON "agent_versions"("agent_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_id_namespace_id_key" ON "agent_versions"("id", "namespace_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_org_id_spec_hash_key" ON "agent_versions"("org_id", "spec_hash");

-- CreateIndex
CREATE UNIQUE INDEX "agents_id_namespace_id_key" ON "agents"("id", "namespace_id");

-- CreateIndex
CREATE UNIQUE INDEX "agents_namespace_id_name_key" ON "agents"("namespace_id", "name");

-- CreateIndex
CREATE INDEX "artifacts_gc_idx" ON "artifacts"("expires_at") WHERE ((state = 'live'::artifact_state) AND (legal_hold = false) AND (expires_at IS NOT NULL));

-- CreateIndex
CREATE INDEX "artifacts_thread_idx" ON "artifacts"("thread_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_org_id_content_hash_key" ON "artifacts"("org_id", "content_hash");

-- CreateIndex
CREATE INDEX "audit_actor_idx" ON "audit_log"("actor_principal_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_resource_idx" ON "audit_log"("resource_kind", "resource_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "backpressure_policies_org_id_level_scope_ref_key" ON "backpressure_policies"("org_id", "level", "scope_ref");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_org_id_level_scope_ref_period_key" ON "budgets"("org_id", "level", "scope_ref", "period");

-- CreateIndex
CREATE INDEX "capability_grants_lookup_idx" ON "capability_grants"("org_id", "resource_kind", "resource_id") WHERE (revoked_at IS NULL);

-- CreateIndex
CREATE INDEX "checkpoints_run_idx" ON "checkpoints"("run_id", "step_seq" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "checkpoints_run_id_step_seq_created_at_key" ON "checkpoints"("run_id", "step_seq", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "credential_grants_token_id_key" ON "credential_grants"("token_id");

-- CreateIndex
CREATE INDEX "dead_letters_open_idx" ON "dead_letters"("created_at" DESC) WHERE (acknowledged_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "deployments_active_uq" ON "deployments"("agent_id", "environment") WHERE (state = 'active'::text);

-- CreateIndex
CREATE UNIQUE INDEX "eval_cases_eval_suite_id_name_key" ON "eval_cases"("eval_suite_id", "name");

-- CreateIndex
CREATE INDEX "eval_runs_version_idx" ON "eval_runs"("agent_version_id", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "eval_suites_org_id_ref_key" ON "eval_suites"("org_id", "ref");

-- CreateIndex
CREATE INDEX "events_causation_idx" ON "events"("causation_id") WHERE (causation_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "events_run_seq_idx" ON "events"("run_id", "seq");

-- CreateIndex
CREATE INDEX "events_tenant_idx" ON "events"("org_id", "namespace_id", "tenant_ref", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "events_trace_idx" ON "events"("trace_id") WHERE (trace_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "events_type_idx" ON "events"("event_type", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "feedback_version_idx" ON "feedback"("agent_version_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "interactions_pending_idx" ON "interactions"("expires_at") WHERE (status = 'pending'::interaction_status);

-- CreateIndex
CREATE INDEX "interactions_run_idx" ON "interactions"("run_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "lineage_backward_idx" ON "lineage_edges"("source_kind", "source_id");

-- CreateIndex
CREATE INDEX "lineage_forward_idx" ON "lineage_edges"("derived_kind", "derived_id");

-- CreateIndex
CREATE UNIQUE INDEX "lineage_edges_derived_kind_derived_id_source_kind_source_id_key" ON "lineage_edges"("derived_kind", "derived_id", "source_kind", "source_id", "relation");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_server_approvals_mcp_server_id_namespace_id_tenant_ref_key" ON "mcp_server_approvals"("mcp_server_id", "namespace_id", "tenant_ref");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_server_tools_mcp_server_id_tool_name_definition_hash_key" ON "mcp_server_tools"("mcp_server_id", "tool_name", "definition_hash");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_servers_org_id_name_key" ON "mcp_servers"("org_id", "name");

-- CreateIndex
-- memory_embeddings_ann_idx is created as hnsw at the end of this file.

-- CreateIndex
CREATE INDEX "memory_expiry_idx" ON "memory_records"("expires_at") WHERE (expires_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "memory_scope_idx" ON "memory_records"("org_id", "namespace_id", "tenant_ref", "scope", "tier") WHERE (superseded_by IS NULL);

-- CreateIndex
CREATE INDEX "memory_thread_idx" ON "memory_records"("scope_thread_id", "created_at") WHERE (scope_thread_id IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "models_org_id_ref_key" ON "models"("org_id", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "namespaces_id_org_id_key" ON "namespaces"("id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "namespaces_org_id_slug_key" ON "namespaces"("org_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "orgs_slug_key" ON "orgs"("slug");

-- CreateIndex
CREATE INDEX "outbox_pending_idx" ON "outbox"("next_attempt_at") WHERE (status = 'pending'::text);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_destination_idempotency_key_key" ON "outbox"("destination", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "peers_org_id_name_key" ON "peers"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "policies_org_id_ref_key" ON "policies"("org_id", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "policy_versions_policy_id_version_key" ON "policy_versions"("policy_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "principals_org_id_kind_subject_key" ON "principals"("org_id", "kind", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_prompt_id_content_hash_key" ON "prompt_versions"("prompt_id", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_versions_prompt_id_version_key" ON "prompt_versions"("prompt_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "prompts_org_id_ref_key" ON "prompts"("org_id", "ref");

-- CreateIndex
CREATE INDEX "run_queue_claimable_idx" ON "run_queue"("worker_pool", "priority", "visible_at") WHERE (lease_owner IS NULL);

-- CreateIndex
CREATE INDEX "run_queue_expired_lease_idx" ON "run_queue"("lease_expires_at") WHERE (lease_owner IS NOT NULL);

-- CreateIndex
CREATE INDEX "runs_active_idx" ON "runs"("status", "deadline_at") WHERE (status = ANY (ARRAY['queued'::run_status, 'running'::run_status, 'tool_execution'::run_status, 'waiting'::run_status, 'checkpointed'::run_status]));

-- CreateIndex
CREATE INDEX "runs_parent_idx" ON "runs"("parent_run_id") WHERE (parent_run_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "runs_tenant_idx" ON "runs"("org_id", "namespace_id", "tenant_ref", "created_at" DESC);

-- CreateIndex
CREATE INDEX "runs_thread_idx" ON "runs"("thread_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "runs_trace_idx" ON "runs"("trace_id") WHERE (trace_id IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "runs_idempotency_uq" ON "runs"("namespace_id", "tenant_ref", "idempotency_key") WHERE (idempotency_key IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "speech_providers_org_id_name_speech_kind_key" ON "speech_providers"("org_id", "name", "speech_kind");

-- CreateIndex
CREATE INDEX "steps_run_idx" ON "steps"("run_id", "seq");

-- CreateIndex
CREATE INDEX "steps_status_idx" ON "steps"("status") WHERE (status = ANY (ARRAY['pending'::step_status, 'running'::step_status]));

-- CreateIndex
CREATE UNIQUE INDEX "steps_run_id_seq_key" ON "steps"("run_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_namespace_id_tenant_ref_key" ON "tenants"("namespace_id", "tenant_ref");

-- CreateIndex
CREATE INDEX "threads_tenant_idx" ON "threads"("org_id", "namespace_id", "tenant_ref", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "threads_namespace_id_external_ref_key" ON "threads"("namespace_id", "external_ref");

-- CreateIndex
CREATE INDEX "tool_invocations_run_idx" ON "tool_invocations"("run_id", "created_at");

-- CreateIndex
CREATE INDEX "tool_invocations_tool_idx" ON "tool_invocations"("tool_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tool_invocations_idempotency_uq" ON "tool_invocations"("tool_id", "idempotency_key") WHERE (idempotency_key IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "tools_org_id_ref_version_key" ON "tools"("org_id", "ref", "version");

-- CreateIndex
CREATE UNIQUE INDEX "triggers_webhook_path_uq" ON "triggers"("webhook_path") WHERE (webhook_path IS NOT NULL);

-- CreateIndex
CREATE INDEX "triggers_event_idx" ON "triggers"("event_source", "event_type") WHERE (enabled AND (trigger_type = 'event'::trigger_type));

-- CreateIndex
CREATE INDEX "usage_run_idx" ON "usage_ledger"("run_id");

-- CreateIndex
CREATE INDEX "usage_tenant_idx" ON "usage_ledger"("org_id", "namespace_id", "tenant_ref", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "admission_decisions" ADD CONSTRAINT "admission_decisions_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "admission_decisions" ADD CONSTRAINT "admission_decisions_caller_principal_id_fkey" FOREIGN KEY ("caller_principal_id") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "admission_decisions" ADD CONSTRAINT "admission_decisions_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "admission_decisions" ADD CONSTRAINT "admission_decisions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_version_mcp_servers" ADD CONSTRAINT "agent_version_mcp_servers_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_version_mcp_servers" ADD CONSTRAINT "agent_version_mcp_servers_mcp_server_id_fkey" FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_servers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_version_peers" ADD CONSTRAINT "agent_version_peers_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_version_peers" ADD CONSTRAINT "agent_version_peers_peer_id_fkey" FOREIGN KEY ("peer_id") REFERENCES "peers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_version_speech" ADD CONSTRAINT "agent_version_speech_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_version_speech" ADD CONSTRAINT "agent_version_speech_speech_provider_id_fkey" FOREIGN KEY ("speech_provider_id") REFERENCES "speech_providers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_version_sub_agents" ADD CONSTRAINT "agent_version_sub_agents_agent_version_id_namespace_id_fkey" FOREIGN KEY ("agent_version_id", "namespace_id") REFERENCES "agent_versions"("id", "namespace_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_version_sub_agents" ADD CONSTRAINT "agent_version_sub_agents_sub_agent_id_namespace_id_fkey" FOREIGN KEY ("sub_agent_id", "namespace_id") REFERENCES "agents"("id", "namespace_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_version_tools" ADD CONSTRAINT "agent_version_tools_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_version_tools" ADD CONSTRAINT "agent_version_tools_compensation_tool_id_fkey" FOREIGN KEY ("compensation_tool_id") REFERENCES "tools"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_version_tools" ADD CONSTRAINT "agent_version_tools_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "policy_versions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_prompt_version_id_fkey" FOREIGN KEY ("prompt_version_id") REFERENCES "prompt_versions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_workload_identity_id_fkey" FOREIGN KEY ("workload_identity_id") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_parent_artifact_id_fkey" FOREIGN KEY ("parent_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_produced_by_run_id_fkey" FOREIGN KEY ("produced_by_run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_produced_by_step_id_fkey" FOREIGN KEY ("produced_by_step_id") REFERENCES "steps"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "backpressure_policies" ADD CONSTRAINT "backpressure_policies_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_grantee_principal_id_fkey" FOREIGN KEY ("grantee_principal_id") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_parent_checkpoint_id_fkey" FOREIGN KEY ("parent_checkpoint_id") REFERENCES "checkpoints"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_state_artifact_fk" FOREIGN KEY ("state_artifact_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "credential_grants" ADD CONSTRAINT "credential_grants_on_behalf_of_principal_id_fkey" FOREIGN KEY ("on_behalf_of_principal_id") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "credential_grants" ADD CONSTRAINT "credential_grants_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "credential_grants" ADD CONSTRAINT "credential_grants_run_fk" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "credential_grants" ADD CONSTRAINT "credential_grants_workload_identity_id_fkey" FOREIGN KEY ("workload_identity_id") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_replayed_run_id_fkey" FOREIGN KEY ("replayed_run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "steps"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_eval_run_fk" FOREIGN KEY ("promotion_eval_run_id") REFERENCES "eval_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_promoted_by_fkey" FOREIGN KEY ("promoted_by") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_shadow_from_version_id_fkey" FOREIGN KEY ("shadow_from_version_id") REFERENCES "agent_versions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "eval_case_results" ADD CONSTRAINT "eval_case_results_eval_case_id_fkey" FOREIGN KEY ("eval_case_id") REFERENCES "eval_cases"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "eval_case_results" ADD CONSTRAINT "eval_case_results_eval_run_id_fkey" FOREIGN KEY ("eval_run_id") REFERENCES "eval_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "eval_case_results" ADD CONSTRAINT "eval_case_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_eval_suite_id_fkey" FOREIGN KEY ("eval_suite_id") REFERENCES "eval_suites"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_eval_suite_id_fkey" FOREIGN KEY ("eval_suite_id") REFERENCES "eval_suites"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "eval_suites" ADD CONSTRAINT "eval_suites_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "eval_suites" ADD CONSTRAINT "eval_suites_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_originating_principal_id_fkey" FOREIGN KEY ("originating_principal_id") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_originating_run_id_fkey" FOREIGN KEY ("originating_run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_responder_principal_id_fkey" FOREIGN KEY ("responder_principal_id") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "steps"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lineage_edges" ADD CONSTRAINT "lineage_edges_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lineage_edges" ADD CONSTRAINT "lineage_edges_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mcp_server_approvals" ADD CONSTRAINT "mcp_server_approvals_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mcp_server_approvals" ADD CONSTRAINT "mcp_server_approvals_mcp_server_id_fkey" FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mcp_server_approvals" ADD CONSTRAINT "mcp_server_approvals_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mcp_server_tools" ADD CONSTRAINT "mcp_server_tools_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mcp_server_tools" ADD CONSTRAINT "mcp_server_tools_mcp_server_id_fkey" FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memory_records"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_scope_agent_id_fkey" FOREIGN KEY ("scope_agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_scope_run_id_fkey" FOREIGN KEY ("scope_run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_scope_thread_id_fkey" FOREIGN KEY ("scope_thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_scope_user_id_fkey" FOREIGN KEY ("scope_user_id") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_source_peer_id_fkey" FOREIGN KEY ("source_peer_id") REFERENCES "peers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_source_run_id_fkey" FOREIGN KEY ("source_run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_source_step_id_fkey" FOREIGN KEY ("source_step_id") REFERENCES "steps"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "memory_records"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "models" ADD CONSTRAINT "models_fallback_model_id_fkey" FOREIGN KEY ("fallback_model_id") REFERENCES "models"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "models" ADD CONSTRAINT "models_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "namespaces" ADD CONSTRAINT "namespaces_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "steps"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tool_invocation_id_fkey" FOREIGN KEY ("tool_invocation_id") REFERENCES "tool_invocations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "peers" ADD CONSTRAINT "peers_local_agent_fk" FOREIGN KEY ("local_agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "peers" ADD CONSTRAINT "peers_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "peers" ADD CONSTRAINT "peers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "principals" ADD CONSTRAINT "principals_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "run_queue" ADD CONSTRAINT "run_queue_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_version_id_fkey" FOREIGN KEY ("agent_version_id") REFERENCES "agent_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_authorizing_human_id_fkey" FOREIGN KEY ("authorizing_human_id") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_caller_principal_id_fkey" FOREIGN KEY ("caller_principal_id") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_forked_from_fk" FOREIGN KEY ("forked_from_checkpoint_id") REFERENCES "checkpoints"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_input_artifact_fk" FOREIGN KEY ("input_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_last_checkpoint_fk" FOREIGN KEY ("last_checkpoint_id") REFERENCES "checkpoints"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_on_behalf_of_principal_id_fkey" FOREIGN KEY ("on_behalf_of_principal_id") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_output_artifact_fk" FOREIGN KEY ("output_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_fkey" FOREIGN KEY ("parent_run_id") REFERENCES "runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_root_run_id_fkey" FOREIGN KEY ("root_run_id") REFERENCES "runs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "triggers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "speech_providers" ADD CONSTRAINT "speech_providers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "steps" ADD CONSTRAINT "steps_checkpoint_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "checkpoints"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "steps" ADD CONSTRAINT "steps_fallback_from_model_id_fkey" FOREIGN KEY ("fallback_from_model_id") REFERENCES "models"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "steps" ADD CONSTRAINT "steps_input_artifact_fk" FOREIGN KEY ("input_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "steps" ADD CONSTRAINT "steps_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "steps" ADD CONSTRAINT "steps_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "steps" ADD CONSTRAINT "steps_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "steps" ADD CONSTRAINT "steps_output_artifact_fk" FOREIGN KEY ("output_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "steps" ADD CONSTRAINT "steps_parent_step_id_fkey" FOREIGN KEY ("parent_step_id") REFERENCES "steps"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "steps" ADD CONSTRAINT "steps_prompt_version_id_fkey" FOREIGN KEY ("prompt_version_id") REFERENCES "prompt_versions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "steps" ADD CONSTRAINT "steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_user_principal_id_fkey" FOREIGN KEY ("user_principal_id") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_inv_request_artifact_fk" FOREIGN KEY ("request_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_inv_response_artifact_fk" FOREIGN KEY ("response_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_authorized_principal_id_fkey" FOREIGN KEY ("authorized_principal_id") REFERENCES "principals"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_compensates_invocation_id_fkey" FOREIGN KEY ("compensates_invocation_id") REFERENCES "tool_invocations"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_credential_grant_id_fkey" FOREIGN KEY ("credential_grant_id") REFERENCES "credential_grants"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_interaction_fk" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "steps"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tools" ADD CONSTRAINT "tools_mcp_server_id_fkey" FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_servers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tools" ADD CONSTRAINT "tools_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tools" ADD CONSTRAINT "tools_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_pinned_version_id_fkey" FOREIGN KEY ("pinned_version_id") REFERENCES "agent_versions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;


-- BEGIN hand-maintained -----------------------------------------------
-- Everything below is outside what the Prisma datamodel can express, and
-- is reapplied by prisma/patch-baseline.mjs when this baseline is
-- regenerated. Editing schema.prisma does not update any of it.

-- Default partitions. Monthly partitions are created by the retention job;
-- DEFAULT catches anything landing outside a declared range rather than
-- failing the insert.
CREATE TABLE "events_default" PARTITION OF "events" DEFAULT;
CREATE TABLE "usage_ledger_default" PARTITION OF "usage_ledger" DEFAULT;
CREATE TABLE "audit_log_default" PARTITION OF "audit_log" DEFAULT;

-- ANN index for pgvector. vector_cosine_ops matches the cosine distance
-- operator (<=>); a query written with a different operator will not use it.
CREATE INDEX "memory_embeddings_ann_idx"
    ON "memory_embeddings" USING hnsw ("embedding" vector_cosine_ops);

-- 36 CHECK constraints.
ALTER TABLE "agent_version_mcp_servers" ADD CONSTRAINT "mcp_allowlist_non_empty_ck" CHECK ((cardinality(allowed_tools) > 0));
ALTER TABLE "agent_version_tools" ADD CONSTRAINT "cacheable_is_read_only_ck" CHECK (((NOT ('cacheable'::effect_class = ANY (effects))) OR ('read_only'::effect_class = ANY (effects))));
ALTER TABLE "agent_version_tools" ADD CONSTRAINT "cacheable_needs_ttl_ck" CHECK (((NOT ('cacheable'::effect_class = ANY (effects))) OR (cache_ttl_seconds IS NOT NULL)));
ALTER TABLE "agent_version_tools" ADD CONSTRAINT "compensatable_needs_inverse_ck" CHECK (((NOT ('compensatable'::effect_class = ANY (effects))) OR (compensation_tool_id IS NOT NULL)));
ALTER TABLE "agent_version_tools" ADD CONSTRAINT "effect_exclusivity_ck" CHECK ((NOT (('read_only'::effect_class = ANY (effects)) AND ('non_idempotent'::effect_class = ANY (effects)))));
ALTER TABLE "agent_version_tools" ADD CONSTRAINT "idempotent_needs_key_ck" CHECK (((NOT ('idempotent'::effect_class = ANY (effects))) OR (idempotency_key_tpl IS NOT NULL)));
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_version_lifetime_ck" CHECK ((((lifetime = 'registered'::agent_lifetime) AND (agent_id IS NOT NULL) AND (version IS NOT NULL)) OR ((lifetime = 'ephemeral'::agent_lifetime) AND (agent_id IS NULL) AND (version IS NULL))));
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_size_bytes_check" CHECK ((size_bytes >= 0));
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_outcome_check" CHECK ((outcome = ANY (ARRAY['allowed'::text, 'denied'::text, 'error'::text])));
ALTER TABLE "backpressure_policies" ADD CONSTRAINT "queue_needs_bound_ck" CHECK (((on_saturation <> 'queue'::saturation_policy) OR (queue_depth_limit IS NOT NULL)));
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_period_check" CHECK ((period = ANY (ARRAY['hour'::text, 'day'::text, 'month'::text, 'total'::text])));
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_resource_kind_check" CHECK ((resource_kind = ANY (ARRAY['tool'::text, 'model'::text, 'mcp_server'::text, 'peer'::text, 'prompt'::text, 'policy'::text, 'memory_scope'::text])));
ALTER TABLE "capability_grants" ADD CONSTRAINT "grant_subject_ck" CHECK ((((grant_source = 'service'::grant_source) AND (namespace_id IS NOT NULL)) OR ((grant_source = 'user'::grant_source) AND (grantee_principal_id IS NOT NULL))));
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoint_body_ck" CHECK (((state IS NOT NULL) <> (state_artifact_id IS NOT NULL)));
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_canary_percent_check" CHECK (((canary_percent >= 0) AND (canary_percent <= 100)));
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_state_check" CHECK ((state = ANY (ARRAY['active'::text, 'rolling'::text, 'rolled_back'::text, 'retired'::text])));
ALTER TABLE "eval_suites" ADD CONSTRAINT "eval_suites_mechanism_under_test_check" CHECK (((mechanism_under_test IS NULL) OR (mechanism_under_test = ANY (ARRAY['summarization'::text, 'compaction'::text, 'memory_tiers'::text, 'planning_scaffold'::text, 'sub_agents'::text, 'retrieval'::text, 'none'::text]))));
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_rating_check" CHECK (((rating >= '-1'::integer) AND (rating <= 5)));
ALTER TABLE "interactions" ADD CONSTRAINT "interaction_resolution_ck" CHECK (((status <> 'resolved'::interaction_status) OR ((responder_principal_id IS NOT NULL) AND (resolved_at IS NOT NULL))));
ALTER TABLE "lineage_edges" ADD CONSTRAINT "lineage_no_self_ck" CHECK ((NOT ((derived_kind = source_kind) AND (derived_id = source_id))));
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_server_endpoint_ck" CHECK ((((mcp_transport = 'streamable_http'::mcp_transport) AND (endpoint_url IS NOT NULL)) OR ((mcp_transport = 'stdio'::mcp_transport) AND (command IS NOT NULL))));
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_body_ck" CHECK (((content IS NOT NULL) OR (structured IS NOT NULL) OR (artifact_id IS NOT NULL)));
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_external_tier_ck" CHECK (((tier <> 'external'::memory_tier) OR (artifact_id IS NOT NULL)));
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_scope_ref_ck" CHECK (
CASE scope
    WHEN 'org'::memory_scope THEN ((scope_user_id IS NULL) AND (scope_agent_id IS NULL) AND (scope_thread_id IS NULL) AND (scope_run_id IS NULL))
    WHEN 'tenant'::memory_scope THEN ((scope_user_id IS NULL) AND (scope_agent_id IS NULL) AND (scope_thread_id IS NULL) AND (scope_run_id IS NULL))
    WHEN 'user'::memory_scope THEN (scope_user_id IS NOT NULL)
    WHEN 'agent'::memory_scope THEN (scope_agent_id IS NOT NULL)
    WHEN 'thread'::memory_scope THEN (scope_thread_id IS NOT NULL)
    WHEN 'run'::memory_scope THEN (scope_run_id IS NOT NULL)
    ELSE NULL::boolean
END);
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'abandoned'::text])));
ALTER TABLE "peers" ADD CONSTRAINT "peer_binding_ck" CHECK ((((binding = 'local'::peer_binding) AND (local_agent_id IS NOT NULL)) OR ((binding = 'remote'::peer_binding) AND (endpoint_url IS NOT NULL) AND (agent_card IS NOT NULL))));
ALTER TABLE "run_queue" ADD CONSTRAINT "lease_pair_ck" CHECK ((((lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL))));
ALTER TABLE "runs" ADD CONSTRAINT "run_depth_ck" CHECK (((delegation_depth >= 0) AND (delegation_depth <= 16)));
ALTER TABLE "runs" ADD CONSTRAINT "run_no_self_ck" CHECK ((parent_run_id IS DISTINCT FROM id));
ALTER TABLE "runs" ADD CONSTRAINT "run_root_ck" CHECK ((((parent_run_id IS NULL) AND (delegation_depth = 0)) OR ((parent_run_id IS NOT NULL) AND (root_run_id IS NOT NULL) AND (delegation_depth > 0))));
ALTER TABLE "runs" ADD CONSTRAINT "run_terminal_ck" CHECK (((status <> ALL (ARRAY['completed'::run_status, 'failed'::run_status, 'cancelled'::run_status, 'dead_letter'::run_status])) OR (ended_at IS NOT NULL)));
ALTER TABLE "threads" ADD CONSTRAINT "threads_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])));
ALTER TABLE "tools" ADD CONSTRAINT "tool_http_ck" CHECK (((origin <> 'http'::tool_origin) OR (endpoint_url IS NOT NULL)));
ALTER TABLE "tools" ADD CONSTRAINT "tool_mcp_ck" CHECK (((origin <> 'mcp'::tool_origin) OR ((mcp_server_id IS NOT NULL) AND (mcp_tool_name IS NOT NULL) AND (definition_hash IS NOT NULL))));
ALTER TABLE "triggers" ADD CONSTRAINT "trigger_shape_ck" CHECK ((((trigger_type = 'event'::trigger_type) AND (event_source IS NOT NULL) AND (event_type IS NOT NULL)) OR ((trigger_type = 'webhook'::trigger_type) AND (webhook_path IS NOT NULL)) OR ((trigger_type = 'schedule'::trigger_type) AND (cron_expression IS NOT NULL)) OR (trigger_type = ANY (ARRAY['http'::trigger_type, 'callback'::trigger_type]))));
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_kind_check" CHECK ((kind = ANY (ARRAY['model_tokens'::text, 'tool_call'::text, 'speech_seconds'::text, 'storage_bytes'::text, 'egress'::text])));

-- END hand-maintained -------------------------------------------------
