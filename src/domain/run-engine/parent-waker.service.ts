import { Inject, Injectable, Logger } from '@nestjs/common';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import { QueueService } from '../queue/queue.service.js';

/**
 * Returns a suspended parent to the queue once its child settles.
 *
 * Its own provider rather than a RunLoop method because two processes settle children: the
 * worker, when a child completes or fails, and the scheduler, when it dead-letters one. The
 * scheduler must not construct the execution engine just to requeue a row.
 */
@Injectable()
export class ParentWaker {
  private readonly log = new Logger(ParentWaker.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly queue: QueueService,
  ) {}

  /**
   * Without this the parent waits for its own resume to be triggered by something else --
   * which for a delegation is nothing. §4.6 requires a resumed parent to reconcile
   * children that finished while it was down; this is the live half of the same rule.
   */
  async wakeParent(run: { id: string; parent_run_id: string | null }): Promise<void> {
    if (!run.parent_run_id) return;
    try {
      const parentId = run.parent_run_id;
      await this.uow.run(async (tx) => {
        const woken = await tx
          .updateTable('runs')
          .set({ status: 'queued' })
          .where('id', '=', parentId)
          .where('status', '=', 'waiting')
          .returning('id')
          .executeTakeFirst();
        // Only enqueue if this update actually moved it: two children settling at once
        // must not enqueue the parent twice.
        if (woken) await this.queue.enqueue(tx, parentId, { priority: 50 });
      });
      await this.queue.notifyReady(this.db, parentId);
    } catch (e) {
      this.log.error(`could not wake parent of ${run.id}: ${(e as Error).message}`);
    }
  }
}
