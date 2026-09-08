import { Inject, Injectable, Logger } from '@nestjs/common';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { NotFound, PlatformError } from '../errors/platform.errors.js';

export type Environment = 'staging' | 'production';

export interface PromoteInput {
  agentName: string;
  environment: Environment;
  agentVersionId: string;
  canaryPercent?: number;
  /** Shadow this version against the one currently live, without serving it (§17.4). */
  shadowFromCurrent?: boolean;
  /** Only honoured when the gate itself allows an override, and always recorded. */
  overrideReason?: string;
}

export interface GateCheck {
  gated: boolean;
  passed: boolean;
  suiteRef?: string;
  minScore?: number;
  evalRunId?: string;
  score?: number;
  verdict?: string | null;
  reason: string;
}

/**
 * Deployments and the §15.5 promotion gate.
 *
 * §15.5's diagram — evaluate → gate → deploy (canary) → production feedback → promote or
 * rollback — is only real if the gate can REFUSE. So promotion looks for a passing eval
 * run for exactly this version against exactly the suite the gate names, and rejects
 * otherwise.
 *
 * Two properties are deliberate:
 *
 *  - **The eval run must name this version.** Not "a recent passing run for this agent" —
 *    that is the failure mode where v4 is promoted on v3's evidence, which is worse than
 *    no gate at all because it produces a green check for an untested artefact.
 *
 *  - **An ungated agent is reported as ungated, not as passing.** `gated: false` and
 *    `passed: true` are different facts, and collapsing them means nobody can ever
 *    enumerate which agents lack a gate.
 */
@Injectable()
export class DeploymentService {
  private readonly log = new Logger(DeploymentService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uow: UnitOfWork,
  ) {}

  async setGate(input: {
    agentName: string;
    environment: Environment;
    suiteRef: string;
    minScore?: number;
    allowOverride?: boolean;
  }): Promise<{ agentName: string; environment: Environment; suiteRef: string }> {
    const ctx = requireContext();
    const agent = await this.requireAgent(input.agentName);
    const suite = await this.db
      .selectFrom('eval_suites')
      .select(['id', 'ref'])
      .where('org_id', '=', ctx.orgId)
      .where('ref', '=', input.suiteRef)
      .executeTakeFirst();
    if (!suite) throw new NotFound('eval suite', input.suiteRef);

    await this.db
      .insertInto('promotion_gates')
      .values({
        org_id: ctx.orgId,
        agent_id: agent.id,
        environment: input.environment,
        eval_suite_id: suite.id,
        min_score: String(input.minScore ?? 0.7),
        allow_override: input.allowOverride ?? false,
      })
      .onConflict((oc) =>
        oc.columns(['agent_id', 'environment']).doUpdateSet({
          eval_suite_id: suite.id,
          min_score: String(input.minScore ?? 0.7),
          allow_override: input.allowOverride ?? false,
        }),
      )
      .execute();

    return { agentName: input.agentName, environment: input.environment, suiteRef: suite.ref };
  }

  /**
   * Evaluates the gate WITHOUT promoting.
   *
   * Exists so "would this promote?" is answerable before anyone tries. A gate that can
   * only be discovered by failing a deploy is a gate people learn to route around.
   */
  async checkGate(agentName: string, environment: Environment, agentVersionId: string): Promise<GateCheck> {
    const ctx = requireContext();
    const agent = await this.requireAgent(agentName);

    const gate = await this.db
      .selectFrom('promotion_gates as g')
      .innerJoin('eval_suites as s', 's.id', 'g.eval_suite_id')
      .select(['g.eval_suite_id', 'g.min_score', 'g.allow_override', 's.ref'])
      .where('g.agent_id', '=', agent.id)
      .where('g.environment', '=', environment)
      .executeTakeFirst();

    if (!gate) {
      return {
        gated: false,
        // Not `passed: true`. There is nothing to pass, and saying otherwise makes an
        // ungated agent indistinguishable from a verified one in any report.
        passed: false,
        reason:
          `No promotion gate is configured for "${agentName}" in ${environment}. ` +
          `Promotion is permitted but unverified (§15.5).`,
      };
    }

    const minScore = Number(gate.min_score);
    const best = await this.db
      .selectFrom('eval_runs')
      .select(['id', 'score', 'passed', 'verdict', 'ended_at'])
      .where('eval_suite_id', '=', gate.eval_suite_id)
      // THIS version. A run for a sibling version is evidence about a different artefact.
      .where('agent_version_id', '=', agentVersionId)
      .where('ended_at', 'is not', null)
      .orderBy('score', 'desc')
      .limit(1)
      .executeTakeFirst();

    if (!best) {
      return {
        gated: true,
        passed: false,
        suiteRef: gate.ref,
        minScore,
        reason:
          `No completed eval run of "${gate.ref}" exists for this version. ` +
          `Run the suite against it before promoting.`,
      };
    }

    const score = Number(best.score ?? 0);
    // The GATE's threshold, not the suite's. A gate may demand more of production than the
    // suite's own floor; taking the suite's would silently lower the bar the gate set.
    const passed = score >= minScore;
    return {
      gated: true,
      passed,
      suiteRef: gate.ref,
      minScore,
      evalRunId: best.id,
      score,
      verdict: best.verdict,
      reason: passed
        ? `Eval run scored ${score.toFixed(4)} against the gate's minimum of ${minScore}.`
        : `Eval run scored ${score.toFixed(4)}, below the gate's minimum of ${minScore}.`,
    };
  }

  async promote(input: PromoteInput): Promise<Record<string, unknown>> {
    const ctx = requireContext();
    const agent = await this.requireAgent(input.agentName);

    const version = await this.db
      .selectFrom('agent_versions')
      .select(['id', 'agent_id', 'version', 'lifetime'])
      .where('id', '=', input.agentVersionId)
      .executeTakeFirst();
    if (!version) throw new NotFound('agent version', input.agentVersionId);
    if (version.agent_id !== agent.id) {
      throw new PlatformError('admission_rejected', `Version does not belong to agent "${input.agentName}"`);
    }
    if (version.lifetime !== 'registered') {
      // An ephemeral version is anonymous and content-addressed; nothing can point at it
      // as "the deployed one", and a rollback target has to be nameable.
      throw new PlatformError('admission_rejected', 'Only a registered version can be deployed');
    }

    const gate = await this.checkGate(input.agentName, input.environment, input.agentVersionId);
    const gateRow = await this.db
      .selectFrom('promotion_gates')
      .select(['allow_override'])
      .where('agent_id', '=', agent.id)
      .where('environment', '=', input.environment)
      .executeTakeFirst();

    let overriddenBy: string | null = null;
    if (gate.gated && !gate.passed) {
      if (!input.overrideReason) {
        throw new PlatformError('admission_rejected', `Promotion blocked by the eval gate: ${gate.reason}`, {
          gate,
          hint: 'Run the suite against this version, or supply overrideReason if the gate allows it',
        });
      }
      if (!gateRow?.allow_override) {
        // An override the gate did not authorise is refused. A gate that anyone can talk
        // past by supplying a string is decoration.
        throw new PlatformError('capability_denied', `This gate does not permit overrides: ${gate.reason}`, { gate });
      }
      overriddenBy = ctx.callerPrincipalId;
      this.log.warn(
        `promotion gate overridden for ${input.agentName}/${input.environment}: ${input.overrideReason}`,
      );
    }

    return this.uow.run(async (tx) => {
      const live = await tx
        .selectFrom('deployments')
        .select(['id', 'agent_version_id', 'state'])
        .where('agent_id', '=', agent.id)
        .where('environment', '=', input.environment)
        .where('state', 'in', ['active', 'rolling'])
        .orderBy('created_at', 'desc')
        .execute();

      // The stable version being (partly) replaced, for the shadow link and the
      // response. Specifically the ACTIVE row, not merely the most recent live one: a
      // second canary on top of a first leaves both an `active` and a stale `rolling` row
      // live, and the STALE CANARY is more recent than the stable version it never
      // replaced. Shadowing or reporting "previous" as the canary that was still ramping
      // would compare the new version against an attempt nobody promoted, not the version
      // actually taking the remainder of traffic.
      const current = live.find((d) => d.state === 'active') ?? live[0];

      const isFullPromotion = (input.canaryPercent ?? 100) >= 100;
      for (const row of live) {
        // A full promotion (100%) retires everything live -- the new version now serves
        // all of it. A partial canary retires only a STALE `rolling` row (a second canary
        // is never valid -- §17.4's unique index over (agent, environment, state) forbids
        // two) and leaves `active` untouched: that row is what serves the remaining
        // (100 - canaryPercent)% while this one ramps. Retiring it here is the bug that
        // made canary_percent decorative -- there was nothing left to serve the rest.
        if (isFullPromotion || row.state === 'rolling') {
          await tx.updateTable('deployments').set({ state: 'retired' }).where('id', '=', row.id).execute();
        }
      }

      const deployment = await tx
        .insertInto('deployments')
        .values({
          agent_id: agent.id,
          environment: input.environment,
          agent_version_id: input.agentVersionId,
          canary_percent: input.canaryPercent ?? 100,
          shadow_from_version_id: input.shadowFromCurrent ? (current?.agent_version_id ?? null) : null,
          promotion_eval_run_id: gate.evalRunId ?? null,
          state: (input.canaryPercent ?? 100) < 100 ? 'rolling' : 'active',
          promoted_by: ctx.callerPrincipalId,
          promoted_at: new Date(),
          gate_overridden_by: overriddenBy,
          gate_override_reason: overriddenBy ? (input.overrideReason ?? null) : null,
        })
        .returning(['id', 'state', 'canary_percent'])
        .executeTakeFirstOrThrow();

      return {
        deploymentId: deployment.id,
        agent: input.agentName,
        environment: input.environment,
        agentVersionId: input.agentVersionId,
        version: version.version,
        state: deployment.state,
        canaryPercent: deployment.canary_percent,
        previousVersionId: current?.agent_version_id ?? null,
        gate,
        ...(overriddenBy ? { gateOverridden: true, overrideReason: input.overrideReason } : {}),
      };
    });
  }

  /**
   * Rolls back to the version that was live before the current one.
   *
   * Derived from deployment history rather than taken as a parameter: "roll back" during
   * an incident must not require someone to correctly recall a version id under pressure.
   */
  async rollback(agentName: string, environment: Environment): Promise<Record<string, unknown>> {
    const ctx = requireContext();
    const agent = await this.requireAgent(agentName);

    const history = await this.db
      .selectFrom('deployments')
      .select(['id', 'agent_version_id', 'state', 'promoted_at'])
      .where('agent_id', '=', agent.id)
      .where('environment', '=', environment)
      .orderBy('created_at', 'desc')
      .limit(10)
      .execute();

    const live = history.filter((d) => d.state === 'active' || d.state === 'rolling');
    const active = live[0];
    if (!active) throw new PlatformError('invalid_transition', `Nothing is deployed to ${environment}`);

    // Any version currently live is not a rollback target: rolling "back" to something
    // already serving is a no-op that would then collide with its own row.
    const liveVersions = new Set(live.map((d) => d.agent_version_id));
    const previous = history.find((d) => !liveVersions.has(d.agent_version_id));
    if (!previous) {
      throw new PlatformError('invalid_transition', 'No earlier version to roll back to', {
        hint: 'This is the first deployment to this environment',
      });
    }

    return this.uow.run(async (tx) => {
      // Every live row is rolled back, for the same reason promote retires every live row.
      for (const row of live) {
        await tx.updateTable('deployments').set({ state: 'rolled_back' }).where('id', '=', row.id).execute();
      }

      // A NEW row rather than reactivating the old one. The deployment record is history:
      // reviving a retired row would erase the fact that a rollback happened, which is
      // exactly what a post-incident review needs to see.
      const restored = await tx
        .insertInto('deployments')
        .values({
          agent_id: agent.id,
          environment,
          agent_version_id: previous.agent_version_id,
          canary_percent: 100,
          state: 'active',
          promoted_by: ctx.callerPrincipalId,
          promoted_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      return {
        deploymentId: restored.id,
        rolledBackFrom: active.agent_version_id,
        rolledBackTo: previous.agent_version_id,
        environment,
      };
    });
  }

  /**
   * §15.5 traffic routing: which version actually serves the next call, and whether it
   * should be shadowed.
   *
   * During a genuine canary there are TWO live rows for one (agent, environment): the
   * `active` row still serving the remainder and the `rolling` row taking its declared
   * percentage (§17.4's schema comment on `deployments_active_uq`). `null` means the
   * agent has no deployment for this environment at all -- the caller falls back to
   * "latest published version", which is the only sane behaviour for an agent nobody has
   * deployed anywhere.
   */
  async resolveTraffic(
    agentId: string,
    environment: Environment,
  ): Promise<{ versionId: string; shadowFromVersionId: string | null } | null> {
    const rows = await this.db
      .selectFrom('deployments')
      .select(['agent_version_id', 'canary_percent', 'shadow_from_version_id', 'state'])
      .where('agent_id', '=', agentId)
      .where('environment', '=', environment)
      .where('state', 'in', ['active', 'rolling'])
      .execute();
    if (rows.length === 0) return null;

    const active = rows.find((r) => r.state === 'active') ?? null;
    const rolling = rows.find((r) => r.state === 'rolling') ?? null;

    // Both present: split by the ROLLING row's percentage, since that is what a canary
    // percentage means -- the share moving to the new version, not the share staying.
    // Only one present: it is serving everything, canary or not.
    const chosen =
      rolling && active
        ? Math.random() * 100 < rolling.canary_percent
          ? rolling
          : active
        : (rolling ?? active)!;

    return { versionId: chosen.agent_version_id, shadowFromVersionId: chosen.shadow_from_version_id };
  }

  async list(agentName: string) {
    const agent = await this.requireAgent(agentName);
    return this.db
      .selectFrom('deployments as d')
      .leftJoin('agent_versions as v', 'v.id', 'd.agent_version_id')
      .leftJoin('eval_runs as e', 'e.id', 'd.promotion_eval_run_id')
      .select([
        'd.id', 'd.environment', 'd.agent_version_id', 'v.version', 'd.canary_percent',
        'd.shadow_from_version_id', 'd.state', 'd.promoted_at',
        'd.gate_override_reason', 'e.score as eval_score', 'e.verdict as eval_verdict',
      ])
      .where('d.agent_id', '=', agent.id)
      .orderBy('d.created_at', 'desc')
      .limit(50)
      .execute();
  }

  private async requireAgent(name: string) {
    const ctx = requireContext();
    const agent = await this.db
      .selectFrom('agents')
      .select(['id', 'name'])
      .where('namespace_id', '=', ctx.namespaceId)
      .where('name', '=', name)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (!agent) throw new NotFound('agent', name);
    return agent;
  }
}
