import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { AdmissionService } from '../admission/admission.service.js';
import { AgentVersionService } from '../registry/agent-version.service.js';
import { DeploymentService, type Environment } from '../eval/deployment.service.js';
import { AdmissionRejected, NotFound, PlatformError } from '../errors/platform.errors.js';

export interface RoutedVersion {
  versionId: string;
  /** §15.5: set when the resolved deployment is shadowing another version. */
  shadowFromVersionId: string | null;
}

@Injectable()
export class AgentService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly admission: AdmissionService,
    private readonly versions: AgentVersionService,
    private readonly deployments: DeploymentService,
  ) {}

  /**
   * Registers an agent, or publishes a new version of one.
   *
   * Admission runs on every publish, not only the first: a spec that was admissible last
   * month may name a tool whose grant has since been revoked, and §17.5 wants that refused
   * at publish rather than discovered at run time.
   */
  async publish(input: { name: string; owner: string; spec: unknown; exposeAsPeer?: boolean }) {
    const ctx = requireContext();
    const admission = await this.admission.admit({
      orgId: ctx.orgId,
      namespaceId: ctx.namespaceId,
      callerPrincipalId: ctx.callerPrincipalId,
      rawSpec: input.spec,
    });

    return this.uow.run(async (tx) => {
      const agent = await tx
        .insertInto('agents')
        .values({
          org_id: ctx.orgId,
          namespace_id: ctx.namespaceId,
          name: input.name,
          owner: input.owner,
          expose_as_peer: input.exposeAsPeer ?? false,
        })
        .onConflict((oc) =>
          oc.columns(['namespace_id', 'name']).doUpdateSet({ owner: input.owner, updated_at: new Date() }),
        )
        .returning(['id', 'name'])
        .executeTakeFirstOrThrow();

      const version = await this.versions.materialiseRegistered({
        tx,
        agentId: agent.id,
        orgId: ctx.orgId,
        namespaceId: ctx.namespaceId,
        workloadIdentityId: ctx.callerPrincipalId,
        createdBy: ctx.callerPrincipalId,
        admission,
      });

      return { agentId: agent.id, name: agent.name, versionId: version.id };
    });
  }

  async get(name: string) {
    const ctx = requireContext();
    const agent = await this.db
      .selectFrom('agents')
      .select(['id', 'name', 'owner', 'expose_as_peer', 'created_at'])
      .where('namespace_id', '=', ctx.namespaceId)
      .where('name', '=', name)
      .executeTakeFirst();
    if (!agent) throw new NotFound('agent', name);

    const versions = await this.db
      .selectFrom('agent_versions')
      .select(['id', 'version', 'durability', 'data_class', 'created_at'])
      .where('agent_id', '=', agent.id)
      .orderBy('version', 'desc')
      .execute();

    return { ...agent, versions };
  }

  async list() {
    const ctx = requireContext();
    return this.db
      .selectFrom('agents')
      .select(['id', 'name', 'owner', 'created_at'])
      .where('namespace_id', '=', ctx.namespaceId)
      .where('archived_at', 'is', null)
      .orderBy('name')
      .execute();
  }

  /**
   * Publishes a new version of an agent that must already exist.
   *
   * The difference from `publish` is only the missing-agent case, and it is the point:
   * `POST` creates-or-updates, so a typo in the name silently registers a second agent
   * nobody meant to create. `PUT` says "I expect this to exist" and gets a 404.
   */
  async replace(input: { name: string; owner?: string; spec: unknown; exposeAsPeer?: boolean }) {
    const existing = await this.get(input.name);
    return this.publish({
      name: input.name,
      owner: input.owner ?? existing.owner,
      spec: input.spec,
      ...(input.exposeAsPeer !== undefined ? { exposeAsPeer: input.exposeAsPeer } : {}),
    });
  }

  /**
   * Admission dry-run (§17.5).
   *
   * Returns every rejection at once and never a narrowed spec. §17.5's rule is that a
   * spec requesting an ungranted capability is refused rather than quietly filtered down
   * to what is permitted — so this reports what WOULD be admitted alongside the refusals,
   * and an author can see both without publishing anything.
   */
  async validate(spec: unknown): Promise<Record<string, unknown>> {
    const ctx = requireContext();
    try {
      const admission = await this.admission.admit({
        orgId: ctx.orgId,
        namespaceId: ctx.namespaceId,
        callerPrincipalId: ctx.callerPrincipalId,
        rawSpec: spec,
      });
      return {
        admissible: true,
        specHash: admission.specHash,
        resolved: {
          model: admission.spec.model.ref,
          tools: admission.toolIds.map((t) => t.ref),
          skills: admission.skills.map((sk) => `${sk.name}@${sk.version}`),
          collections: admission.collectionIds.map((c) => c.name),
          subAgents: admission.subAgentIds.map((a) => a.name),
          peers: admission.peers.map((p) => p.name),
        },
        note:
          'Nothing was published. The spec hash is what a publish would produce, so an ' +
          'unchanged hash means an unchanged version.',
      };
    } catch (e) {
      if (e instanceof AdmissionRejected) {
        // A dry-run that FAILED is still a successful answer to the question asked, so it
        // is returned rather than thrown -- a 422 here would make CI treat "the spec is
        // wrong" as "the validate endpoint is broken".
        return { admissible: false, rejections: e.rejections };
      }
      throw e;
    }
  }

  async listVersions(name: string) {
    const agent = await this.get(name);
    return this.db
      .selectFrom('agent_versions')
      .select([
        'id', 'version', 'spec_hash', 'durability', 'data_class', 'transport',
        'max_steps', 'max_cost_micros', 'created_by', 'created_at',
      ])
      .where('agent_id', '=', agent.id)
      .orderBy('version', 'desc')
      .execute();
  }

  /** One materialised spec, exactly as admitted — the immutable record of what runs. */
  async getVersion(name: string, version: number) {
    const agent = await this.get(name);
    const row = await this.db
      .selectFrom('agent_versions')
      .select([
        'id', 'version', 'spec', 'spec_hash', 'durability', 'data_class',
        'max_steps', 'max_cost_micros', 'created_at',
      ])
      .where('agent_id', '=', agent.id)
      .where('version', '=', version)
      .executeTakeFirst();
    if (!row) throw new NotFound('agent version', `${name}@${version}`);
    return row;
  }

  /**
   * The reconciler status subresource (§17.7).
   *
   * Desired state is the spec; this is OBSERVED state, and the two are reported
   * separately because the whole value of a status subresource is that it can disagree
   * with the declaration. Conditions rather than one status string, for the same reason:
   * "not ready" is useless without which of several reasons it is.
   */
  async status(name: string): Promise<Record<string, unknown>> {
    const ctx = requireContext();
    const agent = await this.get(name);

    const latest = agent.versions[0];
    const deployments = await this.db
      .selectFrom('deployments as d')
      .leftJoin('agent_versions as v', 'v.id', 'd.agent_version_id')
      .leftJoin('eval_runs as e', 'e.id', 'd.promotion_eval_run_id')
      .select([
        'd.environment', 'd.agent_version_id', 'v.version', 'd.canary_percent',
        'd.state', 'd.promoted_at', 'd.gate_override_reason', 'e.score as eval_score',
      ])
      .where('d.agent_id', '=', agent.id)
      .where('d.state', 'in', ['active', 'rolling'])
      .execute();

    const triggers = await this.db
      .selectFrom('triggers')
      .select(({ fn }) => [fn.countAll<string>().as('n')])
      .where('agent_id', '=', agent.id)
      .where('enabled', '=', true)
      .executeTakeFirst();

    const recent = await this.db
      .selectFrom('runs as r')
      .innerJoin('agent_versions as v', 'v.id', 'r.agent_version_id')
      .select(({ fn }) => [
        'r.status',
        fn.countAll<string>().as('n'),
      ])
      .where('v.agent_id', '=', agent.id)
      .where('r.created_at', '>', sql<Date>`now() - interval '24 hours'`)
      .groupBy('r.status')
      .execute();

    const byStatus = Object.fromEntries(recent.map((r) => [r.status, Number(r.n)]));
    const failed = (byStatus['failed'] ?? 0) + (byStatus['dead_letter'] ?? 0);
    const total = Object.values(byStatus).reduce((t, n) => t + n, 0);

    const conditions: { type: string; status: 'true' | 'false' | 'unknown'; reason: string }[] = [];

    conditions.push(
      latest
        ? { type: 'VersionPublished', status: 'true', reason: `v${latest.version} is the latest` }
        : { type: 'VersionPublished', status: 'false', reason: 'no version has been published' },
    );

    conditions.push(
      deployments.length > 0
        ? {
            type: 'Deployed',
            status: 'true',
            reason: deployments.map((d) => `${d.environment}=v${d.version} (${d.state})`).join(', '),
          }
        : { type: 'Deployed', status: 'false', reason: 'not deployed to any environment' },
    );

    // Drift, stated as its own condition. "Deployed" being true says nothing about
    // whether what is deployed is what was last published, and that gap is the single
    // most common source of "but I fixed that".
    const drifted = deployments.filter((d) => latest && d.agent_version_id !== latest.id);
    if (drifted.length > 0) {
      conditions.push({
        type: 'DeployedVersionCurrent',
        status: 'false',
        reason:
          `v${latest?.version} is published but ` +
          drifted.map((d) => `${d.environment} serves v${d.version}`).join(', '),
      });
    } else if (deployments.length > 0) {
      conditions.push({ type: 'DeployedVersionCurrent', status: 'true', reason: 'deployed version is the latest' });
    }

    const gateOverridden = deployments.filter((d) => d.gate_override_reason !== null);
    if (gateOverridden.length > 0) {
      conditions.push({
        type: 'EvalGateSatisfied',
        status: 'false',
        reason: `promoted past the gate: ${gateOverridden.map((d) => d.gate_override_reason).join('; ')}`,
      });
    }

    conditions.push(
      total === 0
        ? { type: 'Healthy', status: 'unknown', reason: 'no runs in the last 24 hours' }
        : failed / total > 0.1
          ? { type: 'Healthy', status: 'false', reason: `${failed}/${total} runs failed in 24h` }
          : { type: 'Healthy', status: 'true', reason: `${failed}/${total} runs failed in 24h` },
    );

    return {
      name: agent.name,
      observed: {
        latestVersion: latest?.version ?? null,
        latestVersionId: latest?.id ?? null,
        deployments,
        enabledTriggers: Number(triggers?.n ?? 0),
        exposedAsPeer: agent.expose_as_peer,
        runsLast24h: byStatus,
      },
      conditions,
      // One boolean for a dashboard, derived from the conditions rather than computed
      // separately -- two independent readiness calculations would eventually disagree.
      ready: conditions.every((c) => c.type === 'Healthy' || c.status === 'true'),
      namespaceId: ctx.namespaceId,
    };
  }

  /**
   * Archives an agent (§17.4). Never deletes.
   *
   * `agent_versions.agent_id` is ON DELETE RESTRICT, and that is deliberate: runs,
   * deployments and eval runs all point at versions, so deleting the agent would take
   * the history that explains them. Archiving hides it from listings and stops new
   * versions; everything already recorded stays readable.
   */
  async archive(name: string): Promise<Record<string, unknown>> {
    const agent = await this.get(name);

    const active = await this.db
      .selectFrom('deployments')
      .select(['environment', 'state'])
      .where('agent_id', '=', agent.id)
      .where('state', 'in', ['active', 'rolling'])
      .execute();
    if (active.length > 0) {
      // Refused rather than cascading. Archiving something that is currently serving
      // traffic is almost always a mistake, and the retirement should be explicit.
      throw new PlatformError('invalid_transition', 'Agent is still deployed', {
        deployments: active,
        hint: 'Roll back or retire the deployment first',
      });
    }

    const running = await this.db
      .selectFrom('runs as r')
      .innerJoin('agent_versions as v', 'v.id', 'r.agent_version_id')
      .select(({ fn }) => [fn.countAll<string>().as('n')])
      .where('v.agent_id', '=', agent.id)
      .where('r.status', 'in', ['queued', 'running', 'tool_execution', 'checkpointed', 'waiting'])
      .executeTakeFirst();

    await this.db
      .updateTable('agents')
      .set({ archived_at: new Date(), updated_at: new Date() })
      .where('id', '=', agent.id)
      .execute();

    return {
      archived: agent.name,
      // Reported, not blocked on. An in-flight run finishes on the version it started
      // with -- versions are immutable, so archiving the agent cannot change what it does.
      inFlightRuns: Number(running?.n ?? 0),
      note: 'Archived, not deleted: runs, deployments and eval runs still reference its versions.',
    };
  }

  /**
   * The version a trigger or a run should bind to when none is pinned (§15.5).
   *
   * Consults the deployment for `environment` first: an agent that IS deployed there is
   * routed by canary split and may carry a shadow. An agent with no deployment for that
   * environment (most agents, most of the time) falls back to "latest published version"
   * -- the only sane default for something nobody has explicitly deployed anywhere.
   */
  async currentVersionId(agentId: string, environment: Environment = 'production'): Promise<RoutedVersion> {
    const routed = await this.deployments.resolveTraffic(agentId, environment);
    if (routed) return routed;

    const row = await this.db
      .selectFrom('agent_versions')
      .select('id')
      .where('agent_id', '=', agentId)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) throw new NotFound('agent version for agent', agentId);
    return { versionId: row.id, shadowFromVersionId: null };
  }
}
