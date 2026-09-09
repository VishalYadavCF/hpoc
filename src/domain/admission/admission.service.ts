import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import type { EffectClass } from '../../platform/persistence/schema.types.js';
import { agentSpecSchema, type AgentSpec } from '../registry/agent-spec.js';
import { SkillService, type ResolvedSkill } from '../skills/skill.service.js';
import { PeerService, type ResolvedPeer } from '../peer/peer.service.js';
import { PromptService, type ResolvedPrompt } from '../prompt/prompt.service.js';
import { PolicyService, type ResolvedPolicy } from '../policy/policy.service.js';
import { enforcePolicy } from '../policy/policy-document.js';
import { AdmissionRejected } from '../errors/platform.errors.js';
import { stableHash } from '../../platform/ids.js';

export interface AdmissionInput {
  orgId: string;
  namespaceId: string;
  callerPrincipalId: string;
  rawSpec: unknown;
}

export interface AdmittedTool {
  ref: string;
  id: string;
  /** The tool's declared contract, carried through so the binding cannot invent one. */
  effects: EffectClass[];
}

export interface AdmissionResult {
  spec: AgentSpec;
  specHash: string;
  modelId: string;
  /** The UNION of directly-named tools and every tool the resolved skills bring. */
  toolIds: AdmittedTool[];
  subAgentIds: { name: string; id: string }[];
  skills: ResolvedSkill[];
  /** Collections named directly on the spec; a skill's own collections stay on the skill. */
  collectionIds: { name: string; id: string }[];
  peers: ResolvedPeer[];
  /** The registry prompt this version pins, when the spec named one (§17.2). */
  prompt: ResolvedPrompt | null;
  /** The registry policy this version pins and was admitted against (§17.3). */
  policy: ResolvedPolicy | null;
  /**
   * The cost ceiling after the policy narrowed the spec's own, and the tools the policy
   * forces behind an approval gate. Both are decided at admission so the run engine reads
   * a number rather than re-deriving a rule.
   */
  effectiveMaxCostMicros: number | null;
  policyApprovalRequired: string[];
}

/**
 * §17.5. Dynamic specs are untrusted input.
 *
 * Two properties matter more than the checks themselves:
 *
 *  - Rejections are COLLECTED, not short-circuited. An author fixing a spec should see
 *    every problem at once rather than one per round trip.
 *  - Rejections are EXPLICIT. A spec requesting an ungranted capability is refused, never
 *    quietly filtered down to what is permitted -- silent narrowing hides bugs, and hides
 *    them in the security-relevant direction.
 */
@Injectable()
export class AdmissionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly skills: SkillService,
    private readonly peers: PeerService,
    private readonly prompts: PromptService,
    private readonly policies: PolicyService,
  ) {}

  async admit(input: AdmissionInput): Promise<AdmissionResult> {
    const rejections: string[] = [];
    const checks: Record<string, unknown> = {};

    const parsed = agentSpecSchema.safeParse(input.rawSpec);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        rejections.push(`spec.${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      await this.record(input, null, false, rejections, checks);
      throw new AdmissionRejected(rejections);
    }
    const spec = parsed.data;
    checks['schema'] = 'ok';

    const model = await this.db
      .selectFrom('models')
      .select(['id', 'ref', 'residency', 'status'])
      .where('org_id', '=', input.orgId)
      .where('ref', '=', spec.model.ref)
      .executeTakeFirst();

    if (!model) rejections.push(`model.ref: "${spec.model.ref}" is not in the model registry`);
    else if (model.status !== 'active') rejections.push(`model.ref: "${spec.model.ref}" is ${model.status}`);
    checks['model'] = model ? 'ok' : 'missing';

    const tools = spec.tools.length
      ? await this.db
          .selectFrom('tools')
          // ::text[] deliberately: pg cannot parse a custom enum array OID and hands back
          // the literal '{a,b}' string, on which Array methods silently do not exist.
          .select((eb) => [
            'id', 'ref', 'status',
            sql<EffectClass[]>`default_effects::text[]`.as('default_effects'),
          ])
          .where('org_id', '=', input.orgId)
          .where('ref', 'in', spec.tools)
          .execute()
      : [];

    const found = new Map(tools.map((t) => [t.ref, t]));
    for (const ref of spec.tools) {
      const tool = found.get(ref);
      if (!tool) rejections.push(`tools: "${ref}" is not in the tool registry`);
      else if (tool.status !== 'active') rejections.push(`tools: "${ref}" is ${tool.status}`);
    }
    checks['tools'] = `${found.size}/${spec.tools.length}`;

    // Skills resolve to immutable versions HERE, once, so what gets stored on the agent
    // version is a version id rather than a name. Publishing skill v4 afterwards does not
    // reach back into an agent admitted against v3.
    const { resolved: skills, rejections: skillRejections } = spec.skills.length
      ? await this.skills.resolve(input.namespaceId, spec.skills)
      : { resolved: [] as ResolvedSkill[], rejections: [] as string[] };
    rejections.push(...skillRejections);
    checks['skills'] = `${skills.length}/${spec.skills.length}`;

    const collections = spec.knowledge.collections.length
      ? await this.db
          .selectFrom('knowledge_collections')
          .select(['id', 'name'])
          .where('namespace_id', '=', input.namespaceId)
          .where('name', 'in', spec.knowledge.collections)
          .where('archived_at', 'is', null)
          .where('status', '=', 'active')
          .execute()
      : [];
    const foundCollections = new Map(collections.map((c) => [c.name, c]));
    for (const name of spec.knowledge.collections) {
      if (!foundCollections.has(name)) {
        rejections.push(
          `knowledge.collections: "${name}" is not an active collection in this namespace`,
        );
      }
    }
    checks['collections'] = `${foundCollections.size}/${spec.knowledge.collections.length}`;

    // The union a run actually executes with. A skill's tools are indistinguishable from
    // directly-named ones at call time, so they must be indistinguishable at admission
    // time too -- otherwise "attach the skill" is a capability-laundering path around a
    // tool the caller was refused.
    const admitted = new Map<string, AdmittedTool>(
      [...found.values()].map((t) => [t.ref, { ref: t.ref, id: t.id, effects: t.default_effects }]),
    );
    for (const skill of skills) {
      for (const tool of skill.tools) {
        if (!admitted.has(tool.ref)) admitted.set(tool.ref, tool);
      }
    }

    // §16.2 -- the intersection. A caller may only select from capability it already holds.
    // Grant granularity (service identity vs namespace) is an open decision; Phase 1
    // resolves at the namespace level and records which rule was applied.
    if (model) {
      const granted = await this.hasGrant(input, 'model', model.id);
      if (!granted) rejections.push(`model.ref: no capability grant for "${spec.model.ref}"`);
    }
    for (const tool of admitted.values()) {
      const granted = await this.hasGrant(input, 'tool', tool.id);
      if (!granted) {
        // Named separately when it arrived through a skill: "no grant for payments.refund"
        // is baffling to an author whose spec never mentioned payments.refund.
        const via = skills.find((sk) => sk.tools.some((t) => t.ref === tool.ref) && !found.has(tool.ref));
        rejections.push(
          via
            ? `skills: "${via.name}@${via.version}" requires tool "${tool.ref}", for which there is no capability grant`
            : `tools: no capability grant for "${tool.ref}"`,
        );
      }
    }
    for (const skill of skills) {
      const granted = await this.hasGrant(input, 'skill', skill.skillVersionId);
      if (!granted) rejections.push(`skills: no capability grant for "${skill.name}"`);
    }
    // Every collection reachable from this spec, whether named directly or pulled in by a
    // skill. A corpus is readable data and a skill must not smuggle read access either.
    const reachableCollections = new Set([
      ...[...foundCollections.values()].map((c) => c.id),
      ...skills.flatMap((sk) => sk.collectionIds),
    ]);
    for (const collectionId of reachableCollections) {
      const granted = await this.hasGrant(input, 'knowledge_collection', collectionId);
      if (!granted) {
        rejections.push(`knowledge: no capability grant for collection ${collectionId}`);
      }
    }
    checks['capabilityIntersection'] = 'namespace-level';

    // §13.3, checked at admission so a bad spec is refused at publish rather than at the
    // first delegation. The composite FK is still the enforcement; this is the error message.
    const subAgents = spec.subAgents.length
      ? await this.db
          .selectFrom('agents')
          .select(['id', 'name'])
          .where('namespace_id', '=', input.namespaceId)
          .where(
            'name',
            'in',
            spec.subAgents.map((sa) => sa.name),
          )
          .where('archived_at', 'is', null)
          .execute()
      : [];
    const foundSubAgents = new Map(subAgents.map((a) => [a.name, a]));
    for (const { name } of spec.subAgents) {
      if (!foundSubAgents.has(name)) {
        rejections.push(
          `subAgents: "${name}" is not an agent in this namespace. Cross-namespace ` +
            `delegation goes over A2A, not subAgents (§13.3)`,
        );
      }
    }
    checks['subAgents'] = `${foundSubAgents.size}/${spec.subAgents.length}`;

    // §13.3's asymmetry, made concrete: sub-agents resolve within the namespace, peers
    // resolve across the ORG. Reaching another team's agent is legitimate — it is just
    // required to go over A2A rather than through subAgents.
    const { resolved: peers, rejections: peerRejections } = await this.peers.resolve(
      input.orgId,
      spec.a2a.peers,
    );
    rejections.push(...peerRejections);
    for (const peer of peers) {
      // §16.2 again. A peer is egress and another trust domain; naming one in a spec must
      // not be enough to reach it.
      const granted = await this.hasGrant(input, 'peer', peer.id);
      if (!granted) rejections.push(`a2a.peers: no capability grant for "${peer.name}"`);
    }
    checks['peers'] = `${peers.length}/${spec.a2a.peers.length}`;

    // §17.2. Resolved ONCE here, so the agent version stores a prompt_version_id rather
    // than a name -- publishing a new prompt version cannot reach back into a running agent.
    let prompt: ResolvedPrompt | null = null;
    if (spec.promptRef) {
      const { resolved, rejections: promptRejections } = await this.prompts.resolve([spec.promptRef]);
      rejections.push(...promptRejections);
      prompt = resolved[0] ?? null;
      if (prompt) {
        // A prompt is instruction the agent executes under, so selecting one is capability
        // (§16.2) -- the same argument as for a skill that carries tools.
        const granted = await this.hasGrant(input, 'prompt', prompt.promptVersionId);
        if (!granted) rejections.push(`promptRef: no capability grant for "${prompt.ref}"`);
      }
    }
    checks['prompt'] = spec.promptRef ? (prompt ? `${prompt.ref}@${prompt.version}` : 'unresolved') : 'inline';

    // §17.3, LAST of the resolution steps and deliberately so: a policy speaks about the
    // model, tools and peers, so it can only be applied once those are resolved. It runs
    // even when earlier checks already failed, because §17.5 collects every rejection --
    // an author fixing a spec should see the policy violation in the same round trip as
    // the missing tool, not after fixing it.
    let policy: ResolvedPolicy | null = null;
    let effectiveMaxCostMicros = spec.execution.limits.maxCostMicros;
    let policyApprovalRequired: string[] = [];
    if (spec.policyRef) {
      const { resolved, rejections: policyRejections } = await this.policies.resolve([spec.policyRef]);
      rejections.push(...policyRejections);
      policy = resolved[0] ?? null;
      if (policy) {
        // Selecting a policy is NOT capability-gated, unlike a prompt or a tool. A policy
        // can only narrow (see enforcePolicy), so naming one is asking for less authority
        // than you already had -- requiring a grant to restrict yourself would be theatre.
        const verdict = enforcePolicy(policy.document, {
          modelRef: spec.model.ref,
          modelResidency: (model?.residency ?? 'internal') as 'internal' | 'external',
          tools: [...admitted.values()].map((t) => t.ref),
          // A local peer runs in this deployment and a remote one is egress, which is
          // exactly how peer.service.ts:154 assigns residency at registration.
          peers: peers.map((p) => ({
            name: p.name,
            residency: p.binding === 'local' ? ('internal' as const) : ('external' as const),
          })),
          // The policy speaks about WHICH sub-agents may be used, not how they execute,
          // so it sees names. `allowSubAgents: false` denies both modes alike.
          subAgents: spec.subAgents.map((sa) => sa.name),
          maxCostMicros: spec.execution.limits.maxCostMicros,
        });
        rejections.push(...verdict.rejections);
        effectiveMaxCostMicros = verdict.effectiveMaxCostMicros;
        policyApprovalRequired = verdict.approvalRequired;
      }
    }
    checks['policy'] = spec.policyRef
      ? policy
        ? `${policy.ref}@${policy.version}`
        : 'unresolved'
      : 'none';

    const specHash = stableHash(spec);

    if (rejections.length > 0) {
      await this.record(input, specHash, false, rejections, checks);
      throw new AdmissionRejected(rejections);
    }

    await this.record(input, specHash, true, [], checks);
    return {
      spec,
      specHash,
      modelId: model!.id,
      toolIds: [...admitted.values()],
      subAgentIds: [...foundSubAgents.values()].map((a) => ({ name: a.name, id: a.id })),
      skills,
      collectionIds: [...foundCollections.values()].map((c) => ({ name: c.name, id: c.id })),
      peers,
      prompt,
      policy,
      effectiveMaxCostMicros,
      policyApprovalRequired,
    };
  }

  private async hasGrant(
    input: AdmissionInput,
    resourceKind: string,
    resourceId: string,
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom('capability_grants')
      .select('id')
      .where('org_id', '=', input.orgId)
      .where('resource_kind', '=', resourceKind)
      .where('resource_id', '=', resourceId)
      .where('revoked_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('namespace_id', '=', input.namespaceId),
          eb('grantee_principal_id', '=', input.callerPrincipalId),
        ]),
      )
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Recorded either way. §18.5 watches the derivative of this table: distinct spec hashes
   * growing with RUN count rather than with EDIT count means a caller is interpolating
   * variable content into its system prompt -- a prompt-injection path and a
   * cache-defeating one.
   */
  private async record(
    input: AdmissionInput,
    specHash: string | null,
    approved: boolean,
    rejections: string[],
    checks: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .insertInto('admission_decisions')
      .values({
        org_id: input.orgId,
        namespace_id: input.namespaceId,
        spec_hash: specHash ?? 'unparseable',
        caller_principal_id: input.callerPrincipalId,
        approved,
        rejection_reasons: JSON.stringify(rejections),
        checks: JSON.stringify(checks),
      })
      .execute();
  }
}
