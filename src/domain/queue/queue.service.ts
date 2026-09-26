import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db, Executor, Tx } from '../../platform/persistence/database.js';
import { RUN_READY_CHANNEL } from '../../platform/persistence/event-listener.js';
import { LeaseLost } from '../errors/platform.errors.js';

export interface Lease {
  runId: string;
  owner: string;
  epoch: string;
  /** Number of times this queue entry has been leased, including this lease. */
  attempts: number;
}

export interface ReclaimedLease {
  runId: string;
  /** The owner whose expired lease was returned to the queue. */
  lastWorker: string;
  attempts: number;
}

export interface ExhaustedLease {
  runId: string;
  /** Present when the final lease expired; a deliberate release has no retained owner. */
  lastWorker: string | null;
  attempts: number;
}

@Injectable()
export class QueueService {
  private readonly log = new Logger(QueueService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  async enqueue(
    tx: Tx,
    runId: string,
    opts: { pool?: string; priority?: number; visibleAt?: Date } = {},
  ): Promise<void> {
    await tx
      .insertInto('run_queue')
      .values({
        run_id: runId,
        worker_pool: opts.pool ?? 'default',
        priority: opts.priority ?? 100,
        // The DATABASE clock, because `claim` compares against the database's `now()`. Stamping
        // the app host's `new Date()` mixed two clocks: with the host 41ms ahead of Postgres
        // (measured, Docker Desktop's VM clock after a sleep) every new row was invisible for
        // 41ms, and a pod running ahead of the database would delay every run it enqueues by
        // its skew. An explicit `visibleAt` is a deliberate future time and is kept as given.
        visible_at: opts.visibleAt ?? sql<Date>`now()`,
      })
      .execute();
  }

  async notifyReady(db: Executor, runId: string): Promise<void> {
    await sql`SELECT pg_notify(${RUN_READY_CHANNEL}, ${runId})`.execute(db);
  }

  /**
   * Claims up to `limit` runs, per §4.4.
   *
   * FOR UPDATE SKIP LOCKED means concurrent workers never block one another and never
   * claim the same row. The lease epoch increments on every claim -- that is the fencing
   * token, and it is what makes a stalled worker's late write impossible rather than
   * merely unlikely.
   */
  async claim(
    pool: string,
    ttlMs: number,
    owner: string,
    limit: number,
    maxAttempts: number,
  ): Promise<Lease[]> {
    const rows = await sql<{ run_id: string; lease_epoch: string; attempts: number }>`
      WITH claimed AS (
        SELECT run_id FROM run_queue
         WHERE lease_owner IS NULL
           AND visible_at <= now()
           AND worker_pool = ${pool}
           AND attempts < ${maxAttempts}
         ORDER BY priority, visible_at
         FOR UPDATE SKIP LOCKED
         LIMIT ${limit}
      )
      UPDATE run_queue q
         SET lease_owner      = ${owner},
             lease_epoch      = q.lease_epoch + 1,
             lease_expires_at = now() + ${`${ttlMs} milliseconds`}::interval,
             heartbeat_at     = now(),
             attempts         = q.attempts + 1
        FROM claimed
       WHERE q.run_id = claimed.run_id
      RETURNING q.run_id, q.lease_epoch, q.attempts
    `.execute(this.db);

    return rows.rows.map((r) => ({
      runId: r.run_id,
      owner,
      epoch: r.lease_epoch,
      attempts: r.attempts,
    }));
  }

  /**
   * Extends held leases. Returns the ones still owned.
   *
   * A lease missing from the result was reclaimed while this worker held it: the run loop
   * must abandon it at the next step boundary rather than mid-tool-call.
   */
  async heartbeat(leases: Lease[], ttlMs: number): Promise<Set<string>> {
    if (leases.length === 0) return new Set();
    const values = sql.join(
      leases.map((lease) => sql`(${lease.runId}::uuid, ${lease.owner}, ${lease.epoch}::bigint)`),
    );
    const result = await sql<{ run_id: string }>`
      UPDATE run_queue q
         SET heartbeat_at = now(),
             lease_expires_at = now() + ${`${ttlMs} milliseconds`}::interval
        FROM (VALUES ${values}) AS v(run_id, owner, epoch)
       WHERE q.run_id = v.run_id
         AND q.lease_owner = v.owner
         AND q.lease_epoch = v.epoch
      RETURNING q.run_id
    `.execute(this.db);
    return new Set(result.rows.map((row) => row.run_id));
  }

  /**
   * Asserts the lease is still held, inside the caller's transaction.
   *
   * Every durable write in the run loop goes through this. Without it a worker that
   * stalled long enough to lose its lease -- a GC pause is enough -- wakes up and writes
   * a step into a run another worker now owns, and the event log interleaves two
   * realities. Heartbeats shorten that window; only fencing closes it.
   */
  async assertHeld(tx: Tx, lease: Lease): Promise<void> {
    const row = await sql<{ run_id: string }>`
      SELECT run_id FROM run_queue
       WHERE run_id = ${lease.runId}
         AND lease_owner = ${lease.owner}
         AND lease_epoch = ${lease.epoch}::bigint
         AND lease_expires_at > now()
       FOR UPDATE
    `.execute(tx);
    if (row.rows.length === 0) throw new LeaseLost(lease.runId);
  }

  /**
   * Releases a lease so another worker may claim it, optionally after a backoff.
   *
   * The backoff is JITTERED by ±20%. A backoff is almost always taken because something
   * downstream failed, which means every worker that touched it releases at the same
   * moment with the same delay -- and they then return together and hit the recovering
   * dependency as one synchronised wave. Spreading them is one line here and removes a
   * self-inflicted thundering herd that only appears under the exact conditions where it
   * does the most damage.
   */
  async release(db: Executor, lease: Lease, visibleAfterMs = 0): Promise<void> {
    await sql`
      UPDATE run_queue
         SET lease_owner = NULL, lease_expires_at = NULL,
             visible_at = now() + ${`${jitter(visibleAfterMs)} milliseconds`}::interval
       WHERE run_id = ${lease.runId} AND lease_owner = ${lease.owner}
    `.execute(db);
  }

  /** Removes a finished run from the queue. */
  async dequeue(db: Executor, runId: string): Promise<void> {
    await db.deleteFrom('run_queue').where('run_id', '=', runId).execute();
  }

  /**
   * Returns expired leases to the queue. Runs on the scheduler, not on every worker:
   * reclaiming another worker's lease is singleton-by-nature.
   */
  async reclaimExpired(batch: number): Promise<ReclaimedLease[]> {
    const result = await sql<{ run_id: string; last_worker: string; attempts: number }>`
      WITH expired AS (
        SELECT run_id, lease_owner AS last_worker, attempts
          FROM run_queue
         WHERE lease_owner IS NOT NULL
           AND lease_expires_at <= now()
         ORDER BY lease_expires_at
         FOR UPDATE SKIP LOCKED
         LIMIT ${batch}
      )
      UPDATE run_queue q
         SET lease_owner = NULL, lease_expires_at = NULL, visible_at = now()
        FROM expired
       WHERE q.run_id = expired.run_id
      RETURNING q.run_id, expired.last_worker, q.attempts
    `.execute(this.db);
    if (result.rows.length > 0) {
      this.log.warn(`reclaimed ${result.rows.length} expired lease(s)`);
    }
    return result.rows.map((row) => ({
      runId: row.run_id,
      lastWorker: row.last_worker,
      attempts: row.attempts,
    }));
  }

  /**
   * Locks claim-exhausted entries that are no longer actively leased. The caller must turn
   * the returned runs into terminal records and delete their queue rows in this transaction.
   * Keeping that work in one transaction makes it impossible for another worker to claim a
   * released row between detecting exhaustion and dead-lettering it.
   */
  async lockExhausted(
    tx: Tx,
    maxAttempts: number,
    batch: number,
  ): Promise<ExhaustedLease[]> {
    const result = await sql<{ run_id: string; last_worker: string | null; attempts: number }>`
      SELECT run_id, lease_owner AS last_worker, attempts
        FROM run_queue
       WHERE attempts >= ${maxAttempts}
         AND (
           lease_owner IS NULL
           OR lease_expires_at <= now()
         )
       -- NULLS FIRST, and it matters. A row RELEASED by a worker (graceful shutdown after
       -- its final claim) has lease_expires_at = NULL, and Postgres sorts NULLs last in
       -- ASC -- so with a batch limit and a steady supply of expired leases, a released
       -- exhausted row starves indefinitely. It is also the row that has been ready
       -- longest: it gave up its lease voluntarily rather than timing out.
       ORDER BY lease_expires_at NULLS FIRST
       FOR UPDATE SKIP LOCKED
       LIMIT ${batch}
    `.execute(tx);
    return result.rows.map((row) => ({
      runId: row.run_id,
      lastWorker: row.last_worker,
      attempts: row.attempts,
    }));
  }

  async depth(pool: string, maxAttempts: number): Promise<number> {
    const row = await this.db
      .selectFrom('run_queue')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('worker_pool', '=', pool)
      .where('lease_owner', 'is', null)
      .where('attempts', '<', maxAttempts)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }
}

/**
 * ±20% of `ms`, never negative.
 *
 * Zero stays zero: an immediate release must stay immediate, and jittering it would add
 * latency to the common non-backoff path for no benefit.
 */
function jitter(ms: number): number {
  if (ms <= 0) return 0;
  return Math.max(0, Math.round(ms * (0.8 + Math.random() * 0.4)));
}
