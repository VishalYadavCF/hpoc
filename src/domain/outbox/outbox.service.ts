import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db, Tx } from '../../platform/persistence/database.js';

const MAX_ATTEMPTS = 8;

/**
 * §4.5's transactional outbox: the side-effect half of effectively-once.
 *
 * A row is written in the SAME transaction as the state change it announces, so a crash
 * between "the run completed" and "the caller was told" is impossible. Delivery is
 * at-least-once with an idempotency key, which is what a receiver needs to deduplicate --
 * and is the honest guarantee rather than a claimed exactly-once.
 */
@Injectable()
export class OutboxService {
  private readonly log = new Logger(OutboxService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  async enqueue(
    tx: Tx,
    row: { runId: string; destination: string; idempotencyKey: string; payload: unknown },
  ): Promise<void> {
    await tx
      .insertInto('outbox')
      .values({
        run_id: row.runId,
        destination: row.destination,
        idempotency_key: row.idempotencyKey,
        payload: JSON.stringify(row.payload),
      })
      // The same run reaching a terminal state twice must not queue two deliveries.
      .onConflict((oc) => oc.columns(['destination', 'idempotency_key']).doNothing())
      .execute();
  }

  /** Claims a batch with SKIP LOCKED so several pumps can run without double-delivering. */
  async pump(batch = 20): Promise<{ sent: number; failed: number }> {
    const claimed = await sql<{
      id: string; destination: string; idempotency_key: string;
      payload: unknown; attempts: number;
    }>`
      WITH due AS (
        SELECT id FROM outbox
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at
         FOR UPDATE SKIP LOCKED
         LIMIT ${batch}
      )
      UPDATE outbox o SET attempts = o.attempts + 1
        FROM due WHERE o.id = due.id
      RETURNING o.id, o.destination, o.idempotency_key, o.payload, o.attempts
    `.execute(this.db);

    let sent = 0;
    let failed = 0;

    for (const row of claimed.rows) {
      try {
        const response = await fetch(row.destination, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // The receiver deduplicates on this. Without it at-least-once delivery is
            // indistinguishable from duplicate work.
            'idempotency-key': row.idempotency_key,
          },
          body: JSON.stringify(row.payload),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`destination returned ${response.status}`);

        await this.db
          .updateTable('outbox')
          .set({ status: 'sent', sent_at: new Date() })
          .where('id', '=', row.id)
          .execute();
        sent += 1;
      } catch (e) {
        failed += 1;
        const message = (e as Error).message;
        const exhausted = row.attempts >= MAX_ATTEMPTS;
        // Exponential backoff, capped. Abandoned rows stay visible rather than being
        // deleted: an undelivered outcome is an operational fact someone must see (§0.8).
        const delaySeconds = Math.min(2 ** row.attempts, 900);
        await this.db
          .updateTable('outbox')
          .set({
            status: exhausted ? 'abandoned' : 'pending',
            last_error: JSON.stringify({ message }),
            next_attempt_at: sql`now() + ${`${delaySeconds} seconds`}::interval`,
          })
          .where('id', '=', row.id)
          .execute();
        if (exhausted) this.log.error(`outbox ${row.id} abandoned after ${row.attempts}: ${message}`);
      }
    }
    return { sent, failed };
  }
}
