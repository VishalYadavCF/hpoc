import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { QueueService } from '../queue/queue.service.js';
import { EventLog } from '../event-log/event-log.service.js';
import { EventType } from '../event-log/taxonomy.js';
import { NotFound, PlatformError } from '../errors/platform.errors.js';
import type { EffectClass } from '../../platform/persistence/schema.types.js';

export interface ForkInput {
  runId: string;
  /** Fork point. One of these; the checkpoint id is the precise form. */
  checkpointId?: string;
  atStepSeq?: number;
  /** Replaces the original input, for "what if it had been asked differently". */
  input?: unknown;
  /** Required when the original performed unreplayable effects past the fork point. */
  acknowledgeDuplicateEffects?: boolean;
}

export interface ForkPreview {
  forkPoint: { checkpointId: string; stepSeq: number };
  /** Effects the ORIGINAL performed after the fork point, which the fork will redo. */
  duplicatedEffects: { stepSeq: number; toolRef: string; effects: EffectClass[] }[];
  requiresAcknowledgement: boolean;
}

/**
 * Fork and operator resume (§4.2, §0.8).
 *
 * Both are recovery operations, and both are dangerous in the same specific way: they
 * cause work to happen a second time. The design of each is mostly about being honest
 * about that rather than hiding it.
 */
@Injectable()
export class RunRecoveryService {
  private readonly log = new Logger(RunRecoveryService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly queue: QueueService,
    private readonly events: EventLog,
  ) {}

  /**
   * What forking here would duplicate, without forking.
   *
   * A fork resumes adapter state from a checkpoint and executes forward from that step.
   * Everything the ORIGINAL run did after that point therefore happens again — which is
   * exactly right for a read-only agent and potentially a second refund for one that is
   * not. Nothing in a checkpoint records which side effects already fired, so the platform
   * cannot dedupe them; the only honest options are to refuse or to make the caller say
   * out loud that duplication is acceptable.
   */
  async previewFork(runId: string, at: { checkpointId?: string; atStepSeq?: number }): Promise<ForkPreview> {
    // Existence and tenancy, before any of the reads below touch the run's rows.
    await this.requireRun(runId);

    let checkpoint;
    if (at.checkpointId) {
      checkpoint = await this.db
        .selectFrom('checkpoints')
        .select(['id', 'step_seq'])
        .where('run_id', '=', runId)
        .where('id', '=', at.checkpointId)
        .executeTakeFirst();
      if (!checkpoint) throw new NotFound('checkpoint', at.checkpointId);
    } else {
      // Latest at or before the requested step. A run checkpoints at step boundaries, so
      // an arbitrary step number lands between two of them; rounding DOWN is the only safe
      // direction — rounding up would resume from state the requested step had not reached.
      let q = this.db
        .selectFrom('checkpoints')
        .select(['id', 'step_seq'])
        .where('run_id', '=', runId)
        .orderBy('step_seq', 'desc')
        .limit(1);
      if (at.atStepSeq !== undefined) q = q.where('step_seq', '<=', at.atStepSeq);
      checkpoint = await q.executeTakeFirst();
      if (!checkpoint) {
        throw new PlatformError('invalid_transition', `Run ${runId} has no checkpoint to fork from`, {
          hint: 'A run must reach at least one step boundary before it can be forked',
        });
      }
    }

    const after = await this.db
      .selectFrom('tool_invocations as ti')
      .innerJoin('steps as s', 's.id', 'ti.step_id')
      .innerJoin('tools as t', 't.id', 'ti.tool_id')
      .select((eb) => [
        's.seq as step_seq', 't.ref as tool_ref',
        sql<EffectClass[]>`ti.effects::text[]`.as('effects'),
      ])
      .where('ti.run_id', '=', runId)
      .where('s.seq', '>', checkpoint.step_seq)
      .orderBy('s.seq')
      .execute();

    // Only effects that cannot be safely repeated force the acknowledgement. A read-only
    // or keyed-idempotent call happening twice is not a problem, and demanding a flag for
    // those would train people to always pass it.
    const unsafe = after.filter(
      (i) => i.effects.includes('non_idempotent') || i.effects.includes('essential'),
    );

    return {
      forkPoint: { checkpointId: checkpoint.id, stepSeq: checkpoint.step_seq },
      duplicatedEffects: unsafe.map((i) => ({
        stepSeq: i.step_seq,
        toolRef: i.tool_ref,
        effects: i.effects,
      })),
      requiresAcknowledgement: unsafe.length > 0,
    };
  }

  async fork(input: ForkInput): Promise<Record<string, unknown>> {
    const ctx = requireContext();
    const run = await this.requireRun(input.runId);
    const preview = await this.previewFork(input.runId, {
      ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
      ...(input.atStepSeq !== undefined ? { atStepSeq: input.atStepSeq } : {}),
    });

    if (preview.requiresAcknowledgement && !input.acknowledgeDuplicateEffects) {
      throw new PlatformError(
        'invalid_transition',
        `Forking here would repeat ${preview.duplicatedEffects.length} unreplayable side effect(s)`,
        {
          forkPoint: preview.forkPoint,
          duplicatedEffects: preview.duplicatedEffects,
          hint: 'Fork from an earlier checkpoint, or pass acknowledgeDuplicateEffects: true',
        },
      );
    }

    const source = await this.db
      .selectFrom('checkpoints')
      .select(['id', 'step_seq', 'schema_version', 'state', 'state_artifact_id', 'state_hash', 'durability'])
      .where('id', '=', preview.forkPoint.checkpointId)
      .executeTakeFirstOrThrow();

    const created = await this.uow.run(async (tx) => {
      const forked = await tx
        .insertInto('runs')
        .values({
          thread_id: run.thread_id,
          // The SAME version, always. Forking onto a different version would conflate two
          // experiments -- "what if it had continued differently" and "what if it were a
          // different agent" -- and a fork that silently upgraded the spec would make the
          // resumed adapter state belong to code that never produced it.
          agent_version_id: run.agent_version_id,
          org_id: run.org_id,
          namespace_id: run.namespace_id,
          tenant_ref: run.tenant_ref,
          status: 'queued',
          durability: run.durability,
          initiator: 'api',
          caller_principal_id: ctx.callerPrincipalId,
          on_behalf_of_principal_id: run.on_behalf_of_principal_id,
          authorizing_human_id: run.authorizing_human_id,
          input: JSON.stringify(input.input ?? run.input ?? null),
          max_cost_micros: run.max_cost_micros,
          // Lineage, not parentage: a fork is a sibling experiment, not a delegation. It
          // keeps `root_run_id` so the whole family is still one investigation, but it is
          // NOT a child -- otherwise `wakeParent` would try to resume the original when
          // the fork settled.
          root_run_id: run.root_run_id ?? run.id,
          causation_id: run.id,
          trace_id: run.trace_id,
          correlation_id: run.correlation_id,
        })
        .returning(['id', 'thread_id'])
        .executeTakeFirstOrThrow();

      // The checkpoint is COPIED onto the fork, keeping its schema_version. §0.2: state
      // written under an older event schema stays readable, and rewriting it here to look
      // current would destroy the only record of what version produced it.
      await tx
        .insertInto('checkpoints')
        .values({
          run_id: forked.id,
          step_seq: source.step_seq,
          schema_version: source.schema_version,
          parent_checkpoint_id: source.id,
          state: source.state === null ? null : JSON.stringify(source.state),
          state_artifact_id: source.state_artifact_id,
          state_hash: source.state_hash,
          durability: source.durability,
        })
        .execute();

      await tx
        .updateTable('runs')
        .set({ step_count: source.step_seq })
        .where('id', '=', forked.id)
        .execute();

      await this.events.append(tx, {
        runId: forked.id,
        threadId: forked.thread_id,
        agentVersionId: run.agent_version_id,
        orgId: run.org_id,
        namespaceId: run.namespace_id,
        tenantRef: run.tenant_ref,
        type: EventType.RunCreated,
        payload: {
          forkedFromRunId: run.id,
          forkedFromCheckpointId: source.id,
          atStepSeq: source.step_seq,
          // Recorded when it applies. Someone reading this log later needs to know the
          // fork was authorised to repeat side effects, and by whom.
          ...(preview.requiresAcknowledgement
            ? {
                acknowledgedDuplicateEffects: preview.duplicatedEffects,
                acknowledgedBy: ctx.callerPrincipalId,
              }
            : {}),
        },
      });

      await this.queue.enqueue(tx, forked.id);
      return forked;
    });

    await this.queue.notifyReady(this.db, created.id);
    return {
      runId: created.id,
      forkedFrom: run.id,
      forkPoint: preview.forkPoint,
      duplicatedEffects: preview.duplicatedEffects,
    };
  }

  /**
   * Operator resume of a stuck or dead-lettered run (§0.8).
   *
   * The narrow, honest version: put the run back on the queue and let the ordinary resume
   * path do the rest. It does NOT try to re-derive what the run was waiting for — the
   * checkpoint already records that, and the run loop's `pendingAction` /
   * `pendingDelegation` / `pendingPeerCall` handling is the one implementation of "finish
   * what you were doing" that has been tested.
   *
   * Refused for a run that is genuinely running: re-enqueueing a leased run would create
   * a second worker on the same run, which the lease epoch would then reject — an
   * error report for an operator action that was never going to work.
   */
  async resume(runId: string, reason: string): Promise<Record<string, unknown>> {
    const ctx = requireContext();
    const run = await this.requireRun(runId);

    if (['completed', 'cancelled'].includes(run.status)) {
      throw new PlatformError('invalid_transition', `Run is ${run.status} and cannot be resumed`, {
        hint: 'Fork it instead — POST /v1/runs/{id}/fork',
      });
    }
    if (['running', 'tool_execution'].includes(run.status)) {
      const held = await this.db
        .selectFrom('run_queue')
        .select(['lease_owner', 'lease_expires_at'])
        .where('run_id', '=', runId)
        .executeTakeFirst();
      if (held?.lease_owner && held.lease_expires_at && held.lease_expires_at > new Date()) {
        throw new PlatformError('invalid_transition', 'Run is actively leased by a worker', {
          leaseOwner: held.lease_owner,
          hint: 'Wait for the lease to expire, or cancel the run',
        });
      }
    }

    const openInteraction = await this.db
      .selectFrom('interactions')
      .select(['id', 'kind', 'expires_at'])
      .where('run_id', '=', runId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (openInteraction) {
      // Resuming past a pending approval would execute the action the approval gates,
      // which is the §14 control the interaction exists to be.
      throw new PlatformError('invalid_transition', 'Run is waiting on an unresolved interaction', {
        interactionId: openInteraction.id,
        kind: openInteraction.kind,
        hint: 'Resolve or expire the interaction first — POST /v1/interactions/{id}/respond',
      });
    }

    await this.uow.run(async (tx) => {
      await tx
        .updateTable('runs')
        .set({ status: 'queued', ended_at: null, error: null })
        .where('id', '=', runId)
        .execute();

      // Dead letters are marked replayed rather than deleted: the record that this run
      // once failed terminally is what a post-incident review reads, and §0.8's dead
      // letter queue is a ledger, not a work list.
      await tx
        .updateTable('dead_letters')
        .set({
          acknowledged_by: ctx.callerPrincipalId,
          acknowledged_at: sql`now()`,
          replayed_run_id: runId,
        })
        .where('run_id', '=', runId)
        .where('acknowledged_at', 'is', null)
        .execute();

      await this.events.append(tx, {
        runId,
        threadId: run.thread_id,
        agentVersionId: run.agent_version_id,
        orgId: run.org_id,
        namespaceId: run.namespace_id,
        tenantRef: run.tenant_ref,
        type: EventType.RunResumed,
        payload: { operatorResume: true, reason, by: ctx.callerPrincipalId, fromStatus: run.status },
      });

      await this.queue.enqueue(tx, runId);
    });

    await this.queue.notifyReady(this.db, runId);
    this.log.warn(`operator resumed run ${runId} from ${run.status}: ${reason}`);
    return { runId, resumedFrom: run.status, status: 'queued', reason };
  }

  private async requireRun(runId: string) {
    const ctx = requireContext();
    const run = await this.db
      .selectFrom('runs')
      .select([
        'id', 'thread_id', 'agent_version_id', 'org_id', 'namespace_id', 'tenant_ref',
        'status', 'durability', 'input', 'max_cost_micros', 'root_run_id',
        'on_behalf_of_principal_id', 'authorizing_human_id', 'trace_id', 'correlation_id',
      ])
      .where('id', '=', runId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .executeTakeFirst();
    if (!run) throw new NotFound('run', runId);
    return run;
  }
}
