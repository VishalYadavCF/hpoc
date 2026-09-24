import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import type { EffectClass } from '../../platform/persistence/schema.types.js';
import { agentSpecSchema, type AgentSpec, type InlineToolSpec } from '../registry/agent-spec.js';
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
  /**
   * Arguments the platform binds and the model never sees, from an inline definition's
   * `fixedArgs`. Empty for a registered tool.
   */
  fixedArgs?: Record<string, unknown>;
  /**
   * The template this tool was instantiated from, when it was (§18.5).
   *
   * Its authority came from a grant on the TEMPLATE, checked at instantiation. Asking for
   * a second grant on the resulting row would defeat the whole mechanism: the row did not
   * exist when the grant was written, and granting each one individually is exactly the
   * registration step inline definitions exist to remove.
   */
  viaTemplate?: string;
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

    // A spec's tools split two ways: refs to select, and inline definitions to
    // instantiate (§18.5). Both end up as rows in `tools`; only the second creates one.
    const toolRefs = spec.tools.filter((t): t is string => typeof t === 'string');
    const inlineTools = spec.tools.filter((t): t is InlineToolSpec => typeof t !== 'string');

    const { instantiated, rejections: inlineRejections } = inlineTools.length
      ? await this.instantiate(input, inlineTools)
      : { instantiated: [] as AdmittedTool[], rejections: [] as string[] };
    rejections.push(...inlineRejections);

    const tools = toolRefs.length
      ? await this.db
          .selectFrom('tools')
          // ::text[] deliberately: pg cannot parse a custom enum array OID and hands back
          // the literal '{a,b}' string, on which Array methods silently do not exist.
          .select((eb) => [
            'id', 'ref', 'status',
            sql<EffectClass[]>`default_effects::text[]`.as('default_effects'),
          ])
          .where('org_id', '=', input.orgId)
          .where('ref', 'in', toolRefs)
          .execute()
      : [];

    const found = new Map(tools.map((t) => [t.ref, t]));
    for (const ref of toolRefs) {
      const tool = found.get(ref);
      if (!tool) rejections.push(`tools: "${ref}" is not in the tool registry`);
      else if (tool.status !== 'active') rejections.push(`tools: "${ref}" is ${tool.status}`);
    }
    checks['tools'] = `${found.size + instantiated.length}/${spec.tools.length}`;

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
    const admitted = new Map<string, AdmittedTool>([
      ...[...found.values()].map(
        (t) => [t.ref, { ref: t.ref, id: t.id, effects: t.default_effects }] as const,
      ),
      // Instantiated tools join the same map, so everything downstream -- the grant check,
      // the policy verdict, the binding -- treats them identically to a registered one.
      // They are only different in where their row came from.
      ...instantiated.map((t) => [t.ref, t] as const),
    ]);
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
      // An instantiated tool was authorised by its TEMPLATE's grant, already checked. The
      // row is younger than any grant that could name it.
      if (tool.viaTemplate) continue;
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

  /**
   * Turns inline tool definitions into rows, under a template the caller may use.
   *
   * ## The rule this method exists to enforce
   *
   * The spec supplies the SHAPE -- name, description, argument schema, path, placement.
   * The template supplies the CONTRACT -- effects, residency, sandbox profile, timeout --
   * and the origin. Nothing a caller writes can reach the second list.
   *
   * That is not fussiness. If a spec could declare its own effects it would mark a payment
   * tool `read_only`, which skips the §14 approval gate, permits caching under §10, and
   * removes the idempotency key §4.5 requires. Every control downstream reads the effect
   * array and believes it.
   *
   * ## What is checked, and why each one matters
   *
   * - **The grant is on the TEMPLATE.** Same check, same table, same revocation path as a
   *   tool grant; only the resource kind differs. Revoking it stops the next admission.
   * - **The method is in the template's set.** A template that permits GET must not become
   *   a DELETE by instantiation.
   * - **The path sits under the prefix.** With `{name}` expanding to ONE percent-encoded
   *   segment, an argument cannot add a segment the template did not declare -- so the
   *   prefix holds at call time, not merely at admission.
   * - **`fixedArgs` may not name a path variable.** Otherwise a pinned value silently
   *   loses to the template expansion and the author believes something is bound that is
   *   not.
   * - **A count ceiling.** Four hundred tools in one context is an accuracy problem that
   *   looks like a model problem.
   */
  private async instantiate(
    input: AdmissionInput,
    inline: InlineToolSpec[],
  ): Promise<{ instantiated: AdmittedTool[]; rejections: string[] }> {
    const rejections: string[] = [];
    const instantiated: AdmittedTool[] = [];

    const templates = await this.db
      .selectFrom('tool_templates')
      .select((eb) => [
        'id', 'ref', 'version', 'status', 'endpoint_url', 'path_prefix',
        'allowed_methods', 'residency', 'sandbox_profile', 'timeout_ms', 'max_retries',
        'static_headers', 'max_instances', 'namespace_id',
        // ::text[] deliberately, for the same reason as `tools` above: pg hands back the
        // literal '{a,b}' for a custom enum array and Array methods silently do not exist.
        sql<EffectClass[]>`default_effects::text[]`.as('default_effects'),
      ])
      .where('org_id', '=', input.orgId)
      .where('namespace_id', '=', input.namespaceId)
      .execute();

    const perTemplate = new Map<string, number>();

    for (const def of inline) {
      const [ref, pinned] = def.template.split('@');
      const candidates = templates.filter((t) => t.ref.toLowerCase() === ref!.toLowerCase());
      const template = pinned
        ? candidates.find((t) => t.version === Number(pinned))
        : candidates.sort((a, b) => b.version - a.version)[0];

      if (!template) {
        rejections.push(`tools: no tool template "${def.template}" in this namespace`);
        continue;
      }
      if (template.status !== 'active') {
        rejections.push(`tools: tool template "${def.template}" is ${template.status}`);
        continue;
      }
      if (!(await this.hasGrant(input, 'tool_template', template.id))) {
        rejections.push(`tools: no capability grant for tool template "${template.ref}"`);
        continue;
      }

      const used = (perTemplate.get(template.id) ?? 0) + 1;
      perTemplate.set(template.id, used);
      if (used > template.max_instances) {
        rejections.push(
          `tools: template "${template.ref}" allows ${template.max_instances} inline tools ` +
            `per spec; this spec defines more`,
        );
        continue;
      }

      const method = def.method ?? (template.allowed_methods[0] as string);
      if (!template.allowed_methods.includes(method)) {
        rejections.push(
          `tools: "${def.name}" uses ${method}, which template "${template.ref}" does not ` +
            `allow (${template.allowed_methods.join(', ')})`,
        );
        continue;
      }

      const path = def.pathTemplate ?? template.path_prefix;
      if (!path.startsWith(template.path_prefix)) {
        rejections.push(
          `tools: "${def.name}" targets "${path}", which is outside template ` +
            `"${template.ref}"'s prefix "${template.path_prefix}"`,
        );
        continue;
      }

      const pathVars = [...path.matchAll(/\{\+?([^}]+)\}/g)].map((m) => m[1]!);
      const clashing = Object.keys(def.fixedArgs).filter((k) => pathVars.includes(k));
      if (clashing.length > 0) {
        // Refused rather than resolved either way: the template expansion would win, and
        // an author who pinned a value and saw it ignored has no way to find out.
        rejections.push(
          `tools: "${def.name}" fixes ${clashing.join(', ')}, which the path template also ` +
            `expands. Fix it in the path or in fixedArgs, not both`,
        );
        continue;
      }

      if (rejections.length > 0) continue;

      instantiated.push(await this.materialise(input, def, template, method, path));
    }

    return { instantiated, rejections };
  }

  /**
   * Writes the instantiated tool row, or finds the one an identical spec already wrote.
   *
   * Content-addressed on the shape, so ap-executor issuing the same node configuration ten
   * thousand times gets ONE row, one cache key and one line in the catalogue -- the same
   * reasoning §18.1 applies to ephemeral agent versions, for the same cardinality reason.
   *
   * `version` is the next free one for this ref rather than part of the hash: the ref is
   * what the MODEL sees, so two callers choosing the same name for different shapes must
   * both keep the name they chose.
   */
  private async materialise(
    input: AdmissionInput,
    def: InlineToolSpec,
    template: { id: string; endpoint_url: string; residency: 'internal' | 'external';
                sandbox_profile: string; timeout_ms: number; max_retries: number;
                static_headers: unknown; default_effects: EffectClass[] },
    method: string,
    path: string,
  ): Promise<AdmittedTool> {
    // The template's identity is IN the hash: the same shape under a different contract is
    // a different tool, and collapsing them would let a re-pointed template silently
    // inherit rows admitted under the old one.
    const specHash = stableHash({
      template: template.id,
      name: def.name,
      description: def.description,
      schema: def.inputSchema,
      method,
      path,
      placement: def.argPlacement,
      // In the hash because it changes the REQUEST, not just the presentation: the same fields
      // nested under a key and sent flat are two different calls. Omitting it would collapse them
      // onto one row and serve whichever was admitted first.
      wrapper: def.argWrapperKey,
    });

    const existing = await this.db
      .selectFrom('tools')
      .select('id')
      .where('org_id', '=', input.orgId)
      .where('spec_hash', '=', specHash)
      .executeTakeFirst();

    const id =
      existing?.id ??
      (
        await this.db
          .insertInto('tools')
          .values({
            org_id: input.orgId,
            namespace_id: input.namespaceId,
            ref: def.name,
            version: sql<number>`(SELECT coalesce(max(version), 0) + 1 FROM tools
                                   WHERE org_id = ${input.orgId} AND ref = ${def.name})`,
            origin: 'http',
            description: def.description,
            input_schema: JSON.stringify(def.inputSchema),
            // FROM THE TEMPLATE, every one of them. This block is the security boundary.
            default_effects: sql`${template.default_effects}::effect_class[]`,
            residency: template.residency,
            sandbox_profile: template.sandbox_profile,
            timeout_ms: template.timeout_ms,
            max_retries: template.max_retries,
            endpoint_url: template.endpoint_url,
            static_headers: JSON.stringify(template.static_headers ?? {}),
            // From the spec: the shape of the call, and nothing else.
            http_method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
            path_template: path,
            arg_wrapper_key: def.argWrapperKey,
            arg_placement: def.argPlacement,
            template_id: template.id,
            spec_hash: specHash,
          })
          .onConflict((oc) =>
            // A concurrent admission of the identical shape. DO UPDATE rather than DO
            // NOTHING so RETURNING yields a row either way.
            oc.columns(['org_id', 'spec_hash']).doUpdateSet({ spec_hash: specHash }),
          )
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;

    return {
      ref: def.name,
      id,
      effects: template.default_effects,
      fixedArgs: def.fixedArgs,
      viaTemplate: template.id,
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
