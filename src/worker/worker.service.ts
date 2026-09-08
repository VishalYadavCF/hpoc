import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { hostname } from 'node:os';
import { ENV } from '../platform/config/config.module.js';
import { DB } from '../platform/persistence/tokens.js';
import { EventListener, RUN_READY_CHANNEL } from '../platform/persistence/event-listener.js';
import type { Db } from '../platform/persistence/database.js';
import type { WorkerEnv } from '../platform/config/env.schema.js';
import { Metrics } from '../platform/observability/metrics.js';
import { QueueService, type Lease } from '../domain/queue/queue.service.js';
import { RunLoop } from '../domain/run-engine/run-loop.service.js';
import { newId } from '../platform/ids.js';

@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(WorkerService.name);
  private readonly id = `${hostname()}-${newId().slice(0, 8)}`;
  private readonly active = new Map<string, Lease>();
  private stopping = false;
  private pollTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private idle = Promise.resolve();

  constructor(
    @Inject(ENV) private readonly env: WorkerEnv,
    @Inject(DB) private readonly db: Db,
    private readonly listener: EventListener,
    private readonly queue: QueueService,
    private readonly runLoop: RunLoop,
    private readonly metrics: Metrics,
  ) {
    metrics.describe('queue_depth', 'Runs waiting with no lease holder');
    metrics.describe('worker_active_runs', 'Runs currently leased by this worker');
    metrics.describe('run_lease_lost_total', 'Runs abandoned because the lease was reclaimed');
  }

  onApplicationBootstrap(): void {
    this.log.log(`worker ${this.id} joining pool "${this.env.WORKER_POOL}"`);

    // Wake on notify. The poll below stays as a floor, not the primary path: a NOTIFY can
    // be missed across a listener reconnect, and a run that nothing wakes for would sit
    // in the queue indefinitely.
    void this.listener
      .onChannel(RUN_READY_CHANNEL, () => void this.tick())
      .catch((e: Error) => this.log.error(`could not subscribe to ${RUN_READY_CHANNEL}: ${e.message}`));

    this.pollTimer = setInterval(() => void this.tick(), 1_000);
    this.heartbeatTimer = setInterval(
      () => void this.beat(),
      this.env.HEARTBEAT_INTERVAL_MS,
    );
  }

  /**
   * Drains before exiting rather than letting leases expire.
   *
   * A worker that dies without releasing holds its runs hostage for a full lease TTL.
   * Releasing on SIGTERM turns a rolling deploy from "every in-flight run stalls for 30s"
   * into "every in-flight run moves to another worker immediately".
   */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.pollTimer);
    clearInterval(this.heartbeatTimer);
    await this.idle;
    for (const lease of this.active.values()) {
      await this.queue.release(this.db, lease).catch(() => undefined);
    }
    this.log.log(`worker ${this.id} drained ${this.active.size} lease(s)`);
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    const capacity = this.env.WORKER_CONCURRENCY - this.active.size;
    if (capacity <= 0) return;

    const leases = await this.queue
      .claim(
        this.env.WORKER_POOL,
        this.env.LEASE_TTL_MS,
        this.id,
        capacity,
        this.env.QUEUE_MAX_ATTEMPTS,
      )
      .catch((e: Error) => {
        this.log.error(`claim failed: ${e.message}`);
        return [] as Lease[];
      });

    for (const lease of leases) {
      this.active.set(lease.runId, lease);
      this.metrics.setGauge('worker_active_runs', this.active.size);
      const work = this.runLoop
        .execute(lease)
        .catch((e: Error) => this.log.error(`run ${lease.runId} threw: ${e.message}`))
        .finally(() => {
          this.active.delete(lease.runId);
          this.metrics.setGauge('worker_active_runs', this.active.size);
        });
      this.idle = this.idle.then(() => work);
    }

    this.metrics.setGauge('queue_depth', await this.queue.depth(this.env.WORKER_POOL, this.env.QUEUE_MAX_ATTEMPTS), {
      pool: this.env.WORKER_POOL,
    });
  }

  private async beat(): Promise<void> {
    const leases = [...this.active.values()];
    if (leases.length === 0) return;
    const held = await this.queue.heartbeat(leases, this.env.LEASE_TTL_MS);
    for (const lease of leases) {
      if (!held.has(lease.runId)) {
        // Not fatal here: the run loop's fence will refuse the next durable write. This
        // just stops us heartbeating a lease we no longer hold.
        this.log.warn(`lease for ${lease.runId} was reclaimed`);
        this.active.delete(lease.runId);
      }
    }
  }
}
