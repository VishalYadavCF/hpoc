import { Inject, Injectable, Logger } from '@nestjs/common';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { AdmissionService } from '../admission/admission.service.js';
import { AgentVersionService } from '../registry/agent-version.service.js';
import { EventLog } from '../event-log/event-log.service.js';
import { EventType } from '../event-log/taxonomy.js';
import { QueueService } from '../queue/queue.service.js';
import { NotFound } from '../errors/platform.errors.js';
import type { RunStatus } from '../../platform/persistence/schema.types.js';

export interface DeliveryConfig {
  webhookUrl: string;
  headers?: Record<string, string>;
}

export interface CreateRunInput {
  spec: unknown;
  input: unknown;
  threadId?: string | null;
  idempotencyKey?: string | null;
  workloadIdentityId: string;
  delivery?: DeliveryConfig | null;
}

export interface CreateFromVersionInput {
  agentVersionId: string;
  input: unknown;
  threadId?: string | null;
  idempotencyKey?: string | null;
  initiator: 'trigger' | 'schedule' | 'api' | 'shadow';
  triggerId?: string | null;
  delivery?: DeliveryConfig | null;
  /** §15.5: set when this run is a shadow, linking it back to the run it shadows. */
  shadowOfRunId?: string | null;
}

export interface CreatedRun {
  runId: string;
  threadId: string;
  agentVersionId: string;
  status: RunStatus;
  reused: boolean;
}

@Injectable()
export class RunService {
  private readonly log = new Logger(RunService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly admission: AdmissionService,
    private readonly versions: AgentVersionService,
    private readonly events: EventLog,
    private readonly queue: QueueService,
  ) {}

  /**
   * One transaction, five writes, then two notifies.
   *
   * Anything less and a crash between them strands a run: a `runs` row with no queue
   * entry is invisible to every worker, and a queue entry with no first event is a run
   * whose history begins in the middle.
   */
  async create(input: CreateRunInput): Promise<CreatedRun> {
    const ctx = requireContext();

    // Idempotent run creation, so a caller's retry does not double-charge or
    // double-execute (§4.5). Checked before admission because admission is not free.
    if (input.idempotencyKey) {
      const existing = await this.db
        .selectFrom('runs')
        .select(['id', 'thread_id', 'agent_version_id', 'status'])
        .where('namespace_id', '=', ctx.namespaceId)
        .where('tenant_ref', '=', ctx.tenantRef)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (existing) {
        return {
          runId: existing.id,
          threadId: existing.thread_id,
          agentVersionId: existing.agent_version_id,
          status: existing.status,
          reused: true,
        };
      }
    }

    const admission = await this.admission.admit({
      orgId: ctx.orgId,
      namespaceId: ctx.namespaceId,
      callerPrincipalId: ctx.callerPrincipalId,
      rawSpec: input.spec,
    });

    const created = await this.uow.run(async (tx) => {
      const version = await this.versions.materialiseEphemeral({
        tx,
        orgId: ctx.orgId,
        namespaceId: ctx.namespaceId,
        workloadIdentityId: input.workloadIdentityId,
        admission,
      });

      const threadId =
        input.threadId ??
        (
          await tx
            .insertInto('threads')
            .values({
              org_id: ctx.orgId,
              namespace_id: ctx.namespaceId,
              tenant_ref: ctx.tenantRef,
              user_principal_id: ctx.onBehalfOfPrincipalId,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;

      const run = await tx
        .insertInto('runs')
        .values({
          thread_id: threadId,
          agent_version_id: version.id,
          org_id: ctx.orgId,
          namespace_id: ctx.namespaceId,
          tenant_ref: ctx.tenantRef,
          status: 'queued',
          durability: version.durability,
          initiator: 'api',
          caller_principal_id: ctx.callerPrincipalId,
          on_behalf_of_principal_id: ctx.onBehalfOfPrincipalId,
          // §0.1 — recorded even when null. A scheduled run with no interactive user is a
          // different security posture from an interactive one, and must say so rather
          // than omit the field.
          authorizing_human_id: ctx.authorizingHumanId,
          delegation_chain: JSON.stringify(ctx.delegationChain),
          idempotency_key: input.idempotencyKey ?? null,
          input: JSON.stringify(input.input ?? null),
          delivery: input.delivery ? JSON.stringify(input.delivery) : null,
          max_cost_micros: version.maxCostMicros,
          trace_id: ctx.traceId,
          correlation_id: ctx.correlationId,
        })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();

      await this.queue.enqueue(tx, run.id);

      await this.events.append(tx, {
        runId: run.id,
        threadId,
        agentVersionId: version.id,
        orgId: ctx.orgId,
        namespaceId: ctx.namespaceId,
        tenantRef: ctx.tenantRef,
        type: EventType.RunCreated,
        payload: { specHash: admission.specHash, framework: version.framework },
      });

      return { runId: run.id, threadId, agentVersionId: version.id, status: run.status };
    });

    // After commit, deliberately: a notify inside the transaction can reach a listener
    // before the row it announces is visible.
    await this.queue.notifyReady(this.db, created.runId);
    await this.events.notify(this.db, created.runId, 1);

    return { ...created, reused: false };
  }

  /**
   * Starts a run on an already-admitted version.
   *
   * Admission ran when the version was published, so it is not repeated per firing --
   * a schedule running every minute must not re-admit every minute. The version is
   * immutable, so what was admitted is exactly what will execute.
   */
  async createFromVersion(input: CreateFromVersionInput): Promise<CreatedRun> {
    const ctx = requireContext();

    if (input.idempotencyKey) {
      const existing = await this.db
        .selectFrom('runs')
        .select(['id', 'thread_id', 'agent_version_id', 'status'])
        .where('namespace_id', '=', ctx.namespaceId)
        .where('tenant_ref', '=', ctx.tenantRef)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (existing) {
        return {
          runId: existing.id, threadId: existing.thread_id,
          agentVersionId: existing.agent_version_id, status: existing.status, reused: true,
        };
      }
    }

    const version = await this.versions.load(this.db, input.agentVersionId);

    const created = await this.uow.run(async (tx) => {
      const threadId =
        input.threadId ??
        (
          await tx
            .insertInto('threads')
            .values({
              org_id: ctx.orgId, namespace_id: ctx.namespaceId,
              tenant_ref: ctx.tenantRef, user_principal_id: ctx.onBehalfOfPrincipalId,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;

      const run = await tx
        .insertInto('runs')
        .values({
          thread_id: threadId,
          agent_version_id: version.id,
          org_id: ctx.orgId,
          namespace_id: ctx.namespaceId,
          tenant_ref: ctx.tenantRef,
          status: 'queued',
          durability: version.durability,
          initiator: input.initiator,
          trigger_id: input.triggerId ?? null,
          shadow_of_run_id: input.shadowOfRunId ?? null,
          caller_principal_id: ctx.callerPrincipalId,
          on_behalf_of_principal_id: ctx.onBehalfOfPrincipalId,
          authorizing_human_id: ctx.authorizingHumanId,
          delegation_chain: JSON.stringify(ctx.delegationChain),
          idempotency_key: input.idempotencyKey ?? null,
          input: JSON.stringify(input.input ?? null),
          delivery: input.delivery ? JSON.stringify(input.delivery) : null,
          max_cost_micros: version.maxCostMicros,
          trace_id: ctx.traceId,
          correlation_id: ctx.correlationId,
        })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();

      await this.queue.enqueue(tx, run.id);
      await this.events.append(tx, {
        runId: run.id, threadId, agentVersionId: version.id,
        orgId: ctx.orgId, namespaceId: ctx.namespaceId, tenantRef: ctx.tenantRef,
        type: EventType.RunCreated,
        payload: { initiator: input.initiator, triggerId: input.triggerId ?? null },
      });

      return { runId: run.id, threadId, agentVersionId: version.id, status: run.status };
    });

    await this.queue.notifyReady(this.db, created.runId);
    await this.events.notify(this.db, created.runId, 1);
    return { ...created, reused: false };
  }

  /**
   * Creates the primary run and, when the resolved deployment named one, a shadow run
   * against `shadowFromVersionId` (§15.5).
   *
   * The shadow is its own thread and its own idempotency scope -- reusing the caller's
   * thread would put an execution the caller never asked for into their conversation
   * history, and reusing their idempotency key would collide with the primary run's
   * dedup entry. A shadow failing to start never fails the primary: shadowing is an
   * observability mechanism layered on top of serving traffic, not a precondition for it.
   */
  async createFromVersionWithShadow(
    input: CreateFromVersionInput & { shadowFromVersionId?: string | null },
  ): Promise<CreatedRun> {
    const { shadowFromVersionId, ...primaryInput } = input;
    const primary = await this.createFromVersion(primaryInput);

    if (shadowFromVersionId && !primary.reused) {
      try {
        await this.createFromVersion({
          agentVersionId: shadowFromVersionId,
          input: primaryInput.input,
          initiator: 'shadow',
          shadowOfRunId: primary.runId,
        });
      } catch (e) {
        this.log.warn(`shadow run for ${primary.runId} failed to start: ${(e as Error).message}`);
      }
    }

    return primary;
  }

  async get(runId: string) {
    const ctx = requireContext();
    const run = await this.db
      .selectFrom('runs')
      .selectAll()
      // Tenant predicates come from context, not arguments -- which is what makes §5.2
      // hold before row-level security is switched on in Phase 4.
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!run) throw new NotFound('run', runId);
    return run;
  }

  async listSteps(runId: string) {
    await this.get(runId);
    return this.db
      .selectFrom('steps')
      .select(['seq', 'kind', 'status', 'output', 'error', 'latency_ms', 'started_at', 'ended_at'])
      .where('run_id', '=', runId)
      .orderBy('seq', 'asc')
      .execute();
  }

  async cancel(runId: string): Promise<void> {
    const run = await this.get(runId);
    if (['completed', 'failed', 'cancelled', 'dead_letter'].includes(run.status)) return;
    await this.uow.run(async (tx) => {
      await tx
        .updateTable('runs')
        .set({ status: 'cancelled', ended_at: new Date() })
        .where('id', '=', runId)
        .execute();
      await this.events.append(tx, {
        runId,
        threadId: run.thread_id,
        agentVersionId: run.agent_version_id,
        orgId: run.org_id,
        namespaceId: run.namespace_id,
        tenantRef: run.tenant_ref,
        type: EventType.RunCancelled,
        payload: { requestedBy: requireContext().callerPrincipalId },
      });
      await this.queue.dequeue(tx, runId);
    });
  }
}
