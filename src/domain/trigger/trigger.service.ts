import { Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import { DB, POOL } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { withTenantConnection } from '../../platform/persistence/tenant-connection.js';
import { runInContext } from '../../platform/context/platform-context.js';
import { RunService } from '../run-engine/run.service.js';
import { AgentService } from '../agent/agent.service.js';
import { NotFound } from '../errors/platform.errors.js';
import { newId } from '../../platform/ids.js';
import { matchesCron } from './cron.js';

/**
 * §18.2. Generic execution triggers -- NOT business scheduling.
 *
 * The platform turns an HTTP request, an event, a schedule or a callback into a Run.
 * Campaign orchestration, calling windows, consent checks and retry cadence stay in the
 * consuming service, which is why this file has no concept of any of them.
 */
@Injectable()
export class TriggerService {
  private readonly log = new Logger(TriggerService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(POOL) private readonly pool: pg.Pool,
    private readonly runs: RunService,
    private readonly agents: AgentService,
  ) {}

  async attach(input: {
    agentId: string;
    type: 'webhook' | 'schedule' | 'event';
    tenantRef: string;
    webhookPath?: string;
    cronExpression?: string;
    eventSource?: string;
    eventType?: string;
    pinnedVersionId?: string | null;
    delivery?: { webhookUrl: string } | null;
  }) {
    return this.db
      .insertInto('triggers')
      .values({
        agent_id: input.agentId,
        trigger_type: input.type,
        tenant_ref: input.tenantRef,
        webhook_path: input.webhookPath ?? null,
        cron_expression: input.cronExpression ?? null,
        event_source: input.eventSource ?? null,
        event_type: input.eventType ?? null,
        // Null means "whatever version is current when it fires". Pinning is what a
        // caller does when a schedule must not silently start running new behaviour.
        pinned_version_id: input.pinnedVersionId ?? null,
        config: JSON.stringify(input.delivery ? { delivery: input.delivery } : {}),
        enabled: true,
      })
      .returning(['id', 'trigger_type', 'webhook_path', 'cron_expression', 'enabled'])
      .executeTakeFirstOrThrow();
  }

  async listForAgent(agentId: string) {
    return this.db
      .selectFrom('triggers')
      .select(['id', 'trigger_type', 'webhook_path', 'cron_expression', 'tenant_ref', 'enabled', 'config'])
      .where('agent_id', '=', agentId)
      .orderBy('created_at')
      .execute();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.updateTable('triggers').set({ enabled }).where('id', '=', id).execute();
  }

  async byWebhookPath(path: string) {
    const row = await this.db
      .selectFrom('triggers as t')
      .innerJoin('agents as a', 'a.id', 't.agent_id')
      .select([
        't.id', 't.agent_id', 't.pinned_version_id', 't.tenant_ref', 't.enabled',
        't.config', 'a.org_id', 'a.namespace_id',
      ])
      .where('t.webhook_path', '=', path)
      .executeTakeFirst();
    if (!row || !row.enabled) throw new NotFound('trigger', path);
    return row;
  }

  /**
   * Fires a trigger.
   *
   * A trigger has no caller, so it supplies its own context -- and `authorizingHumanId`
   * is deliberately null rather than absent. §0.1 wants "which human authorized this"
   * answerable, and for an unattended firing the honest answer is "nobody at run time;
   * the publisher of this trigger". Recording null says that; omitting the field would
   * make an unattended run indistinguishable from an interactive one.
   */
  async fire(
    trigger: {
      id: string;
      agent_id: string;
      pinned_version_id: string | null;
      tenant_ref: string | null;
      org_id: string;
      namespace_id: string;
      config: unknown;
    },
    input: unknown,
    initiator: 'trigger' | 'schedule',
    idempotencyKey?: string,
  ): Promise<{ runId: string }> {
    const tenantRef = trigger.tenant_ref;
    if (!tenantRef) throw new NotFound('tenant for trigger', trigger.id);

    // §5.2 RLS: a webhook-fired trigger reaches here with no request-scoped pin at all --
    // `v1/triggers` sits deliberately outside ContextMiddleware, since an external
    // webhook caller has no identity headers. A scheduler-fired trigger IS already inside
    // a bypass-scoped pin (SchedulerService.guarded); withTenantConnection nests, so that
    // call reuses it rather than acquiring a second connection.
    return withTenantConnection(this.pool, { orgId: trigger.org_id }, () => this.doFire(trigger, input, initiator, idempotencyKey));
  }

  private async doFire(
    trigger: {
      id: string;
      agent_id: string;
      pinned_version_id: string | null;
      tenant_ref: string | null;
      org_id: string;
      namespace_id: string;
      config: unknown;
    },
    input: unknown,
    initiator: 'trigger' | 'schedule',
    idempotencyKey?: string,
  ): Promise<{ runId: string }> {
    const tenantRef = trigger.tenant_ref!;

    // A pinned trigger bypasses deployment routing entirely -- it named an exact version
    // because a schedule must not silently start running new behaviour (§18.2), and that
    // intent excludes canary and shadow just as it excludes "whatever is latest".
    const routed = trigger.pinned_version_id
      ? { versionId: trigger.pinned_version_id, shadowFromVersionId: null }
      : await this.agents.currentVersionId(trigger.agent_id);

    const principal = await this.db
      .selectFrom('principals')
      .select('id')
      .where('org_id', '=', trigger.org_id)
      .where('kind', '=', 'service')
      .orderBy('created_at')
      .limit(1)
      .executeTakeFirstOrThrow();

    const config = (trigger.config ?? {}) as { delivery?: { webhookUrl: string } };

    return runInContext(
      {
        orgId: trigger.org_id,
        namespaceId: trigger.namespace_id,
        tenantRef,
        callerPrincipalId: principal.id,
        onBehalfOfPrincipalId: null,
        authorizingHumanId: null,
        delegationChain: [],
        traceId: newId(),
        correlationId: newId(),
      },
      async () => {
        const run = await this.runs.createFromVersionWithShadow({
          agentVersionId: routed.versionId,
          shadowFromVersionId: routed.shadowFromVersionId,
          input,
          initiator,
          triggerId: trigger.id,
          idempotencyKey: idempotencyKey ?? null,
          delivery: config.delivery ?? null,
        });
        return { runId: run.runId };
      },
    );
  }

  /**
   * Fires every schedule matching this minute.
   *
   * The idempotency key is the trigger plus the minute, so a scheduler restart inside the
   * same minute cannot double-fire -- at-least-once dispatch becomes effectively-once
   * creation (§4.5).
   */
  async dispatchSchedules(at: Date): Promise<number> {
    const rows = await this.db
      .selectFrom('triggers as t')
      .innerJoin('agents as a', 'a.id', 't.agent_id')
      .select([
        't.id', 't.agent_id', 't.pinned_version_id', 't.tenant_ref', 't.config',
        't.cron_expression', 'a.org_id', 'a.namespace_id',
      ])
      .where('t.trigger_type', '=', 'schedule')
      .where('t.enabled', '=', true)
      .execute();

    const minute = at.toISOString().slice(0, 16);
    let fired = 0;

    for (const row of rows) {
      if (!row.cron_expression) continue;
      let due = false;
      try {
        due = matchesCron(row.cron_expression, at);
      } catch (e) {
        // A malformed expression must not stop every other schedule in the system.
        this.log.error(`trigger ${row.id} has an invalid cron: ${(e as Error).message}`);
        continue;
      }
      if (!due) continue;

      try {
        await this.fire(row, { firedAt: at.toISOString() }, 'schedule', `sched:${row.id}:${minute}`);
        fired += 1;
      } catch (e) {
        this.log.error(`trigger ${row.id} failed to fire: ${(e as Error).message}`);
      }
    }
    return fired;
  }
}
