import { Body, Controller, Get, Header, Inject, Param, Post, Query } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { ENV } from '../../platform/config/config.module.js';
import type { ApiEnv } from '../../platform/config/env.schema.js';
import { Metrics } from '../../platform/observability/metrics.js';
import { BackpressureService } from '../../domain/governance/backpressure.service.js';
import { BudgetService } from '../../domain/governance/budget.service.js';
import { NotFound } from '../../domain/errors/platform.errors.js';
import { Doc } from '../openapi/api-doc.decorator.js';

@Controller()
export class OpsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    private readonly metrics: Metrics,
    private readonly backpressure: BackpressureService,
    private readonly budgets: BudgetService,
  ) {}

  @Doc({ summary: 'Liveness probe. No tenancy.' })
  @Get('healthz')
  health(): unknown {
    return { status: 'ok' };
  }

  /** Readiness checks the database AND that migrations have been applied. */
  @Doc({ summary: 'Readiness probe. No tenancy.' })
  @Get('readyz')
  async ready(): Promise<unknown> {
    const applied = await this.db
      .selectFrom('schema_migrations')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirst();
    return { status: 'ok', migrations: Number(applied?.n ?? 0) };
  }

  @Doc({ summary: 'Prometheus metrics. No tenancy.' })
  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4')
  async metricsEndpoint(): Promise<string> {
    const depth = await sql<{ n: string }>`
      SELECT count(*) AS n
        FROM run_queue
       WHERE lease_owner IS NULL
         AND attempts < ${this.env.QUEUE_MAX_ATTEMPTS}
    `.execute(this.db);
    this.metrics.setGauge('queue_depth', Number(depth.rows[0]?.n ?? 0), { pool: 'all' });

    const leaseAge = await sql<{ age: number | null }>`
      SELECT EXTRACT(EPOCH FROM (now() - min(heartbeat_at)))::float AS age
        FROM run_queue WHERE lease_owner IS NOT NULL
    `.execute(this.db);
    this.metrics.setGauge('lease_age_seconds', leaseAge.rows[0]?.age ?? 0);

    const waiting = await sql<{ n: string }>`
      SELECT count(*) AS n FROM runs WHERE status = 'waiting'
    `.execute(this.db);
    this.metrics.setGauge('runs_in_waiting', Number(waiting.rows[0]?.n ?? 0));

    const dead = await sql<{ n: string }>`
      SELECT count(*) AS n FROM dead_letters WHERE acknowledged_at IS NULL
    `.execute(this.db);
    this.metrics.setGauge('dead_letters_open', Number(dead.rows[0]?.n ?? 0));

    return this.metrics.render();
  }

  /**
   * §0.8: a stuck run must be diagnosable at 2am without reading source.
   *
   * The failure history is the point -- reason, attempts, the worker that held it last,
   * and whether anyone has looked at it.
   */
  @Doc({ summary: 'List dead-lettered runs' })
  @Get('v1/ops/dead-letters')
  async deadLetters(@Query('acknowledged') acknowledged?: string): Promise<unknown> {
    let q = this.db
      .selectFrom('dead_letters as dl')
      .innerJoin('runs as r', 'r.id', 'dl.run_id')
      .select([
        'dl.id', 'dl.run_id', 'dl.reason', 'dl.error', 'dl.attempts', 'dl.last_worker',
        'dl.created_at', 'dl.acknowledged_at', 'dl.replayed_run_id',
        'r.tenant_ref', 'r.agent_version_id', 'r.thread_id',
      ])
      .orderBy('dl.created_at', 'desc')
      .limit(200);
    if (acknowledged !== 'true') q = q.where('dl.acknowledged_at', 'is', null);
    return { deadLetters: await q.execute() };
  }

  /**
   * Queue health is intentionally a snapshot rather than a push-trigger aggregate. The
   * scheduler and workers keep their hot paths to one cheap NOTIFY; operators ask for the
   * heavier counts only when diagnosing capacity, starvation, or a stalled reclaimer.
   */
  @Doc({ summary: 'Queue depth and lease health' })
  @Get('v1/ops/queue')
  async queue(): Promise<unknown> {
    const result = await sql<{
      pool: string;
      depth: string;
      delayed: string;
      leased: string;
      oldest_unclaimed_at: Date | null;
      expired_leases: string;
      exhausted: string;
    }>`
      SELECT worker_pool AS pool,
             count(*) FILTER (
               WHERE lease_owner IS NULL
                 AND visible_at <= now()
                 AND attempts < ${this.env.QUEUE_MAX_ATTEMPTS}
             ) AS depth,
             count(*) FILTER (
               WHERE lease_owner IS NULL
                 AND visible_at > now()
                 AND attempts < ${this.env.QUEUE_MAX_ATTEMPTS}
             ) AS delayed,
             count(*) FILTER (WHERE lease_owner IS NOT NULL) AS leased,
             min(enqueued_at) FILTER (
               WHERE lease_owner IS NULL
                 AND attempts < ${this.env.QUEUE_MAX_ATTEMPTS}
             ) AS oldest_unclaimed_at,
             count(*) FILTER (
               WHERE lease_owner IS NOT NULL
                 AND lease_expires_at <= now()
             ) AS expired_leases,
             count(*) FILTER (
               WHERE lease_owner IS NULL
                 AND attempts >= ${this.env.QUEUE_MAX_ATTEMPTS}
             ) AS exhausted
        FROM run_queue
       GROUP BY worker_pool
       ORDER BY worker_pool
    `.execute(this.db);

    return {
      maxAttempts: this.env.QUEUE_MAX_ATTEMPTS,
      queues: result.rows.map((row) => ({
        pool: row.pool,
        depth: Number(row.depth),
        delayed: Number(row.delayed),
        leased: Number(row.leased),
        oldestUnclaimedAt: row.oldest_unclaimed_at,
        expiredLeases: Number(row.expired_leases),
        exhausted: Number(row.exhausted),
      })),
    };
  }

  @Doc({ summary: 'Read one dead letter' })
  @Get('v1/ops/dead-letters/:id')
  async deadLetter(@Param('id') id: string): Promise<unknown> {
    const row = await this.db
      .selectFrom('dead_letters').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFound('dead letter', id);

    // The steps are what make it diagnosable: which one failed, and what it was doing.
    const steps = await this.db
      .selectFrom('steps')
      .select(['seq', 'kind', 'status', 'error', 'latency_ms'])
      .where('run_id', '=', row.run_id)
      .orderBy('seq')
      .execute();
    return { ...row, steps };
  }

  @Doc({ summary: 'Acknowledge a dead letter' })
  @Post('v1/ops/dead-letters/:id/acknowledge')
  async acknowledge(@Param('id') id: string): Promise<unknown> {
    const updated = await this.db
      .updateTable('dead_letters')
      .set({ acknowledged_at: sql`now()` })
      .where('id', '=', id)
      .where('acknowledged_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw new NotFound('open dead letter', id);
    return { acknowledged: true };
  }

  @Doc({ summary: 'Read backpressure policies' })
  @Get('v1/ops/backpressure')
  async policies(@Query('orgId') orgId: string): Promise<unknown> {
    return { policies: await this.backpressure.list(orgId) };
  }

  @Doc({ summary: 'Set a backpressure policy' })
  @Post('v1/ops/backpressure')
  async setPolicy(@Body() body: Record<string, unknown>): Promise<unknown> {
    return this.backpressure.upsert({
      orgId: String(body['orgId']),
      level: body['level'] as never,
      scopeRef: String(body['scopeRef']),
      maxConcurrency: (body['maxConcurrency'] as number | null) ?? null,
      maxRatePerSec: (body['maxRatePerSec'] as number | null) ?? null,
      queueDepthLimit: (body['queueDepthLimit'] as number | null) ?? null,
      onSaturation: body['onSaturation'] as never,
    });
  }

  /** §5.2 hierarchical budgets. */
  @Doc({ summary: 'Read budget consumption for an org' })
  @Get('v1/ops/budgets')
  async budgetsFor(@Query('orgId') orgId: string): Promise<unknown> {
    return { budgets: await this.budgets.list(orgId) };
  }

  @Doc({ summary: 'Set a budget' })
  @Doc({ summary: 'Set a budget' })
  @Post('v1/ops/budgets')
  async setBudget(@Body() body: Record<string, unknown>): Promise<unknown> {
    return this.budgets.upsert({
      orgId: String(body['orgId']),
      level: body['level'] as never,
      scopeRef: String(body['scopeRef']),
      period: body['period'] as never,
      limitMicros: String(body['limitMicros']),
    });
  }

  /** §15.4: the platform is itself a distributed system and must report on itself. */
  @Doc({ summary: 'Subsystem health across the platform' })
  @Get('v1/ops/subsystems')
  async subsystems(): Promise<unknown> {
    const [queue, runs, dead] = await Promise.all([
      sql<{ pool: string; depth: string; leased: string }>`
        SELECT worker_pool AS pool,
               count(*) FILTER (WHERE lease_owner IS NULL) AS depth,
               count(*) FILTER (WHERE lease_owner IS NOT NULL) AS leased
          FROM run_queue GROUP BY worker_pool
      `.execute(this.db),
      sql<{ status: string; n: string }>`
        SELECT status, count(*) AS n FROM runs GROUP BY status
      `.execute(this.db),
      sql<{ n: string }>`
        SELECT count(*) AS n FROM dead_letters WHERE acknowledged_at IS NULL
      `.execute(this.db),
    ]);
    return {
      queue: queue.rows,
      runs: Object.fromEntries(runs.rows.map((r) => [r.status, Number(r.n)])),
      deadLettersOpen: Number(dead.rows[0]?.n ?? 0),
    };
  }
}
