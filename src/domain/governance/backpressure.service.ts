import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { Metrics } from '../../platform/observability/metrics.js';
import { PlatformError, Saturated } from '../errors/platform.errors.js';

type Level = 'org' | 'namespace' | 'tenant' | 'agent' | 'worker_pool' | 'model' | 'tool' | 'mcp_server' | 'peer' | 'speech_provider';

interface Policy {
  level: Level;
  scopeRef: string;
  maxConcurrency: number | null;
  maxRatePerSec: number | null;
  queueDepthLimit: number | null;
  onSaturation: 'queue' | 'throttle' | 'shed';
}

const POLICY_TTL_MS = 10_000;

/**
 * §5.1. Quotas alone are insufficient: a quota rejects, backpressure shapes.
 *
 * Every level declares its response to saturation — queue with a bound, throttle to a
 * rate, or shed with a typed error the caller can act on. Silent queueing without a bound
 * is how a burst becomes an outage, which is why the schema refuses a `queue` policy that
 * names no `queue_depth_limit`.
 *
 * Checked cheapest-first: an in-memory rate window before a cached policy lookup before a
 * database count. Admission control should not itself become the bottleneck.
 */
@Injectable()
export class BackpressureService {
  private readonly log = new Logger(BackpressureService.name);
  private policies: { at: number; byKey: Map<string, Policy> } = { at: 0, byKey: new Map() };
  private readonly rateWindows = new Map<string, { windowStart: number; count: number }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly metrics: Metrics,
  ) {
    metrics.describe('backpressure_rejections_total', 'Requests throttled or shed by level');
    metrics.describe('backpressure_admitted_total', 'Requests admitted past backpressure');
  }

  /**
   * Throws `Saturated` when a level is over its limit.
   *
   * The typed error carries the LEVEL and SCOPE, because backing off from a tenant limit
   * and from an MCP-server limit are different behaviours and a caller cannot tell which
   * it hit from a bare 429.
   */
  async admit(scopes: { level: Level; scopeRef: string }[]): Promise<void> {
    const policies = await this.load();

    for (const scope of scopes) {
      const policy = policies.get(`${scope.level}:${scope.scopeRef}`);
      if (!policy) continue;

      if (policy.maxRatePerSec !== null && !this.withinRate(policy)) {
        this.reject(policy);
      }
      if (policy.maxConcurrency !== null && (await this.concurrency(policy)) >= policy.maxConcurrency) {
        this.reject(policy);
      }
      if (policy.onSaturation === 'queue' && policy.queueDepthLimit !== null) {
        const depth = await this.queueDepth();
        if (depth >= policy.queueDepthLimit) this.reject(policy);
      }
    }
    this.metrics.increment('backpressure_admitted_total');
  }

  private reject(policy: Policy): never {
    this.metrics.increment('backpressure_rejections_total', {
      level: policy.level,
      policy: policy.onSaturation,
    });
    // `queue` saturating means the bound was reached: at that point queueing further IS
    // shedding, and saying so is more useful than accepting work that will never run.
    const behaviour = policy.onSaturation === 'throttle' ? 'throttle' : 'shed';
    throw new Saturated(behaviour, policy.level, policy.scopeRef, behaviour === 'throttle' ? 1 : 5);
  }

  /** Fixed one-second window. Approximate at the boundary, and cheap, which is the point. */
  private withinRate(policy: Policy): boolean {
    const key = `${policy.level}:${policy.scopeRef}`;
    const now = Date.now();
    const window = this.rateWindows.get(key);
    if (!window || now - window.windowStart >= 1_000) {
      this.rateWindows.set(key, { windowStart: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= policy.maxRatePerSec!;
  }

  private async concurrency(policy: Policy): Promise<number> {
    const active: readonly string[] = ['queued', 'running', 'tool_execution', 'checkpointed'];
    let q = this.db
      .selectFrom('runs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('status', 'in', active as never[]);

    if (policy.level === 'tenant') q = q.where('tenant_ref', '=', policy.scopeRef);
    else if (policy.level === 'namespace') q = q.where('namespace_id', '=', policy.scopeRef);
    else if (policy.level === 'org') q = q.where('org_id', '=', policy.scopeRef);
    else if (policy.level === 'agent') q = q.where('agent_version_id', '=', policy.scopeRef);
    else return 0;

    return Number((await q.executeTakeFirst())?.n ?? 0);
  }

  private async queueDepth(): Promise<number> {
    const row = await sql<{ n: string }>`
      SELECT count(*) AS n FROM run_queue WHERE lease_owner IS NULL
    `.execute(this.db);
    return Number(row.rows[0]?.n ?? 0);
  }

  /** Cached briefly: a policy change should take effect in seconds, not per request. */
  private async load(): Promise<Map<string, Policy>> {
    if (Date.now() - this.policies.at < POLICY_TTL_MS) return this.policies.byKey;

    const rows = await this.db
      .selectFrom('backpressure_policies')
      .select(['level', 'scope_ref', 'max_concurrency', 'max_rate_per_sec', 'queue_depth_limit', 'on_saturation'])
      .execute();

    const byKey = new Map<string, Policy>(
      rows.map((r) => [
        `${r.level}:${r.scope_ref}`,
        {
          level: r.level as Level,
          scopeRef: r.scope_ref,
          maxConcurrency: r.max_concurrency,
          maxRatePerSec: r.max_rate_per_sec === null ? null : Number(r.max_rate_per_sec),
          queueDepthLimit: r.queue_depth_limit,
          onSaturation: r.on_saturation,
        },
      ]),
    );
    this.policies = { at: Date.now(), byKey };
    return byKey;
  }

  async upsert(policy: Policy & { orgId: string }) {
    if (policy.onSaturation === 'queue' && policy.queueDepthLimit === null) {
      throw new PlatformError('admission_rejected', 'A queue policy needs a bound', {
        hint: 'silent queueing without a bound is how a burst becomes an outage (§5.1)',
      });
    }
    const row = await this.db
      .insertInto('backpressure_policies')
      .values({
        org_id: policy.orgId,
        level: policy.level,
        scope_ref: policy.scopeRef,
        max_concurrency: policy.maxConcurrency,
        max_rate_per_sec: policy.maxRatePerSec === null ? null : String(policy.maxRatePerSec),
        queue_depth_limit: policy.queueDepthLimit,
        on_saturation: policy.onSaturation,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'level', 'scope_ref']).doUpdateSet({
          max_concurrency: policy.maxConcurrency,
          max_rate_per_sec: policy.maxRatePerSec === null ? null : String(policy.maxRatePerSec),
          queue_depth_limit: policy.queueDepthLimit,
          on_saturation: policy.onSaturation,
        }),
      )
      .returning(['id', 'level', 'scope_ref', 'on_saturation'])
      .executeTakeFirstOrThrow();

    this.policies = { at: 0, byKey: new Map() }; // force a reload on the next admit
    return row;
  }

  async list(orgId: string) {
    return this.db
      .selectFrom('backpressure_policies')
      .selectAll()
      .where('org_id', '=', orgId)
      .execute();
  }
}
