import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db, Tx } from '../../platform/persistence/database.js';
import type { AdmissionResult } from '../admission/admission.service.js';
import type { AdmittedTool } from '../admission/admission.service.js';
import { NotFound } from '../errors/platform.errors.js';

/**
 * Satisfies the schema's CHECK constraints from the tool's declared effects.
 *
 * Those constraints are business rules -- cacheable implies read-only and a TTL,
 * idempotent implies a key, compensatable implies a named inverse -- so a binding that
 * declares an effect without its obligation is rejected by the database. Supplying the
 * obligations here is what lets an inline spec use a contract-bearing tool at all.
 */
function bindingFor(agentVersionId: string, tool: AdmittedTool) {
  const has = (e: string): boolean => tool.effects.includes(e as never);
  return {
    agent_version_id: agentVersionId,
    tool_id: tool.id,
    // An ephemeral spec cannot name a compensation tool, so the effect is dropped rather
    // than written without its inverse. Dropping it NARROWS capability, which is safe;
    // keeping it would claim a rollback path that does not exist.
    effects: tool.effects.filter((e) => e !== 'compensatable'),
    cache_ttl_seconds: has('cacheable') ? 60 : null,
    cache_scope: has('cacheable') ? 'tenant' : null,
    idempotency_key_tpl: has('idempotent') ? '${runId}:${stepId}' : null,
    compensation_tool_id: null,
  };
}

export interface ResolvedVersion {
  id: string;
  framework: string;
  modelId: string;
  systemPrompt: string | null;
  /** Set when the prompt came from the registry; null for an inline systemPrompt. */
  promptVersionId: string | null;
  promptRef: string | null;
  durability: 'strict' | 'relaxed';
  maxSteps: number;
  maxCostMicros: string | null;
  workloadIdentityId: string;
  dataClass: 'internal' | 'regulated';
  memory: {
    enabled: boolean;
    tiers: string[];
    recallLimit: number;
    retentionSeconds: number | null;
  };
  subAgents: string[];
  /** Pinned skill versions, in spec order. Loaded from the pin table, not the spec blob. */
  skills: {
    skillVersionId: string;
    name: string;
    version: number;
    instructions: string;
    whenToUse: string | null;
  }[];
  knowledge: { collectionIds: string[]; recallLimit: number };
  /** Peers this version may call, by alias. Resolved once at admission (§13.4). */
  peers: { alias: string; peerId: string }[];
  cache: { modelResponses: boolean; ttlSeconds: number };
  context: { maxChars: number; reserveForAnswer: number; compaction: boolean; eviction: boolean };
  /**
   * How the pinned policy shapes the framework's own surface (§17.3).
   *
   * Distinct from the tool BINDINGS, which admission already narrowed: by the time a run
   * starts, a denied bound tool is simply not bound. This is about the tools a framework
   * brings with it -- a scratch filesystem, a planner, a sub-agent spawner -- which the
   * platform has never had a vocabulary for. A policy saying "this agent may not write
   * files" was, until now, unsayable.
   */
  harness: HarnessShaping;
  /** JSON Schema the final answer must satisfy, or null when the agent declared none. */
  responseSchema: Record<string, unknown> | null;
}

export interface HarnessShaping {
  /** Framework-provided tool names the policy denies. Matched case-sensitively. */
  excludedTools: string[];
  /** Text appended after the resolved system prompt, for per-model tuning (§17.2). */
  systemPromptSuffix: string | null;
}

@Injectable()
export class AgentVersionService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Materialises an ephemeral, anonymous, content-addressed AgentVersion (§18.1).
   *
   * The ON CONFLICT is what collapses a consuming service's thousand identical inline
   * specs onto ONE version row and one prompt-cache key -- the answer to §18.5's
   * cardinality concern for a caller like ap-executor, whose spec set is bounded by
   * workflow-node edits rather than by run count. The degenerate SET exists so RETURNING
   * fires on the conflict path too.
   */
  async materialiseEphemeral(args: {
    tx: Tx;
    orgId: string;
    namespaceId: string;
    workloadIdentityId: string;
    admission: AdmissionResult;
  }): Promise<ResolvedVersion> {
    const { tx, admission } = args;
    const spec = admission.spec;

    const row = await tx
      .insertInto('agent_versions')
      .values({
        agent_id: null,
        org_id: args.orgId,
        namespace_id: args.namespaceId,
        lifetime: 'ephemeral',
        version: null,
        spec: JSON.stringify(spec),
        spec_hash: admission.specHash,
        workload_identity_id: args.workloadIdentityId,
        model_id: admission.modelId,
        durability: spec.execution.durability,
        data_class: spec.security.dataClass,
        max_steps: spec.execution.limits.maxSteps,
        // The policy-narrowed ceiling, not the spec's own. §17.3's whole point is that a
        // spend rule lives in one place; storing the spec's number here would mean the run
        // engine enforced the limit the author asked for rather than the one policy allows.
        max_cost_micros:
          admission.effectiveMaxCostMicros === null
            ? null
            : String(admission.effectiveMaxCostMicros),
        // The RESOLVED version id, not the ref the author typed (§17.2, §17.3).
        prompt_version_id: admission.prompt?.promptVersionId ?? null,
        policy_version_id: admission.policy?.policyVersionId ?? null,
      })
      .onConflict((oc) =>
        oc
          .columns(['org_id', 'spec_hash'])
          // The index is PARTIAL (migration 0007), and Postgres cannot infer a partial
          // index without its predicate -- without this the insert fails with "no unique
          // or exclusion constraint matching the ON CONFLICT specification".
          .where('lifetime', '=', 'ephemeral')
          .doUpdateSet({ spec_hash: admission.specHash }),
      )
      .returning(['id'])
      .executeTakeFirstOrThrow();

    // Bindings carry the TOOL'S declared contract, not a placeholder. Writing
    // `['read_only']` here regardless of what the tool declared would silently strip
    // every approval gate and idempotency guarantee off an ephemeral agent -- the effect
    // contract is what §4.5's honesty rests on, and inventing one defeats it.
    if (admission.toolIds.length > 0) {
      await tx
        .insertInto('agent_version_tools')
        .values(admission.toolIds.map((t) => bindingFor(row.id, t)))
        .onConflict((oc) => oc.columns(['agent_version_id', 'tool_id']).doNothing())
        .execute();
    }


    // The composite FK on (agent_version_id, namespace_id) and (sub_agent_id,
    // namespace_id) makes a cross-namespace sub-agent UNREPRESENTABLE rather than merely
    // rejected -- it holds for a migration or a psql session too.
    if (admission.subAgentIds.length > 0) {
      await tx
        .insertInto('agent_version_sub_agents')
        .values(
          admission.subAgentIds.map((a) => ({
            agent_version_id: row.id,
            namespace_id: args.namespaceId,
            sub_agent_id: a.id,
            alias: a.name,
          })),
        )
        .onConflict((oc) => oc.columns(['agent_version_id', 'sub_agent_id']).doNothing())
        .execute();
    }

    await this.writeAttachments(tx, row.id, args.namespaceId, admission, null);

    return this.load(tx, row.id);
  }

  /**
   * A named, numbered, immutable version (§18.1 registered lifetime).
   *
   * Unlike the ephemeral path this is NOT content-addressed: two identical specs published
   * a week apart are two versions, because a version is what a deployment, a trigger and a
   * rollback point at. Collapsing them would make "roll back to v3" ambiguous.
   */
  async materialiseRegistered(args: {
    tx: Tx;
    agentId: string;
    orgId: string;
    namespaceId: string;
    workloadIdentityId: string;
    createdBy: string;
    admission: AdmissionResult;
  }): Promise<ResolvedVersion> {
    const { tx, admission } = args;
    const spec = admission.spec;

    const previous = await tx
      .selectFrom('agent_versions')
      .select((eb) => eb.fn.max('version').as('v'))
      .where('agent_id', '=', args.agentId)
      .executeTakeFirst();

    const row = await tx
      .insertInto('agent_versions')
      .values({
        agent_id: args.agentId,
        org_id: args.orgId,
        namespace_id: args.namespaceId,
        lifetime: 'registered',
        version: Number(previous?.v ?? 0) + 1,
        spec: JSON.stringify(spec),
        // The true content hash. Uniqueness is scoped to the ephemeral lifetime by a
        // partial index (migration 0007), so two versions may legitimately share one.
        spec_hash: admission.specHash,
        workload_identity_id: args.workloadIdentityId,
        model_id: admission.modelId,
        durability: spec.execution.durability,
        data_class: spec.security.dataClass,
        max_steps: spec.execution.limits.maxSteps,
        // The policy-narrowed ceiling, not the spec's own. §17.3's whole point is that a
        // spend rule lives in one place; storing the spec's number here would mean the run
        // engine enforced the limit the author asked for rather than the one policy allows.
        max_cost_micros:
          admission.effectiveMaxCostMicros === null
            ? null
            : String(admission.effectiveMaxCostMicros),
        // The RESOLVED version id, not the ref the author typed (§17.2, §17.3).
        prompt_version_id: admission.prompt?.promptVersionId ?? null,
        policy_version_id: admission.policy?.policyVersionId ?? null,
        created_by: args.createdBy,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    if (admission.toolIds.length > 0) {
      await tx
        .insertInto('agent_version_tools')
        .values(admission.toolIds.map((t) => bindingFor(row.id, t)))
        .execute();
    }

    // The composite FK on (agent_version_id, namespace_id) and (sub_agent_id,
    // namespace_id) makes a cross-namespace sub-agent UNREPRESENTABLE rather than merely
    // rejected -- it holds for a migration or a psql session too.
    if (admission.subAgentIds.length > 0) {
      await tx
        .insertInto('agent_version_sub_agents')
        .values(
          admission.subAgentIds.map((a) => ({
            agent_version_id: row.id,
            namespace_id: args.namespaceId,
            sub_agent_id: a.id,
            alias: a.name,
          })),
        )
        .onConflict((oc) => oc.columns(['agent_version_id', 'sub_agent_id']).doNothing())
        .execute();
    }

    await this.writeAttachments(tx, row.id, args.namespaceId, admission, args.agentId);

    return this.load(tx, row.id);
  }

  /**
   * Writes the skill and collection pins for a version.
   *
   * Shared by both lifetimes because the argument for pinning is the same in both: an
   * ephemeral spec is content-addressed on the skill REFS it named, so two runs a week
   * apart with the same spec text would otherwise resolve `billing-refunds` to different
   * skill versions while reusing one agent_versions row -- a stored spec that no longer
   * describes what ran.
   */
  private async writeAttachments(
    tx: Tx,
    agentVersionId: string,
    namespaceId: string,
    admission: AdmissionResult,
    agentId?: string | null,
  ): Promise<void> {
    if (admission.skills.length > 0) {
      await tx
        .insertInto('agent_version_skills')
        .values(
          admission.skills.map((s, i) => ({
            agent_version_id: agentVersionId,
            skill_version_id: s.skillVersionId,
            namespace_id: namespaceId,
            // Stored, not derived. Skill order is part of the spec's meaning, and a join
            // returns whatever the planner felt like -- which is how sub-agent ordering
            // silently inverted once already.
            ord: i,
          })),
        )
        .onConflict((oc) => oc.columns(['agent_version_id', 'skill_version_id']).doNothing())
        .execute();
    }

    if (admission.peers.length > 0) {
      await tx
        .insertInto('agent_version_peers')
        .values(
          admission.peers.map((p) => ({
            agent_version_id: agentVersionId,
            peer_id: p.id,
            alias: p.name,
          })),
        )
        .onConflict((oc) => oc.columns(['agent_version_id', 'peer_id']).doNothing())
        .execute();
    }

    // §13.6: exposure is resolved onto the AGENT, not stored per version. The spec is the
    // input; `agents.expose_as_peer` is the answer both dispatch and card-serving read, so
    // there is exactly one. Ephemeral versions have no agent and cannot be addressed by
    // name, so they cannot be exposed at all -- which is correct: a peer is a stable
    // address, and an anonymous content-addressed spec is not one.
    if (agentId && admission.spec.a2a.exposeAsPeer) {
      await tx
        .updateTable('agents')
        .set({ expose_as_peer: true })
        .where('id', '=', agentId)
        .execute();
    }

    // A skill's own collections are NOT copied here. They belong to the skill version and
    // travel with it; duplicating them would leave the agent still reading a corpus after
    // the skill that justified the access was swapped out.
    if (admission.collectionIds.length > 0) {
      await tx
        .insertInto('agent_version_collections')
        .values(
          admission.collectionIds.map((c) => ({
            agent_version_id: agentVersionId,
            collection_id: c.id,
            namespace_id: namespaceId,
          })),
        )
        .onConflict((oc) => oc.columns(['agent_version_id', 'collection_id']).doNothing())
        .execute();
    }
  }

  async load(db: Db | Tx, id: string): Promise<ResolvedVersion> {
    const row = await db
      .selectFrom('agent_versions')
      .select([
        'id', 'spec', 'model_id', 'durability', 'max_steps',
        'max_cost_micros', 'workload_identity_id', 'data_class', 'prompt_version_id',
        'policy_version_id',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFound('agent version', id);

    // The PINNED policy version, not the policy's current head. §17.3 makes a version's
    // governance part of what it is; re-reading the head here would let an edit to a
    // policy change how an already-admitted version behaves, with no new admission and
    // nothing in the trace to show it happened.
    const policyDocument = row.policy_version_id
      ? ((
          await db
            .selectFrom('policy_versions')
            .select('document')
            .where('id', '=', row.policy_version_id)
            .executeTakeFirst()
        )?.document ?? null)
      : null;

    // Skills come from the PIN TABLE, never from the spec blob. The blob holds the refs
    // the author typed ("billing-refunds"); the pins hold what admission resolved them to.
    // Reading the blob here would re-resolve on every load and quietly move a running
    // agent onto a newer skill version.
    const skills = await db
      .selectFrom('agent_version_skills as avs')
      .innerJoin('skill_versions as sv', 'sv.id', 'avs.skill_version_id')
      .innerJoin('skills as sk', 'sk.id', 'sv.skill_id')
      .select(['sv.id as skill_version_id', 'sk.name', 'sv.version', 'sv.instructions', 'sv.when_to_use'])
      .where('avs.agent_version_id', '=', id)
      .orderBy('avs.ord')
      .execute();

    // Direct collections plus every collection the pinned skills carry. Deduplicated,
    // because searching the same corpus twice returns the same chunks twice and spends
    // the recall budget on duplicates.
    const directCollections = await db
      .selectFrom('agent_version_collections')
      .select('collection_id')
      .where('agent_version_id', '=', id)
      .execute();
    const skillCollections = skills.length
      ? await db
          .selectFrom('skill_version_collections')
          .select('collection_id')
          .where('skill_version_id', 'in', skills.map((s) => s.skill_version_id))
          .execute()
      : [];
    // The BODY comes from the pinned version, never from the spec blob -- the blob holds
    // the ref the author typed, and re-resolving it on every load would silently move a
    // running agent onto a newer prompt.
    const pinnedPrompt = row.prompt_version_id
      ? ((await db
          .selectFrom('prompt_versions as pv')
          .innerJoin('prompts as p', 'p.id', 'pv.prompt_id')
          .select(['pv.id', 'pv.body', 'pv.version', 'p.ref'])
          .where('pv.id', '=', row.prompt_version_id)
          .executeTakeFirst()) ?? null)
      : null;

    const peerRows = await db
      .selectFrom('agent_version_peers')
      .select(['peer_id', 'alias'])
      .where('agent_version_id', '=', id)
      .orderBy('alias')
      .execute();

    const collectionIds = [
      ...new Set([
        ...directCollections.map((c) => c.collection_id),
        ...skillCollections.map((c) => c.collection_id),
      ]),
    ];

    const spec = (row.spec ?? {}) as {
      framework?: string;
      systemPrompt?: string | null;
      memory?: { enabled?: boolean; tiers?: string[]; recallLimit?: number; retentionSeconds?: number | null };
      subAgents?: string[];
      knowledge?: { collections?: string[]; recallLimit?: number };
      cache?: { modelResponses?: boolean; ttlSeconds?: number };
      context?: { maxChars?: number; reserveForAnswer?: number; compaction?: boolean; eviction?: boolean };
      harness?: { systemPromptSuffix?: string | null };
      responseSchema?: Record<string, unknown> | null;
    };

    return {
      id: row.id,
      framework: spec.framework ?? 'echo',
      modelId: row.model_id,
      systemPrompt: pinnedPrompt?.body ?? spec.systemPrompt ?? null,
      promptVersionId: pinnedPrompt?.id ?? null,
      promptRef: pinnedPrompt ? `${pinnedPrompt.ref}@${pinnedPrompt.version}` : null,
      durability: row.durability,
      maxSteps: row.max_steps ?? 50,
      maxCostMicros: row.max_cost_micros,
      workloadIdentityId: row.workload_identity_id,
      dataClass: row.data_class,
      memory: {
        enabled: spec.memory?.enabled ?? false,
        tiers: spec.memory?.tiers ?? ['conversational', 'episodic'],
        recallLimit: spec.memory?.recallLimit ?? 5,
        retentionSeconds: spec.memory?.retentionSeconds ?? null,
      },
      subAgents: spec.subAgents ?? [],
      skills: skills.map((sk) => ({
        skillVersionId: sk.skill_version_id,
        name: sk.name,
        version: sk.version,
        instructions: sk.instructions,
        whenToUse: sk.when_to_use,
      })),
      knowledge: { collectionIds, recallLimit: spec.knowledge?.recallLimit ?? 5 },
      peers: peerRows.map((p) => ({ alias: p.alias, peerId: p.peer_id })),
      cache: {
        modelResponses: spec.cache?.modelResponses ?? false,
        ttlSeconds: spec.cache?.ttlSeconds ?? 300,
      },
      context: {
        maxChars: spec.context?.maxChars ?? 24_000,
        reserveForAnswer: spec.context?.reserveForAnswer ?? 4_000,
        compaction: spec.context?.compaction ?? true,
        eviction: spec.context?.eviction ?? true,
      },
      harness: harnessShaping(policyDocument, spec),
      responseSchema: spec.responseSchema ?? null,
    };
  }
}

/**
 * What the pinned policy and the spec say about the FRAMEWORK's own surface (§17.3).
 *
 * Read from the policy's tool denylist, reusing the list an operator already maintains
 * rather than adding a second one they must remember to keep in step. A denied name that
 * matches no framework tool is silently inert -- the same list also denies bound tools,
 * and admission already refused those, so a miss here means "that entry was about a bound
 * tool", not "the operator made a mistake".
 */
function harnessShaping(
  document: unknown,
  spec: { harness?: { systemPromptSuffix?: string | null } },
): HarnessShaping {
  const tools = (document as { tools?: { deny?: unknown } } | null)?.tools;
  const deny = Array.isArray(tools?.deny) ? tools.deny.filter((d): d is string => typeof d === 'string') : [];
  return {
    excludedTools: deny,
    systemPromptSuffix: spec.harness?.systemPromptSuffix ?? null,
  };
}
