import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { EventLog } from '../event-log/event-log.service.js';
import { EventType } from '../event-log/taxonomy.js';
import { QueueService } from '../queue/queue.service.js';
import { CapabilityDenied, NotFound, PlatformError } from '../errors/platform.errors.js';

export interface RespondInput {
  interactionId: string;
  approved: boolean;
  response?: Record<string, unknown>;
}

/**
 * §14. HITL is a platform primitive: the platform owns the durable state, authorization,
 * routing, auditing and lifecycle of the interaction, whatever channel the human is on.
 */
@Injectable()
export class InteractionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly events: EventLog,
    private readonly queue: QueueService,
  ) {}

  async list(status?: string, mineOnly = false) {
    const ctx = requireContext();
    let q = this.db
      .selectFrom('interactions')
      .select([
        'id', 'run_id', 'thread_id', 'kind', 'status', 'prompt', 'expires_at', 'created_at',
        'originating_run_id', 'required_authorization', 'delegation_chain',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .orderBy('created_at', 'desc')
      .limit(100);
    if (status) q = q.where('status', '=', status as 'pending');
    if (mineOnly) {
      // §14.3: an interaction raised five hops down is MINE if I am who it climbed to.
      // Filtering by the raising run would hide exactly the ones needing an answer.
      q = q.where((eb) =>
        eb.or([
          eb('originating_principal_id', '=', ctx.callerPrincipalId),
          eb('originating_principal_id', 'is', null),
        ]),
      );
    }
    return q.execute();
  }

  async get(id: string) {
    const ctx = requireContext();
    const row = await this.db
      .selectFrom('interactions')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFound('interaction', id);
    return row;
  }

  /**
   * Answers an interaction and returns its run to the queue.
   *
   * The run is set back to `queued` and re-enqueued rather than driven here: the API
   * process holds no run (§2.3), and resuming inline would mean a control-plane deploy
   * could interrupt execution.
   */
  async respond(input: RespondInput): Promise<{ runId: string; resumed: boolean }> {
    const ctx = requireContext();
    const interaction = await this.get(input.interactionId);

    if (interaction.status !== 'pending') {
      // Answering twice is not an error worth failing a caller over, but it must not
      // re-enqueue the run a second time.
      throw new PlatformError(
        'invalid_transition',
        `Interaction is already ${interaction.status}`,
        { status: interaction.status },
      );
    }
    if (new Date(interaction.expires_at) <= new Date()) {
      throw new PlatformError('invalid_transition', 'Interaction has expired', {
        expiredAt: interaction.expires_at,
      });
    }

    const required = (interaction.required_authorization ?? {}) as { principalId?: string };
    if (required.principalId && required.principalId !== ctx.callerPrincipalId) {
      // §16.2: who may answer is part of the interaction, and absence of the right is a
      // rejection rather than a silent no-op.
      throw new CapabilityDenied('interaction', input.interactionId);
    }

    const run = await this.db
      .selectFrom('runs')
      .select(['id', 'thread_id', 'agent_version_id', 'org_id', 'namespace_id', 'tenant_ref', 'status'])
      .where('id', '=', interaction.run_id)
      .executeTakeFirstOrThrow();

    await this.uow.run(async (tx) => {
      await tx
        .updateTable('interactions')
        .set({
          status: 'resolved',
          responder_principal_id: ctx.callerPrincipalId,
          response: JSON.stringify({ approved: input.approved, ...(input.response ?? {}) }),
          resolved_at: sql`now()`,
        })
        .where('id', '=', input.interactionId)
        .execute();

      await this.events.append(tx, {
        runId: run.id,
        threadId: run.thread_id,
        agentVersionId: run.agent_version_id,
        orgId: run.org_id,
        namespaceId: run.namespace_id,
        tenantRef: run.tenant_ref,
        type: EventType.InteractionResolved,
        payload: {
          interactionId: input.interactionId,
          approved: input.approved,
          responderPrincipalId: ctx.callerPrincipalId,
        },
      });

      if (run.status === 'waiting') {
        await tx.updateTable('runs').set({ status: 'queued' }).where('id', '=', run.id).execute();
        // Resumed work already holds durable state and an interrupted user journey. It
        // should not sit behind a fresh run when the pool is under pressure.
        await this.queue.enqueue(tx, run.id, { priority: 50 });
      }
    });

    if (run.status === 'waiting') await this.queue.notifyReady(this.db, run.id);
    return { runId: run.id, resumed: run.status === 'waiting' };
  }

  async cancel(id: string): Promise<void> {
    const interaction = await this.get(id);
    if (interaction.status !== 'pending') return;
    await this.uow.run(async (tx) => {
      await tx
        .updateTable('interactions')
        .set({ status: 'cancelled', resolved_at: sql`now()` })
        .where('id', '=', id)
        .execute();
      await tx
        .updateTable('runs')
        .set({
          status: 'failed',
          error: JSON.stringify({ message: 'Interaction cancelled' }),
          ended_at: sql`now()`,
        })
        .where('id', '=', interaction.run_id)
        .where('status', '=', 'waiting')
        .execute();
    });
  }
}
