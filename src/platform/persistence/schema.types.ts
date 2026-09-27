import type { ColumnType, Generated } from 'kysely';

/**
 * Typed surface over db/schema.sql for the tables Phase 1 touches.
 *
 * Hand-authored rather than generated so the build does not require a live database.
 * `npm run db:types` regenerates it from a migrated database; CI diffs the two, so
 * drift between this file and the schema fails the build rather than surfacing at runtime.
 */

// Kysely's Generated<> does not compose with ColumnType<>, so defaulted columns get
// their own alias rather than being wrapped. Insert types are what differ: a defaulted
// column may be omitted, a required one may not.
type Ts = ColumnType<Date, Date | string, Date | string>;
type TsD = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string, string>;
type JsonD = ColumnType<unknown, string | undefined, string>;

export type RunStatus =
  | 'queued' | 'running' | 'tool_execution' | 'checkpointed'
  | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'dead_letter';
export type StepKind = 'model_call' | 'tool_call' | 'memory_op' | 'delegation' | 'peer_call' | 'interaction' | 'context_op';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'compensated';
export type EffectClass =
  | 'read_only' | 'idempotent' | 'non_idempotent' | 'transactional'
  | 'compensatable' | 'essential' | 'human_approval_required' | 'cacheable';
export type ToolOrigin = 'native' | 'http' | 'function' | 'mcp' | 'peer';
export type DurabilityTier = 'strict' | 'relaxed';
export type AgentLifetime = 'registered' | 'ephemeral';
export type RunInitiator = 'api' | 'trigger' | 'schedule' | 'peer' | 'sub_agent' | 'shadow';
export type PrincipalKind = 'human' | 'workload' | 'service';
export type InteractionKind = 'approval' | 'question' | 'clarification' | 'authentication' | 'escalation';
export type InteractionStatus = 'pending' | 'resolved' | 'expired' | 'cancelled';
export type Residency = 'internal' | 'external';
export type RegistryStatus = 'active' | 'deprecated' | 'disabled';
export type DataClass = 'internal' | 'regulated';

export interface OrgsTable { id: Generated<string>; slug: string; name: string; created_at: TsD; updated_at: TsD }
export interface NamespacesTable {
  id: Generated<string>; org_id: string; slug: string; owning_team: string;
  owner_contact: string; created_at: TsD; updated_at: TsD;
}
export interface TenantsTable {
  id: Generated<string>; org_id: string; namespace_id: string; tenant_ref: string;
  display_name: string | null; data_class: Generated<DataClass>; residency_region: string | null; created_at: TsD;
}
export interface PrincipalsTable {
  id: Generated<string>; org_id: string; kind: PrincipalKind; subject: string;
  display_name: string | null; disabled_at: Ts | null; created_at: TsD;
}
export interface ModelsTable {
  id: Generated<string>; org_id: string; ref: string; provider: string; provider_model_id: string;
  residency: Residency; region: string | null; capabilities: JsonD;
  context_window_tokens: number | null; max_output_tokens: number | null;
  input_cost_micros_per_1k: string | null; output_cost_micros_per_1k: string | null;
  fallback_model_id: string | null; status: Generated<string>; created_at: TsD;
  base_url: string | null; credential_ref: string | null;
}
export interface AgentsTable {
  id: Generated<string>; org_id: string; namespace_id: string; name: string; owner: string;
  description: string | null; expose_as_peer: Generated<boolean>; archived_at: Ts | null;
  created_at: TsD; updated_at: TsD;
}
export interface AgentVersionsTable {
  id: Generated<string>; agent_id: string | null; org_id: string; namespace_id: string;
  lifetime: AgentLifetime; version: number | null; spec: Json; spec_hash: string;
  workload_identity_id: string; model_id: string; prompt_version_id: string | null;
  policy_version_id: string | null; durability: Generated<DurabilityTier>;
  transport: Generated<string>; data_class: Generated<DataClass>; tenant_isolation: Generated<string>;
  max_steps: number | null; max_tokens: string | null; max_cost_micros: string | null;
  step_timeout_ms: Generated<number>; run_timeout_ms: Generated<number>; max_retries: Generated<number>;
  max_concurrent_runs: number | null; on_saturation: Generated<string>;
  overridable_fields: Generated<string[]>; created_by: string | null; created_at: TsD;
}
export interface ToolTemplatesTable {
  id: Generated<string>; org_id: string; namespace_id: string;
  ref: string; version: Generated<number>; description: string | null;
  /** The CONTRACT. Inherited by every instantiation; not expressible in a spec. */
  default_effects: EffectClass[]; residency: Residency; sandbox_profile: string;
  timeout_ms: Generated<number>; max_retries: Generated<number>;
  /** The reachable surface. A spec supplies only a path below `path_prefix`. */
  endpoint_url: string; allowed_methods: Generated<string[]>; path_prefix: string;
  static_headers: JsonD;
  /** A third-party credential by NAME; the broker sends it instead of its own token. */
  credential_ref: string | null;
  max_instances: Generated<number>;
  status: Generated<RegistryStatus>; created_at: TsD;
}

export interface ToolsTable {
  id: Generated<string>; org_id: string; namespace_id: string; ref: string; version: Generated<number>;
  origin: ToolOrigin; residency: Residency; description: string | null; input_schema: Json;
  output_schema: Json | null; default_effects: EffectClass[]; timeout_ms: Generated<number>;
  max_retries: Generated<number>; sandbox_profile: string; endpoint_url: string | null;
  mcp_server_id: string | null; mcp_tool_name: string | null; definition_hash: string | null;
  /** Set when INSTANTIATED from a tool_template by an inline spec; NULL when registered. */
  template_id: string | null;
  /** Content-addresses the instantiated shape, so identical specs collapse to one row. */
  spec_hash: string | null;
  status: Generated<string>; created_at: TsD;
  http_method: Generated<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>;
  path_template: string | null;
  /** Nests the model's arguments under this key in the body; NULL leaves them flat. */
  arg_wrapper_key: string | null;
  arg_placement: 'query' | 'body' | 'none' | null;
  static_headers: JsonD;
  /** Copied from the template on instantiation; NULL means the broker's platform token. */
  credential_ref: string | null;
  code_runtime: 'node' | 'python' | null;
  code_source: string | null;
}
export interface AgentVersionToolsTable {
  agent_version_id: string; tool_id: string; effects: EffectClass[];
  cache_ttl_seconds: number | null; cache_scope: string | null; idempotency_key_tpl: string | null;
  compensation_tool_id: string | null;
  /** Bound by the platform after the model answers, and hidden from its schema. */
  fixed_args: JsonD;
}
export interface ThreadsTable {
  id: Generated<string>; org_id: string; namespace_id: string; tenant_ref: string;
  tenant_id: string | null; agent_id: string | null; user_principal_id: string | null;
  external_ref: string | null; title: string | null; status: Generated<string>;
  metadata: JsonD; created_at: TsD; updated_at: TsD; archived_at: Ts | null;
}
export interface RunsTable {
  id: Generated<string>; thread_id: string; agent_version_id: string; org_id: string;
  namespace_id: string; tenant_ref: string; tenant_id: string | null;
  status: Generated<RunStatus>; durability: DurabilityTier; initiator: RunInitiator;
  trigger_id: string | null; shadow_of_run_id: string | null;
  parent_run_id: string | null; root_run_id: string | null; delegation_depth: Generated<number>;
  delegation_chain: JsonD; caller_principal_id: string;
  on_behalf_of_principal_id: string | null; authorizing_human_id: string | null;
  idempotency_key: string | null; attempt: Generated<number>;
  input: Json | null; input_artifact_id: string | null; output: Json | null;
  output_artifact_id: string | null; error: Json | null;
  trace_id: string | null; correlation_id: string | null; causation_id: string | null;
  last_event_seq: Generated<string>; last_checkpoint_id: string | null;
  forked_from_checkpoint_id: string | null;
  max_cost_micros: string | null; cost_micros: Generated<string>;
  input_tokens: Generated<string>; output_tokens: Generated<string>; step_count: Generated<number>;
  delivery: Json | null;
  deadline_at: Ts | null; queued_at: TsD; started_at: Ts | null; ended_at: Ts | null;
  created_at: TsD; updated_at: TsD;
}
export interface TraceExportCursorTable {
  id: Generated<boolean>; exported_through: Ts; updated_at: TsD;
}
export interface RunQueueTable {
  run_id: string; worker_pool: Generated<string>; priority: Generated<number>;
  visible_at: TsD; attempts: Generated<number>; lease_owner: string | null;
  lease_epoch: Generated<string>; lease_expires_at: Ts | null; heartbeat_at: Ts | null;
  enqueued_at: TsD;
}
export interface StepsTable {
  id: Generated<string>; run_id: string; seq: number; parent_step_id: string | null;
  /** NULL means the run's own version; set when an in-process sub-agent did the work. */
  agent_version_id: string | null;
  kind: StepKind; status: Generated<StepStatus>; attempt: Generated<number>;
  org_id: string; namespace_id: string; tenant_ref: string;
  model_id: string | null; fallback_from_model_id: string | null; prompt_version_id: string | null;
  input_tokens: number | null; output_tokens: number | null; cached_input_tokens: number | null;
  cost_micros: string | null;
  input: Json | null; input_artifact_id: string | null; output: Json | null;
  output_artifact_id: string | null; error: Json | null;
  checkpoint_id: string | null; trace_id: string | null; span_id: string | null;
  started_at: Ts | null; ended_at: Ts | null; latency_ms: number | null; created_at: TsD;
}
export interface ToolInvocationsTable {
  id: Generated<string>; step_id: string; run_id: string; thread_id: string; org_id: string;
  namespace_id: string; tenant_ref: string; tool_id: string; origin: ToolOrigin;
  effects: EffectClass[]; definition_hash: string | null; tool_version: number;
  idempotency_key: string | null; attempt: Generated<number>;
  authorized_principal_id: string | null; capability_decision: JsonD;
  credential_grant_id: string | null; interaction_id: string | null;
  sandbox_profile: string; sandbox_instance_id: string | null;
  request: Json | null; request_artifact_id: string | null; response: Json | null;
  response_artifact_id: string | null; error: Json | null; status: Generated<StepStatus>;
  compensates_invocation_id: string | null; protocol_metadata: JsonD;
  started_at: Ts | null; ended_at: Ts | null; latency_ms: number | null; created_at: TsD;
}
export interface CheckpointsTable {
  id: Generated<string>; run_id: string; step_seq: number; schema_version: number;
  parent_checkpoint_id: string | null; state: Json | null; state_artifact_id: string | null;
  state_hash: string; durability: DurabilityTier; created_at: TsD;
}
/**
 * LangGraph's checkpoint store. Distinct from `CheckpointsTable`, which holds OUR
 * resume state -- see migration 0026 for why the two models are not merged.
 *
 * `checkpoint` and `value` are bytea: SerializerProtocol.dumpsTyped hands back
 * [type, Uint8Array] and is allowed to produce encodings JSON cannot round-trip.
 */
export interface LanggraphCheckpointsTable {
  org_id: string; thread_id: string; checkpoint_ns: Generated<string>;
  checkpoint_id: string; parent_checkpoint_id: string | null;
  type: string | null; checkpoint: Buffer; metadata: JsonD;
  created_at: TsD;
}
export interface LanggraphCheckpointWritesTable {
  org_id: string; thread_id: string; checkpoint_ns: Generated<string>;
  checkpoint_id: string; task_id: string; idx: number;
  channel: string; type: string | null; value: Buffer | null;
}
export interface InteractionsTable {
  id: Generated<string>; run_id: string; thread_id: string; step_id: string | null;
  org_id: string; namespace_id: string; tenant_ref: string;
  kind: InteractionKind; status: Generated<InteractionStatus>; prompt: Json;
  response_schema: Json | null; originating_run_id: string | null;
  originating_principal_id: string | null; delegation_chain: JsonD;
  required_authorization: JsonD; responder_principal_id: string | null;
  response: Json | null; expires_at: Ts; created_at: TsD; resolved_at: Ts | null;
}
export interface EventsTable {
  id: Generated<string>; run_id: string; seq: string; occurred_at: TsD;
  schema_version: number; event_type: string; thread_id: string; parent_run_id: string | null;
  step_id: string | null; agent_version_id: string; org_id: string; namespace_id: string;
  tenant_ref: string; trace_id: string | null; span_id: string | null; causation_id: string | null;
  correlation_id: string | null; principal_id: string | null;
  delegation_chain: JsonD; protocol_metadata: JsonD; payload: Json;
}
export interface OutboxTable {
  id: Generated<string>; run_id: string; step_id: string | null; tool_invocation_id: string | null;
  destination: string; idempotency_key: string; payload: Json; status: Generated<string>;
  attempts: Generated<number>; next_attempt_at: TsD; last_error: Json | null;
  sent_at: Ts | null; created_at: TsD;
}
export interface DeadLettersTable {
  id: Generated<string>; run_id: string; step_id: string | null; reason: string; error: Json;
  attempts: number; last_worker: string | null; created_at: TsD;
  acknowledged_by: string | null; acknowledged_at: Ts | null; replayed_run_id: string | null;
}
export interface AdmissionDecisionsTable {
  id: Generated<string>; org_id: string; namespace_id: string; spec_hash: string;
  agent_version_id: string | null; caller_principal_id: string; approved: boolean;
  rejection_reasons: JsonD; checks: JsonD; decided_at: TsD;
}
export interface CapabilityGrantsTable {
  id: Generated<string>; org_id: string; grant_source: 'service' | 'user';
  namespace_id: string | null; grantee_principal_id: string | null; resource_kind: string;
  resource_id: string; tenant_ref: string | null; constraints: JsonD;
  granted_by: string; granted_at: TsD; expires_at: Ts | null; revoked_at: Ts | null;
}
export interface CredentialGrantsTable {
  id: Generated<string>; org_id: string; run_id: string; step_id: string | null;
  workload_identity_id: string; on_behalf_of_principal_id: string | null; audience: string;
  scopes: string[]; tenant_ref: string | null; token_id: string;
  issued_at: TsD; expires_at: Ts; revoked_at: Ts | null;
}
export interface UsageLedgerTable {
  id: Generated<string>; occurred_at: TsD; org_id: string; namespace_id: string;
  tenant_ref: string; agent_version_id: string | null; run_id: string | null; step_id: string | null;
  kind: string; model_id: string | null; provider: string | null;
  input_tokens: Generated<string>; output_tokens: Generated<string>; cached_input_tokens: Generated<string>;
  quantity: Generated<string>; cost_micros: Generated<string>;
}
export interface TriggersTable {
  id: Generated<string>; agent_id: string; pinned_version_id: string | null;
  trigger_type: 'http' | 'event' | 'webhook' | 'schedule' | 'callback';
  event_source: string | null; event_type: string | null; webhook_path: string | null;
  cron_expression: string | null; timezone: Generated<string>; config: JsonD;
  enabled: Generated<boolean>; created_at: TsD; tenant_ref: string | null;
}

export type MemoryTierValue =
  | 'working' | 'conversational' | 'semantic' | 'episodic' | 'procedural' | 'external';
export type MemoryScopeValue = 'org' | 'tenant' | 'user' | 'agent' | 'thread' | 'run';
export type MemoryProvenanceValue =
  | 'user_input' | 'model_output' | 'tool_output' | 'peer_result' | 'artifact' | 'consolidated';

export interface MemoryRecordsTable {
  id: Generated<string>; org_id: string; namespace_id: string; tenant_ref: string;
  tier: MemoryTierValue; scope: MemoryScopeValue;
  scope_user_id: string | null; scope_agent_id: string | null;
  scope_thread_id: string | null; scope_run_id: string | null;
  content: string | null; structured: Json | null; artifact_id: string | null;
  provenance: MemoryProvenanceValue;
  source_run_id: string | null; source_step_id: string | null; source_peer_id: string | null;
  trusted: Generated<boolean>;
  delivered: boolean | null; played_offset_ms: number | null;
  salience: Generated<number>; access_count: Generated<number>; last_accessed_at: Ts | null;
  consolidated_from: Generated<string[]>; superseded_by: string | null;
  shared: Generated<boolean>; sharing_policy_id: string | null; source_tenant_ref: string | null;
  expires_at: Ts | null; created_at: TsD; updated_at: TsD;
}

export interface MemoryEmbeddingsTable {
  memory_id: string; model_id: string; dimensions: number;
  // Written and read through raw SQL: pgvector's type has no node-postgres parser, and
  // a JS array would be silently stringified into something the index cannot use.
  embedding: unknown; created_at: TsD;
}

export interface LineageEdgesTable {
  id: Generated<string>; org_id: string; tenant_ref: string;
  derived_kind: string; derived_id: string;
  source_kind: string; source_id: string; relation: string;
  run_id: string | null; observed_at: TsD;
}

export type EnforcementLevel =
  | 'org' | 'namespace' | 'tenant' | 'agent' | 'worker_pool'
  | 'model' | 'tool' | 'mcp_server' | 'peer' | 'speech_provider';

export interface BackpressurePoliciesTable {
  id: Generated<string>; org_id: string; level: EnforcementLevel; scope_ref: string;
  max_concurrency: number | null; max_rate_per_sec: string | null;
  queue_depth_limit: number | null;
  on_saturation: 'queue' | 'throttle' | 'shed'; created_at: TsD;
}

export interface BudgetsTable {
  id: Generated<string>; org_id: string; level: EnforcementLevel; scope_ref: string;
  period: 'hour' | 'day' | 'month' | 'total';
  limit_micros: string; spent_micros: Generated<string>;
  period_started_at: TsD; resets_at: Ts | null;
}

export interface MemorySharingPoliciesTable {
  id: Generated<string>; org_id: string; namespace_id: string;
  tiers: MemoryTierValue[]; redaction_policy: string;
  enabled: Generated<boolean>; approved_by: string;
  approved_at: TsD; revoked_at: Ts | null;
}

export interface McpServersTable {
  id: Generated<string>; org_id: string; namespace_id: string; name: string;
  mcp_transport: 'stdio' | 'streamable_http';
  endpoint_url: string | null; command: string[] | null;
  protocol_revision: string; residency: Residency;
  allow_sampling: Generated<boolean>; rate_limit_qps: number | null;
  status: Generated<string>; created_at: TsD;
}

export interface McpServerToolsTable {
  id: Generated<string>; mcp_server_id: string; tool_name: string;
  definition_hash: string; definition: Json;
  first_seen_at: TsD; approved_by: string | null; approved_at: Ts | null;
  superseded_at: Ts | null;
}

export interface McpServerApprovalsTable {
  id: Generated<string>; mcp_server_id: string; namespace_id: string;
  tenant_ref: string | null; approved_by: string;
  approved_at: TsD; revoked_at: Ts | null;
}

export interface AgentVersionMcpServersTable {
  agent_version_id: string; mcp_server_id: string;
  allowed_tools: string[]; allow_sampling: Generated<boolean>;
}

export interface AgentVersionSubAgentsTable {
  agent_version_id: string; namespace_id: string; sub_agent_id: string; alias: string;
}

export interface ArtifactsTable {
  id: Generated<string>; org_id: string; namespace_id: string; tenant_ref: string;
  thread_id: string | null; produced_by_run_id: string | null; produced_by_step_id: string | null;
  content_hash: string; storage_uri: string; media_type: string; size_bytes: string;
  encryption_key_ref: string;
  version: Generated<number>; parent_artifact_id: string | null;
  retention_policy: string | null; expires_at: Ts | null;
  legal_hold: Generated<boolean>;
  state: Generated<'live' | 'expiring' | 'deleted'>; deleted_at: Ts | null;
  metadata: JsonD; created_at: TsD;
}

export interface FeedbackTable {
  id: Generated<string>; org_id: string; namespace_id: string; tenant_ref: string;
  run_id: string | null; thread_id: string | null; interaction_id: string | null;
  agent_version_id: string; principal_id: string | null;
  rating: number | null; label: string | null; comment: string | null;
  correction: Json | null; created_at: TsD;
}

// --- skills and knowledge (0012) -------------------------------------------

export interface KnowledgeCollectionsTable {
  id: Generated<string>; org_id: string; namespace_id: string;
  name: string; description: string | null;
  embedder_id: string; dimensions: number;
  status: Generated<RegistryStatus>; created_by: string | null;
  created_at: TsD; updated_at: TsD; archived_at: Ts | null;
}

export interface KnowledgeDocumentsTable {
  id: Generated<string>; collection_id: string; org_id: string;
  source_uri: string | null; title: string | null;
  content_hash: string; body: string; metadata: JsonD;
  chunk_count: Generated<number>; indexed_at: Ts | null; created_at: TsD;
}

export interface KnowledgeChunksTable {
  id: Generated<string>; document_id: string; collection_id: string;
  ord: number; content: string;
  // `embedding` is written through raw SQL (pgvector has no Kysely type); it is declared
  // here only so the column is not invisible to a select.
  embedding: string | null; created_at: TsD;
}

export interface SkillsTable {
  id: Generated<string>; org_id: string; namespace_id: string;
  name: string; description: string | null;
  created_by: string | null; created_at: TsD; archived_at: Ts | null;
}

export interface SkillVersionsTable {
  id: Generated<string>; skill_id: string; org_id: string; namespace_id: string;
  version: number;
  /** Exactly one of instructions/content_uri is set (skill_versions_content_source_chk). */
  instructions: string | null; content_uri: string | null;
  when_to_use: string | null;
  spec_hash: string; status: Generated<RegistryStatus>;
  published_by: string | null; published_at: TsD;
}

export interface SkillVersionToolsTable {
  skill_version_id: string; tool_id: string; effects: EffectClass[];
}

export interface SkillVersionCollectionsTable {
  skill_version_id: string; collection_id: string; namespace_id: string;
}

export interface AgentVersionSkillsTable {
  agent_version_id: string; skill_version_id: string; namespace_id: string; ord: number;
}

export interface AgentVersionCollectionsTable {
  agent_version_id: string; collection_id: string; namespace_id: string;
}

// --- A2A (0013) ------------------------------------------------------------

export interface PeersTable {
  id: Generated<string>; org_id: string; namespace_id: string; name: string;
  /** `inbound` (0032): a caller we accept but never call — no agent, endpoint or card. */
  binding: 'local' | 'remote' | 'inbound';
  local_agent_id: string | null; endpoint_url: string | null;
  protocol_version: string; residency: Residency;
  agent_card: Json | null; card_signature: string | null; card_verified_at: Ts | null;
  status: Generated<RegistryStatus>; created_at: TsD;
  failure_mode: Generated<'contain' | 'propagate'>;
  timeout_ms: Generated<number>;
  public_key: string | null; card_fetched_at: Ts | null;
  inbound_trust: Generated<'self' | 'delegated_identity'>;
  /** 0032: how this caller expects `message/send` answered. */
  reply_mode: Generated<'task' | 'message'>;
}

export interface AgentVersionPeersTable {
  agent_version_id: string; peer_id: string; alias: string;
}

export type PeerTaskState =
  | 'submitted' | 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface PeerTasksTable {
  id: Generated<string>; org_id: string; run_id: string; step_id: string;
  peer_id: string; binding: 'local' | 'remote';
  child_run_id: string | null;
  remote_task_id: string | null; remote_context_id: string | null;
  state: Generated<PeerTaskState>; error: Json | null;
  last_observed_at: Ts | null; created_at: TsD;
}

export interface A2aPushConfigsTable {
  id: Generated<string>; org_id: string; run_id: string;
  url: string; token_ref: string | null; created_at: TsD;
}

// --- evals (0004 + 0014) ---------------------------------------------------

export type Mechanism =
  | 'summarization' | 'compaction' | 'memory_tiers' | 'planning_scaffold'
  | 'sub_agents' | 'retrieval' | 'eviction' | 'skills' | 'knowledge'
  | 'model_cache' | 'peers' | 'none';
export type GraderKindValue =
  | 'exact' | 'contains' | 'not_contains' | 'regex' | 'json_path' | 'budget' | 'llm_judge';
export type EvalVerdict =
  | 'passed' | 'failed' | 'mechanism_justified' | 'mechanism_not_justified' | 'inconclusive';

export interface EvalSuitesTable {
  id: Generated<string>; org_id: string; namespace_id: string;
  ref: string; description: string | null;
  mechanism_under_test: Mechanism | null;
  // numeric() comes back from pg as a STRING, and is written as one. Typing it as number
  // would make `Number(x)` look redundant at every read site and invite its removal.
  min_score: Generated<string>; min_mechanism_delta: Generated<string>;
  created_at: TsD;
  trials_per_case: Generated<number>;
}

export interface EvalCasesTable {
  id: Generated<string>; eval_suite_id: string; name: string;
  input: Json; expectation: Json; weight: Generated<number>;
  grader: Generated<GraderKindValue>; ab_comparable: Generated<boolean>;
}

export interface EvalRunsTable {
  id: Generated<string>; eval_suite_id: string; agent_version_id: string;
  mechanism_enabled: boolean | null;
  score: string | null; passed: boolean | null; min_score: string | null;
  started_at: TsD; ended_at: Ts | null;
  baseline_eval_run_id: string | null; executed_version_id: string | null;
  cases_total: Generated<number>; cases_passed: Generated<number>;
  cases_errored: Generated<number>;
  p50_latency_ms: number | null; total_cost_micros: Generated<string>;
  verdict: EvalVerdict | null;
  score_stderr: string | null;
}

export interface EvalCaseResultsTable {
  eval_run_id: string; eval_case_id: string; run_id: string | null;
  score: string | null; passed: boolean; detail: Json | null;
  trial: Generated<number>;
}

export interface DeploymentsTable {
  id: Generated<string>; agent_id: string; environment: 'staging' | 'production';
  agent_version_id: string; canary_percent: Generated<number>;
  shadow_from_version_id: string | null; promotion_eval_run_id: string | null;
  state: Generated<'active' | 'rolling' | 'rolled_back' | 'retired'>;
  promoted_by: string | null; promoted_at: Ts | null; created_at: TsD;
  gate_overridden_by: string | null; gate_override_reason: string | null;
}

export interface PromotionGatesTable {
  id: Generated<string>; org_id: string; agent_id: string;
  environment: 'staging' | 'production'; eval_suite_id: string;
  min_score: Generated<string>; allow_override: Generated<boolean>; created_at: TsD;
}

export interface PromptsTable {
  id: Generated<string>; org_id: string; namespace_id: string;
  ref: string; owner: string; created_at: TsD;
}

export interface PromptVersionsTable {
  id: Generated<string>; prompt_id: string; version: number;
  body: string; content_hash: string;
  approved_by: string | null; approved_at: Ts | null; created_at: TsD;
}

// §17.3. `document` is Json, not a typed shape: the enforceable shape lives in
// src/domain/policy/policy-document.ts and is re-parsed on read, so a row written before a
// schema change is refused rather than half-enforced.
export interface PoliciesTable {
  id: Generated<string>; org_id: string;
  ref: string; owner: string; created_at: TsD;
}

export interface PolicyVersionsTable {
  id: Generated<string>; policy_id: string; version: number;
  document: Json; content_hash: string;
  approved_by: string | null; approved_at: Ts | null; created_at: TsD;
}

export interface SchemaMigrationsTable { version: string; applied_at: TsD; checksum: string }

export interface Database {
  orgs: OrgsTable; namespaces: NamespacesTable; tenants: TenantsTable; principals: PrincipalsTable;
  models: ModelsTable; agents: AgentsTable; agent_versions: AgentVersionsTable;
  tool_templates: ToolTemplatesTable; tools: ToolsTable; agent_version_tools: AgentVersionToolsTable;
  threads: ThreadsTable; runs: RunsTable; run_queue: RunQueueTable; steps: StepsTable;
  trace_export_cursor: TraceExportCursorTable;
  tool_invocations: ToolInvocationsTable; checkpoints: CheckpointsTable;
  langgraph_checkpoints: LanggraphCheckpointsTable;
  langgraph_checkpoint_writes: LanggraphCheckpointWritesTable;
  interactions: InteractionsTable; events: EventsTable; outbox: OutboxTable;
  dead_letters: DeadLettersTable; admission_decisions: AdmissionDecisionsTable;
  capability_grants: CapabilityGrantsTable; credential_grants: CredentialGrantsTable;
  usage_ledger: UsageLedgerTable; triggers: TriggersTable;
  memory_records: MemoryRecordsTable; memory_embeddings: MemoryEmbeddingsTable;
  lineage_edges: LineageEdgesTable;
  backpressure_policies: BackpressurePoliciesTable; budgets: BudgetsTable;
  feedback: FeedbackTable; artifacts: ArtifactsTable;
  agent_version_sub_agents: AgentVersionSubAgentsTable;
  memory_sharing_policies: MemorySharingPoliciesTable;
  mcp_servers: McpServersTable; mcp_server_tools: McpServerToolsTable;
  mcp_server_approvals: McpServerApprovalsTable;
  agent_version_mcp_servers: AgentVersionMcpServersTable;
  knowledge_collections: KnowledgeCollectionsTable;
  knowledge_documents: KnowledgeDocumentsTable;
  knowledge_chunks: KnowledgeChunksTable;
  skills: SkillsTable; skill_versions: SkillVersionsTable;
  skill_version_tools: SkillVersionToolsTable;
  skill_version_collections: SkillVersionCollectionsTable;
  agent_version_skills: AgentVersionSkillsTable;
  agent_version_collections: AgentVersionCollectionsTable;
  peers: PeersTable; agent_version_peers: AgentVersionPeersTable;
  peer_tasks: PeerTasksTable; a2a_push_configs: A2aPushConfigsTable;
  eval_suites: EvalSuitesTable; eval_cases: EvalCasesTable;
  eval_runs: EvalRunsTable; eval_case_results: EvalCaseResultsTable;
  deployments: DeploymentsTable; promotion_gates: PromotionGatesTable;
  prompts: PromptsTable; prompt_versions: PromptVersionsTable;
  policies: PoliciesTable; policy_versions: PolicyVersionsTable;
  schema_migrations: SchemaMigrationsTable;
}
