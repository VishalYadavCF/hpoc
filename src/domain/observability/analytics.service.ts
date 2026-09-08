import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { requireContext } from '../../platform/context/platform-context.js';

export interface Window {
  sinceHours?: number;
  agentName?: string;
}

/**
 * §15.5's capture list, as queries: task success and failure, latency, cost, approval and
 * rejection rates, tool-use quality, memory effectiveness, user feedback.
 *
 * Everything here groups by AGENT VERSION rather than by agent. That is the whole point --
 * versions are immutable, so "did v3 actually beat v2" is answerable, and without it a
 * prompt change is a thing you hope helped.
 */
@Injectable()
export class AnalyticsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private scope() {
    const ctx = requireContext();
    return { orgId: ctx.orgId, namespaceId: ctx.namespaceId, tenantRef: ctx.tenantRef };
  }

  /** Outcome, latency and cost per agent version — the version-over-version comparison. */
  async byVersion(window: Window = {}) {
    const { orgId, namespaceId, tenantRef } = this.scope();
    const hours = window.sinceHours ?? 24 * 7;

    const rows = await sql<{
      agent_version_id: string; agent_name: string | null; version: number | null;
      runs: string; completed: string; failed: string; cancelled: string;
      p50_ms: number | null; p95_ms: number | null; p99_ms: number | null;
      avg_steps: number | null; total_cost_micros: string; total_tokens: string;
      memory_enabled: boolean | null;
    }>`
      SELECT r.agent_version_id,
             a.name AS agent_name,
             av.version,
             count(*)                                              AS runs,
             count(*) FILTER (WHERE r.status = 'completed')         AS completed,
             count(*) FILTER (WHERE r.status = 'failed')            AS failed,
             count(*) FILTER (WHERE r.status = 'cancelled')         AS cancelled,
             percentile_cont(0.50) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (r.ended_at - r.started_at)) * 1000)  AS p50_ms,
             percentile_cont(0.95) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (r.ended_at - r.started_at)) * 1000)  AS p95_ms,
             percentile_cont(0.99) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (r.ended_at - r.started_at)) * 1000)  AS p99_ms,
             avg(r.step_count)                                      AS avg_steps,
             sum(r.cost_micros)                                     AS total_cost_micros,
             sum(r.input_tokens + r.output_tokens)                  AS total_tokens,
             (av.spec -> 'memory' ->> 'enabled')::boolean           AS memory_enabled
        FROM runs r
        JOIN agent_versions av ON av.id = r.agent_version_id
        LEFT JOIN agents a ON a.id = av.agent_id
       WHERE r.org_id = ${orgId} AND r.namespace_id = ${namespaceId}
         AND r.tenant_ref = ${tenantRef}
         AND r.created_at > now() - ${`${hours} hours`}::interval
         AND (${window.agentName ?? null}::text IS NULL OR a.name = ${window.agentName ?? null})
       GROUP BY r.agent_version_id, a.name, av.version, av.spec
       ORDER BY runs DESC
       LIMIT 50
    `.execute(this.db);

    return rows.rows.map((r) => ({
      agentVersionId: r.agent_version_id,
      agent: r.agent_name,
      version: r.version,
      runs: Number(r.runs),
      completed: Number(r.completed),
      failed: Number(r.failed),
      cancelled: Number(r.cancelled),
      successRate: Number(r.runs) === 0 ? null : Number(r.completed) / Number(r.runs),
      latencyMs: { p50: round(r.p50_ms), p95: round(r.p95_ms), p99: round(r.p99_ms) },
      avgSteps: round(r.avg_steps),
      costMicros: Number(r.total_cost_micros ?? 0),
      tokens: Number(r.total_tokens ?? 0),
      memoryEnabled: r.memory_enabled,
    }));
  }

  /** Where the wall clock goes, across runs. Queue wait is the one people miss. */
  async latencyBreakdown(window: Window = {}) {
    const { orgId, namespaceId, tenantRef } = this.scope();
    const hours = window.sinceHours ?? 24 * 7;

    const rows = await sql<{
      kind: string; calls: string; p50_ms: number | null; p95_ms: number | null; total_ms: string;
    }>`
      SELECT s.kind,
             count(*) AS calls,
             percentile_cont(0.50) WITHIN GROUP (ORDER BY s.latency_ms) AS p50_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY s.latency_ms) AS p95_ms,
             coalesce(sum(s.latency_ms), 0) AS total_ms
        FROM steps s
       WHERE s.org_id = ${orgId} AND s.namespace_id = ${namespaceId}
         AND s.tenant_ref = ${tenantRef}
         AND s.created_at > now() - ${`${hours} hours`}::interval
       GROUP BY s.kind
    `.execute(this.db);

    const queue = await sql<{ p50_ms: number | null; p95_ms: number | null }>`
      SELECT percentile_cont(0.50) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (started_at - queued_at)) * 1000) AS p50_ms,
             percentile_cont(0.95) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (started_at - queued_at)) * 1000) AS p95_ms
        FROM runs
       WHERE org_id = ${orgId} AND namespace_id = ${namespaceId} AND tenant_ref = ${tenantRef}
         AND started_at IS NOT NULL
         AND created_at > now() - ${`${hours} hours`}::interval
    `.execute(this.db);

    return {
      steps: rows.rows.map((r) => ({
        kind: r.kind,
        calls: Number(r.calls),
        p50Ms: round(r.p50_ms),
        p95Ms: round(r.p95_ms),
        totalMs: Number(r.total_ms),
      })),
      // §15.4: the platform reporting "the agent is slow" when the cause is queue
      // starvation is exactly the failure self-observability exists to prevent.
      queueWaitMs: { p50: round(queue.rows[0]?.p50_ms ?? null), p95: round(queue.rows[0]?.p95_ms ?? null) },
    };
  }

  /** Tool-use quality (§15.5): volume, failure rate, latency, cache hit rate. */
  async toolHealth(window: Window = {}) {
    const { orgId, namespaceId, tenantRef } = this.scope();
    const hours = window.sinceHours ?? 24 * 7;

    const rows = await sql<{
      ref: string; origin: string; calls: string; failed: string;
      p95_ms: number | null; approvals: string;
    }>`
      SELECT t.ref, t.origin,
             count(*)                                        AS calls,
             count(*) FILTER (WHERE ti.status = 'failed')    AS failed,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY ti.latency_ms) AS p95_ms,
             count(*) FILTER (WHERE ti.interaction_id IS NOT NULL)       AS approvals
        FROM tool_invocations ti
        JOIN tools t ON t.id = ti.tool_id
       WHERE ti.org_id = ${orgId} AND ti.namespace_id = ${namespaceId}
         AND ti.tenant_ref = ${tenantRef}
         AND ti.created_at > now() - ${`${hours} hours`}::interval
       GROUP BY t.ref, t.origin
       ORDER BY calls DESC
       LIMIT 50
    `.execute(this.db);

    return rows.rows.map((r) => ({
      tool: r.ref,
      origin: r.origin,
      calls: Number(r.calls),
      failed: Number(r.failed),
      failureRate: Number(r.calls) === 0 ? 0 : Number(r.failed) / Number(r.calls),
      p95Ms: round(r.p95_ms),
      approvalGated: Number(r.approvals),
    }));
  }

  /**
   * §0.5's demand made concrete: does memory actually improve outcomes?
   *
   * **This is observational, not an experiment.** Runs are grouped by whether their agent
   * version enabled memory, and nothing randomises that assignment -- so the comparison is
   * confounded by which agents chose to enable it and on what workloads. It is enough to
   * notice a mechanism is not helping; it is NOT enough to conclude it is. A controlled
   * A/B needs the eval harness (§15.5), which is not built.
   */
  async memoryEffectiveness(window: Window = {}) {
    const { orgId, namespaceId, tenantRef } = this.scope();
    const hours = window.sinceHours ?? 24 * 7;

    const rows = await sql<{
      memory_enabled: boolean | null; runs: string; completed: string;
      avg_steps: number | null; avg_cost: number | null; p95_ms: number | null;
      avg_rating: number | null; rated: string;
    }>`
      SELECT coalesce((av.spec -> 'memory' ->> 'enabled')::boolean, false) AS memory_enabled,
             count(DISTINCT r.id)                                   AS runs,
             count(DISTINCT r.id) FILTER (WHERE r.status = 'completed') AS completed,
             avg(r.step_count)                                      AS avg_steps,
             avg(r.cost_micros)                                     AS avg_cost,
             percentile_cont(0.95) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (r.ended_at - r.started_at)) * 1000) AS p95_ms,
             avg(f.rating)                                          AS avg_rating,
             count(f.id)                                            AS rated
        FROM runs r
        JOIN agent_versions av ON av.id = r.agent_version_id
        LEFT JOIN feedback f ON f.run_id = r.id
       WHERE r.org_id = ${orgId} AND r.namespace_id = ${namespaceId}
         AND r.tenant_ref = ${tenantRef}
         AND r.created_at > now() - ${`${hours} hours`}::interval
       GROUP BY 1
    `.execute(this.db);

    return {
      caveat:
        'Observational, not randomised. Memory assignment is chosen per agent, so this is ' +
        'confounded by workload. Sufficient to notice a mechanism is not helping; not ' +
        'sufficient to conclude that it is.',
      cohorts: rows.rows.map((r) => ({
        memoryEnabled: Boolean(r.memory_enabled),
        runs: Number(r.runs),
        successRate: Number(r.runs) === 0 ? null : Number(r.completed) / Number(r.runs),
        avgSteps: round(r.avg_steps),
        avgCostMicros: round(r.avg_cost),
        p95Ms: round(r.p95_ms),
        avgRating: round(r.avg_rating),
        ratedRuns: Number(r.rated),
      })),
    };
  }

  /** Approval and rejection rates (§15.5), plus how long humans actually take. */
  async interactionHealth(window: Window = {}) {
    const { orgId, namespaceId, tenantRef } = this.scope();
    const hours = window.sinceHours ?? 24 * 7;

    const rows = await sql<{
      kind: string; status: string; n: string; p50_wait_ms: number | null;
    }>`
      SELECT kind, status, count(*) AS n,
             percentile_cont(0.50) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)) * 1000) AS p50_wait_ms
        FROM interactions
       WHERE org_id = ${orgId} AND namespace_id = ${namespaceId} AND tenant_ref = ${tenantRef}
         AND created_at > now() - ${`${hours} hours`}::interval
       GROUP BY kind, status
    `.execute(this.db);

    return rows.rows.map((r) => ({
      kind: r.kind,
      status: r.status,
      count: Number(r.n),
      p50WaitMs: round(r.p50_wait_ms),
    }));
  }
}

const round = (v: number | string | null): number | null =>
  v === null ? null : Math.round(Number(v) * 100) / 100;
