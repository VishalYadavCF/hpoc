import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'kysely';
import type pg from 'pg';
import { DB, POOL } from '../platform/persistence/tokens.js';
import type { Db } from '../platform/persistence/database.js';
import { UnitOfWork } from '../platform/persistence/unit-of-work.js';
import { withTenantConnection } from '../platform/persistence/tenant-connection.js';
import { ENV } from '../platform/config/config.module.js';
import type { SchedulerEnv } from '../platform/config/env.schema.js';
import { QueueService } from '../domain/queue/queue.service.js';
import { TriggerService } from '../domain/trigger/trigger.service.js';
import { OutboxService } from '../domain/outbox/outbox.service.js';
import { MemoryEngine } from '../domain/memory/memory.engine.js';
import { ArtifactService } from '../domain/artifact/artifact.service.js';
import { Metrics } from '../platform/observability/metrics.js';
import { EventLog } from '../domain/event-log/event-log.service.js';
import { EventType } from '../domain/event-log/taxonomy.js';
import { ParentWaker } from '../domain/run-engine/parent-waker.service.js';
import { SpanProjectionService } from '../domain/observability/span-projection.service.js';

interface DeadLetteredRun {
  id: string;
  thread_id: string;
  agent_version_id: string;
  org_id: string;
  namespace_id: string;
  tenant_ref: string;
  parent_run_id: string | null;
  delivery: unknown;
}

interface DeadLetterNotification {
  run: Pick<DeadLetteredRun, 'id' | 'parent_run_id'>;
  seq: number;
}

/**
 * The singleton jobs.
 *
 * Deliberately not folded into the worker: reclaiming another worker's expired lease and
 * expiring an interaction are singleton-by-nature, and running them on N replicas is N
 * races where one is correct.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(SchedulerService.name);
  private leaderClient?: pg.PoolClient;
  private timers: NodeJS.Timeout[] = [];
  private isLeader = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(ENV) private readonly env: SchedulerEnv,
    private readonly uow: UnitOfWork,
    private readonly queue: QueueService,
    private readonly triggers: TriggerService,
    private readonly outbox: OutboxService,
    private readonly memory: MemoryEngine,
    private readonly artifacts: ArtifactService,
    private readonly events: EventLog,
    private readonly parents: ParentWaker,
    private readonly spans: SpanProjectionService,
    private readonly metrics: Metrics,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.tryBecomeLeader();
    this.timers.push(setInterval(() => void this.tryBecomeLeader(), 5_000));
    this.timers.push(setInterval(() => void this.guarded(() => this.reclaim()), this.env.RECLAIM_INTERVAL_MS));
    this.timers.push(setInterval(() => void this.guarded(() => this.expireInteractions()), this.env.EXPIRY_INTERVAL_MS));
    this.timers.push(setInterval(() => void this.guarded(() => this.pumpOutbox()), this.env.OUTBOX_INTERVAL_MS));
    // Every 30s, matching to the minute. Firing twice inside one minute is harmless: the
    // idempotency key is the trigger plus the minute, so the second creates nothing.
    this.timers.push(setInterval(() => void this.guarded(() => this.dispatchSchedules()), 30_000));
    // §6.2: lifecycle -- TTL and decay -- runs asynchronously, outside the request path.
    this.timers.push(setInterval(() => void this.guarded(() => this.expireMemory()), 60_000));
    this.timers.push(setInterval(() => void this.guarded(() => this.collectArtifacts()), 120_000));
    this.timers.push(setInterval(() => void this.guarded(() => this.ensurePartitions()), 60 * 60 * 1000));
    // §15.2: ship finished runs to the collector. On the scheduler rather than the worker
    // because the cursor is a single high-water mark -- N replicas advancing it
    // concurrently is N races where one wins and the rest silently skip their batch.
    this.timers.push(setInterval(() => void this.guarded(() => this.exportTraces()), 15_000));
  }

  async onApplicationShutdown(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.leaderClient?.release();
  }

  /**
   * Leader election on a dedicated connection held for the process lifetime. Losing the
   * connection releases the lock, so the next instance takes it -- no extra dependency,
   * consistent with the Postgres-centric bet (§11.3).
   */
  private async tryBecomeLeader(): Promise<void> {
    if (this.isLeader) return;
    const client = await this.pool.connect();
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [this.env.SCHEDULER_LOCK_KEY],
    );
    if (rows[0]?.locked) {
      this.leaderClient = client;
      this.isLeader = true;
      client.on('error', () => {
        this.isLeader = false;
        this.leaderClient = undefined;
      });
      this.log.log('became scheduler leader');
    } else {
      client.release();
    }
  }

  /**
   * §5.2 RLS: every job here is a cross-tenant sweep by nature -- reclaim, dead-letter,
   * memory expiry, artifact collection all scan across every org on a timer. `bypass`
   * is scoped to exactly this pinned connection for exactly this job's duration, not set
   * globally, so nothing outside this call gets it for free.
   */
  private async guarded(fn: () => Promise<void>): Promise<void> {
    if (!this.isLeader) return;
    try {
      await withTenantConnection(this.pool, { bypass: true }, fn);
    } catch (e) {
      this.log.error(`scheduler job failed: ${(e as Error).message}`);
    }
  }

  private async reclaim(): Promise<void> {
    const deadLettered = await this.deadLetterExpiredLeases();
    if (deadLettered > 0) this.metrics.increment('runs_dead_lettered_total', undefined, deadLettered);

    const reclaimed = await this.queue.reclaimExpired(this.env.RECLAIM_BATCH_SIZE);
    if (reclaimed.length > 0) {
      this.metrics.increment('leases_reclaimed_total', undefined, reclaimed.length);
      // The one-second poll is still a recovery floor, but a reclaimed run is immediately
      // useful work. Wake listeners after the transaction has committed.
      await Promise.all(
        reclaimed.map(({ runId }) =>
          this.queue.notifyReady(this.db, runId).catch((e: Error) =>
            this.log.warn(`could not notify reclaimed run ${runId}: ${e.message}`),
          ),
        ),
      );
    }
  }

  /**
   * A worker that dies before recording its own failure cannot create a dead letter. The
   * scheduler owns that recovery path: it locks exhausted entries once their final lease
   * is expired or released, records the terminal outcome, and removes the queue row in one
   * transaction. A claimant can therefore never slip in between deciding the retry budget
   * is spent and terminalising the run.
   */
  private async deadLetterExpiredLeases(): Promise<number> {
    const terminal = await this.uow.run(async (tx) => {
      const expired = await this.queue.lockExhausted(
        tx,
        this.env.QUEUE_MAX_ATTEMPTS,
        this.env.RECLAIM_BATCH_SIZE,
      );
      if (expired.length === 0) return [] as DeadLetterNotification[];

      const runs = await tx
        .selectFrom('runs')
        .select([
          'id', 'thread_id', 'agent_version_id', 'org_id', 'namespace_id', 'tenant_ref',
          'parent_run_id', 'delivery',
        ])
        .where('id', 'in', expired.map((lease) => lease.runId))
        .execute();
      const byId = new Map(runs.map((run) => [run.id, run as DeadLetteredRun]));
      const notifications: DeadLetterNotification[] = [];

      for (const lease of expired) {
        const run = byId.get(lease.runId);
        if (!run) {
          // The foreign key makes this defensive branch unreachable in normal operation,
          // but removing an orphaned queue row is safer than letting it block the pool.
          await this.queue.dequeue(tx, lease.runId);
          continue;
        }

        const error = {
          code: 'lease_attempts_exhausted',
          message: `Lease expired after ${lease.attempts} attempt(s)`,
          attempts: lease.attempts,
          lastWorker: lease.lastWorker,
        };
        const updated = await tx
          .updateTable('runs')
          .set({ status: 'dead_letter', error: JSON.stringify(error), ended_at: sql`now()` })
          .where('id', '=', run.id)
          .where('status', 'in', ['queued', 'running', 'tool_execution', 'checkpointed', 'waiting'])
          .returning('id')
          .executeTakeFirst();
        if (!updated) {
          // A terminal run with a queue row is stale bookkeeping, not a second failure.
          await this.queue.dequeue(tx, run.id);
          continue;
        }

        const seq = await this.events.append(tx, {
          runId: run.id,
          threadId: run.thread_id,
          agentVersionId: run.agent_version_id,
          orgId: run.org_id,
          namespaceId: run.namespace_id,
          tenantRef: run.tenant_ref,
          type: EventType.RunDeadLettered,
          payload: error,
          parentRunId: run.parent_run_id,
        });
        const delivery = run.delivery as { webhookUrl?: string } | null;
        if (delivery?.webhookUrl) {
          await this.outbox.enqueue(tx, {
            runId: run.id,
            destination: delivery.webhookUrl,
            idempotencyKey: `run:${run.id}:dead_letter`,
            payload: { runId: run.id, threadId: run.thread_id, status: 'dead_letter', error },
          });
        }
        await tx
          .insertInto('dead_letters')
          .values({
            run_id: run.id,
            reason: 'lease attempts exhausted',
            error: JSON.stringify(error),
            attempts: lease.attempts,
            last_worker: lease.lastWorker,
          })
          .execute();
        await this.queue.dequeue(tx, run.id);
        notifications.push({ run, seq });
      }
      return notifications;
    });

    await Promise.all(
      terminal.map(async ({ run, seq }) => {
        await this.events.notify(this.db, run.id, seq).catch((e: Error) =>
          this.log.warn(`could not notify dead-lettered run ${run.id}: ${e.message}`),
        );
        await this.parents.wakeParent(run);
      }),
    );
    return terminal.length;
  }

  /** An expired interaction is a defined run outcome, not a hang (§14.2). */
  private async expireInteractions(): Promise<void> {
    const expired = await this.db
      .updateTable('interactions')
      .set({ status: 'expired' })
      .where('status', '=', 'pending')
      .where('expires_at', '<=', new Date())
      .returning(['id', 'run_id'])
      .execute();

    for (const row of expired) {
      await this.db
        .updateTable('runs')
        .set({
          status: 'failed',
          error: JSON.stringify({ message: 'Interaction expired without a response' }),
          ended_at: new Date(),
        })
        .where('id', '=', row.run_id)
        .where('status', '=', 'waiting')
        .execute();
    }
    if (expired.length > 0) {
      this.log.warn(`expired ${expired.length} interaction(s)`);
      this.metrics.increment('interactions_expired_total', undefined, expired.length);
    }
  }

  private async expireMemory(): Promise<void> {
    const n = await this.memory.expire();
    if (n > 0) this.metrics.increment('memory_expired_total', undefined, n);
  }

  /** §11.2 GC. Legal hold beats TTL, which the service enforces rather than this caller. */
  private async collectArtifacts(): Promise<void> {
    const n = await this.artifacts.collectGarbage();
    if (n > 0) this.metrics.increment('artifacts_collected_total', undefined, n);
  }

  /** §15.2 OTLP export. A no-op until an internal collector is configured (§16.1). */
  private async exportTraces(): Promise<void> {
    const { runs, spans } = await this.spans.exportFinished();
    if (spans > 0) {
      this.metrics.increment('traces_exported_total', undefined, spans);
      this.log.debug(`exported ${spans} span(s) across ${runs} run(s)`);
    }
  }

  private async pumpOutbox(): Promise<void> {
    const { sent, failed } = await this.outbox.pump();
    if (sent > 0) this.metrics.increment('outbox_sent_total', undefined, sent);
    if (failed > 0) this.metrics.increment('outbox_failed_total', undefined, failed);
  }

  private async dispatchSchedules(): Promise<void> {
    const fired = await this.triggers.dispatchSchedules(new Date());
    if (fired > 0) {
      this.log.log(`fired ${fired} schedule(s)`);
      this.metrics.increment('schedules_fired_total', undefined, fired);
    }
  }

  /**
   * Creates next month's partitions before they are needed. Retention is a DETACH + DROP
   * of the oldest, never a mass DELETE -- and an archived partition is exported to the
   * replay corpus before it goes (§0.2).
   */
  private async ensurePartitions(): Promise<void> {
    for (const table of ['events', 'usage_ledger', 'audit_log']) {
      for (const offset of [0, 1]) {
        const start = new Date();
        start.setUTCDate(1);
        start.setUTCHours(0, 0, 0, 0);
        start.setUTCMonth(start.getUTCMonth() + offset);
        const end = new Date(start);
        end.setUTCMonth(end.getUTCMonth() + 1);
        const name = `${table}_${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
        await sql
          .raw(
            `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${table} ` +
              `FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`,
          )
          .execute(this.db)
          .catch(() => undefined); // a DEFAULT partition already holding rows blocks this
      }
    }
  }
}
