import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueService } from '../src/domain/queue/queue.service.js';
import { LeaseLost } from '../src/domain/errors/platform.errors.js';
import { SchedulerService } from '../src/scheduler/scheduler.service.js';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { EventLog } from '../src/domain/event-log/event-log.service.js';
import { OutboxService } from '../src/domain/outbox/outbox.service.js';
import { Metrics } from '../src/platform/observability/metrics.js';
import { fixture, makeRun, type Fixture } from './fixtures.js';

let f: Fixture;
let queue: QueueService;

beforeAll(async () => {
  f = await fixture();
  queue = new QueueService(f.db);
});
const POOL = `test-${Math.random().toString(36).slice(2, 8)}`;
const MAX_ATTEMPTS = 8;
const isolatedPool = (name: string) => `${POOL}-${name}-${Math.random().toString(36).slice(2, 7)}`;

afterAll(async () => {
  // Leave no phantom queued runs behind: no worker services these test pools, so rows
  // left here sit in the queue forever and make `GET /v1/ops/subsystems` lie about the
  // real backlog.
  const orphans = await f.db
    .selectFrom('run_queue').select('run_id').where('worker_pool', 'like', `${POOL}%`).execute();
  const ids = orphans.map((o) => o.run_id);
  if (ids.length > 0) {
    await f.db.deleteFrom('run_queue').where('run_id', 'in', ids).execute();
    await f.db.deleteFrom('events').where('run_id', 'in', ids).execute();
    await f.db.deleteFrom('runs').where('id', 'in', ids).execute();
  }
  await f.close();
});

describe('lease fencing (§4.4)', () => {
  it('claims with SKIP LOCKED and hands each run to exactly one worker', async () => {
    const runs = await Promise.all([makeRun(f), makeRun(f), makeRun(f)]);
    await f.db.transaction().execute(async (tx) => {
      for (const r of runs) await queue.enqueue(tx, r.runId, { pool: POOL });
    });

    const [a, b] = await Promise.all([
      queue.claim(POOL, 30_000, 'worker-a', 3, MAX_ATTEMPTS),
      queue.claim(POOL, 30_000, 'worker-b', 3, MAX_ATTEMPTS),
    ]);

    const claimed = [...a, ...b].map((l) => l.runId);
    expect(new Set(claimed).size).toBe(claimed.length); // no run claimed twice
    expect(claimed.length).toBeGreaterThan(0);
  });

  it('increments the epoch on every claim', async () => {
    const { runId } = await makeRun(f);
    await f.db.transaction().execute((tx) => queue.enqueue(tx, runId, { pool: POOL }));

    const first = (await queue.claim(POOL, 30_000, 'worker-a', 1, MAX_ATTEMPTS)).find((l) => l.runId === runId)!;
    await queue.release(f.db, first);
    const second = (await queue.claim(POOL, 30_000, 'worker-b', 1, MAX_ATTEMPTS)).find((l) => l.runId === runId)!;

    expect(Number(second.epoch)).toBe(Number(first.epoch) + 1);
  });

  /**
   * The failure this exists to prevent: a worker stalls (a GC pause is enough), its lease
   * expires, another worker claims the run -- and the first wakes up and writes a step
   * into a run it no longer owns, interleaving two realities in one event log.
   */
  it('refuses a write from a worker whose lease was reclaimed', async () => {
    const { runId } = await makeRun(f);
    await f.db.transaction().execute((tx) => queue.enqueue(tx, runId, { pool: POOL }));

    const stale = (await queue.claim(POOL, 30_000, 'worker-a', 1, MAX_ATTEMPTS)).find((l) => l.runId === runId)!;
    await queue.release(f.db, stale);
    const current = (await queue.claim(POOL, 30_000, 'worker-b', 1, MAX_ATTEMPTS)).find((l) => l.runId === runId)!;

    // The current holder writes freely.
    await expect(
      f.db.transaction().execute((tx) => queue.assertHeld(tx, current)),
    ).resolves.toBeUndefined();

    // The stalled worker, holding a lease that looks valid to itself, is refused.
    await expect(
      f.db.transaction().execute((tx) => queue.assertHeld(tx, stale)),
    ).rejects.toBeInstanceOf(LeaseLost);
  });

  it('reclaims expired leases and returns them to the queue', async () => {
    const { runId } = await makeRun(f);
    await f.db.transaction().execute((tx) => queue.enqueue(tx, runId, { pool: POOL }));
    const lease = (await queue.claim(POOL, -1_000, 'worker-a', 1, MAX_ATTEMPTS)).find((l) => l.runId === runId)!;

    expect((await queue.reclaimExpired(1_000)).length).toBeGreaterThan(0);
    await expect(
      f.db.transaction().execute((tx) => queue.assertHeld(tx, lease)),
    ).rejects.toBeInstanceOf(LeaseLost);

    const reclaimed = await queue.claim(POOL, 30_000, 'worker-b', 1, MAX_ATTEMPTS);
    expect(reclaimed.map((l) => l.runId)).toContain(runId);
  });

  it('does not heartbeat a lease it no longer holds', async () => {
    const { runId } = await makeRun(f);
    await f.db.transaction().execute((tx) => queue.enqueue(tx, runId, { pool: POOL }));
    const stale = (await queue.claim(POOL, 30_000, 'worker-a', 1, MAX_ATTEMPTS)).find((l) => l.runId === runId)!;
    await queue.release(f.db, stale);
    await queue.claim(POOL, 30_000, 'worker-b', 1, MAX_ATTEMPTS);

    const held = await queue.heartbeat([stale], 30_000);
    expect(held.has(runId)).toBe(false);
  });

  it('heartbeats every held lease in one batch', async () => {
    const pool = isolatedPool('heartbeat');
    const [a, b] = await Promise.all([makeRun(f), makeRun(f)]);
    await f.db.transaction().execute(async (tx) => {
      await queue.enqueue(tx, a.runId, { pool });
      await queue.enqueue(tx, b.runId, { pool });
    });

    const leases = await queue.claim(pool, 30_000, 'worker-batch', 2, MAX_ATTEMPTS);
    const ours = leases.filter((lease) => [a.runId, b.runId].includes(lease.runId));
    expect(ours).toHaveLength(2);

    const held = await queue.heartbeat(ours, 30_000);
    expect(held).toEqual(new Set([a.runId, b.runId]));
  });

  it('reclaims expired leases in bounded batches', async () => {
    const pool = isolatedPool('reclaim');
    const runs = await Promise.all([makeRun(f), makeRun(f), makeRun(f)]);
    await f.db.transaction().execute(async (tx) => {
      for (const run of runs) await queue.enqueue(tx, run.runId, { pool });
    });
    const leases = await queue.claim(pool, -1_000, 'worker-crashed', 3, MAX_ATTEMPTS);
    expect(leases.filter((lease) => runs.some((run) => run.runId === lease.runId))).toHaveLength(3);

    // `reclaimExpired` is deliberately NOT pool-scoped -- the scheduler is global and
    // leader-elected, so it must sweep every pool -- and a real deployment has that
    // scheduler running while this test does. So the property under test is the BOUND
    // (no call exceeds its batch) and eventual completeness for THIS pool, not an exact
    // count that only holds when nothing else is reclaiming.
    const ours = new Set(runs.map((run) => run.runId));
    const reclaimed = new Set<string>();
    for (let sweep = 0; sweep < 5 && reclaimed.size < ours.size; sweep++) {
      const batch = await queue.reclaimExpired(2);
      expect(batch.length).toBeLessThanOrEqual(2);
      for (const lease of batch) {
        if (ours.has(lease.runId)) {
          reclaimed.add(lease.runId);
          // The owner that lost the lease is retained, which is what lets a crash loop be
          // attributed to one bad host rather than a bad run.
          expect(lease.lastWorker).toBe('worker-crashed');
        }
      }
    }
    expect(reclaimed.size).toBe(3);
  });

  it('stops claiming an exhausted lease while retaining its final worker for dead-lettering', async () => {
    const pool = isolatedPool('exhausted');
    const { runId } = await makeRun(f);
    await f.db.transaction().execute((tx) => queue.enqueue(tx, runId, { pool }));

    const first = (await queue.claim(pool, -1_000, 'worker-first', 1, 2)).find((l) => l.runId === runId)!;
    expect(first.attempts).toBe(1);
    await queue.reclaimExpired(1_000);

    const final = (await queue.claim(pool, -1_000, 'worker-final', 1, 2)).find((l) => l.runId === runId)!;
    expect(final.attempts).toBe(2);
    const exhausted = await f.db.transaction().execute((tx) => queue.lockExhausted(tx, 2, 50));
    const ours = exhausted.find((lease) => lease.runId === runId);
    expect(ours?.attempts).toBe(2);
    // Either value is correct, which is why ExhaustedLease.lastWorker is `string | null`.
    // A live scheduler's reclaimExpired() clears lease_owner the moment the final lease
    // expires, and it may well get there before this read -- so asserting only the
    // owner-retained branch tests which side won a race, not the behaviour.
    expect(['worker-final', null]).toContain(ours?.lastWorker ?? null);
    await queue.reclaimExpired(1_000);
    await expect(queue.claim(pool, 30_000, 'worker-third', 1, 2)).resolves.toEqual([]);
  });

  it('dead-letters exhausted expired or released runs', async () => {
    const pool = isolatedPool('dead-letter');
    const { runId } = await makeRun(f);
    await f.db.transaction().execute((tx) => queue.enqueue(tx, runId, { pool }));
    await queue.claim(pool, -1_000, 'worker-crashed', 1, 1);

    // A batch of 1 would make this test depend on which single row a CROSS-POOL scan
    // picks: `lockExhausted` deliberately sweeps every pool (the scheduler is global and
    // leader-elected, so it must), and an earlier test in this file leaves its own
    // exhausted row behind. Batching wide enough to cover both, and asserting on THIS
    // run rather than on the count, tests the behaviour instead of the ordering.
    const scheduler = new SchedulerService(
      f.db,
      null as never,
      { QUEUE_MAX_ATTEMPTS: 1, RECLAIM_BATCH_SIZE: 50 } as never,
      new UnitOfWork(f.db),
      queue,
      null as never,
      new OutboxService(f.db),
      null as never,
      null as never,
      new EventLog(),
      { wakeParent: async () => undefined } as never,
      null as never,
      new Metrics(),
    );
    const terminalise = scheduler as unknown as { deadLetterExpiredLeases: () => Promise<number> };

    await expect(terminalise.deadLetterExpiredLeases()).resolves.toBeGreaterThanOrEqual(1);
    await expect(
      f.db.selectFrom('runs').select('status').where('id', '=', runId).executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: 'dead_letter' });
    await expect(
      f.db.selectFrom('dead_letters')
        .select(['attempts', 'last_worker'])
        .where('run_id', '=', runId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ attempts: 1, last_worker: 'worker-crashed' });
    await expect(
      f.db.selectFrom('run_queue').select('run_id').where('run_id', '=', runId).executeTakeFirst(),
    ).resolves.toBeUndefined();

    // A worker can also release during a graceful shutdown after consuming its final
    // claim. It is still exhausted and must not remain invisible behind claim's cap.
    const released = await makeRun(f);
    await f.db.transaction().execute((tx) => queue.enqueue(tx, released.runId, { pool }));
    const [lease] = await queue.claim(pool, 30_000, 'worker-released', 1, 1);
    await queue.release(f.db, lease!);
    await expect(terminalise.deadLetterExpiredLeases()).resolves.toBeGreaterThanOrEqual(1);
    await expect(
      f.db.selectFrom('dead_letters')
        .select(['attempts', 'last_worker'])
        .where('run_id', '=', released.runId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ attempts: 1, last_worker: null });
  });

  it('claims a resumed-priority row before a fresh default-priority row', async () => {
    const pool = isolatedPool('priority');
    const [fresh, resumed] = await Promise.all([makeRun(f), makeRun(f)]);
    await f.db.transaction().execute(async (tx) => {
      await queue.enqueue(tx, fresh.runId, { pool });
      await queue.enqueue(tx, resumed.runId, { pool, priority: 50 });
    });

    const [claimed] = await queue.claim(pool, 30_000, 'worker-priority', 1, MAX_ATTEMPTS);
    expect(claimed?.runId).toBe(resumed.runId);
  });
});
