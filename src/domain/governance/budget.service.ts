import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { Metrics } from '../../platform/observability/metrics.js';
import { BudgetExhausted, PlatformError } from '../errors/platform.errors.js';

export type BudgetLevel =
  | 'org' | 'namespace' | 'tenant' | 'agent' | 'worker_pool'
  | 'model' | 'tool' | 'mcp_server' | 'peer' | 'speech_provider';

export interface BudgetScope {
  level: BudgetLevel;
  scopeRef: string;
}

/**
 * §5.2 hierarchical budgets: Org → Namespace → Tenant, each independently capped and
 * independently enforced. A scope's budget is opt-in -- a level with no row is unmetered,
 * the same default BackpressureService uses for a policy lookup that misses. This is
 * cost subdivision, not backpressure: a budget refuses on SPEND, not on rate or
 * concurrency, and it is enforced per-step so a run that blows through mid-execution
 * stops there rather than at its next admission.
 *
 * One scope may carry several period rows at once (hour AND month, say), because the
 * schema's unique key is (org, level, scope_ref, period) -- not scope alone. Both are
 * checked and both accrue on every record(), which is what lets an hourly guard rail
 * coexist with a monthly ceiling on the same tenant.
 */
@Injectable()
export class BudgetService {
  private readonly log = new Logger(BudgetService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly metrics: Metrics,
  ) {
    metrics.describe('budget_exhausted_total', 'Runs refused for exceeding a budget, by level');
    metrics.describe('budget_spend_recorded_total', 'Cost recorded against a budget, by level');
  }

  /**
   * Refuses if any named scope currently has a row at or past its limit.
   *
   * Read-only, and approximate under concurrency for the same reason `BackpressureService`'s
   * rate window is: a budget is a governance ceiling, not a billing ledger, and the
   * one-statement-per-record() write below is what actually enforces it -- checking here
   * is what lets a run stop BEFORE spending past the line instead of only after.
   */
  async checkNotExceeded(orgId: string, scopes: BudgetScope[]): Promise<void> {
    if (scopes.length === 0) return;
    const levels = [...new Set(scopes.map((s) => s.level))];
    const wanted = new Set(scopes.map((s) => `${s.level}:${s.scopeRef}`));

    const rows = await this.db
      .selectFrom('budgets')
      .select(['level', 'scope_ref', 'period', 'limit_micros', 'spent_micros', 'resets_at'])
      .where('org_id', '=', orgId)
      .where('level', 'in', levels as never[])
      .execute();

    for (const budget of rows) {
      if (!wanted.has(`${budget.level}:${budget.scope_ref}`)) continue;
      // A row past its own reset boundary has spent nothing in the new period yet --
      // record() performs the actual rollover on the next write, but a check that reads
      // the stale `spent_micros` between periods would refuse a run that is really fine.
      const rolledOver = budget.resets_at !== null && budget.resets_at.getTime() <= Date.now();
      const spent = rolledOver ? 0 : Number(budget.spent_micros);
      if (spent >= Number(budget.limit_micros)) {
        this.metrics.increment('budget_exhausted_total', { level: budget.level });
        throw new BudgetExhausted(budget.level, budget.scope_ref, budget.period);
      }
    }
  }

  /**
   * Adds cost to every budget row at the named scopes, rolling each row's period over
   * first if it elapsed. A no-op for a scope with no row: attaching cost tracking to a
   * level nobody capped would be inventing a limit that was never declared.
   */
  async record(orgId: string, scopes: BudgetScope[], costMicros: number): Promise<void> {
    if (costMicros <= 0 || scopes.length === 0) return;

    for (const scope of scopes) {
      const result = await sql<{ level: string; spent_micros: string; limit_micros: string }>`
        UPDATE budgets
        SET
          spent_micros = CASE
            WHEN resets_at IS NOT NULL AND resets_at <= now() THEN ${costMicros}::bigint
            ELSE spent_micros + ${costMicros}::bigint
          END,
          period_started_at = CASE
            WHEN resets_at IS NOT NULL AND resets_at <= now() THEN now()
            ELSE period_started_at
          END,
          resets_at = CASE
            WHEN period = 'total' THEN NULL
            WHEN resets_at IS NULL OR resets_at <= now()
              THEN now() + (CASE period
                WHEN 'hour' THEN interval '1 hour'
                WHEN 'day' THEN interval '1 day'
                WHEN 'month' THEN interval '1 month'
              END)
            ELSE resets_at
          END
        WHERE org_id = ${orgId} AND level = ${scope.level} AND scope_ref = ${scope.scopeRef}
        RETURNING level, spent_micros, limit_micros
      `.execute(this.db);

      for (const row of result.rows) {
        this.metrics.increment('budget_spend_recorded_total', { level: row.level });
        if (Number(row.spent_micros) >= Number(row.limit_micros)) {
          this.log.warn(`Budget for ${scope.level}:${scope.scopeRef} is now exhausted`);
        }
      }
    }
  }

  async upsert(input: {
    orgId: string;
    level: BudgetLevel;
    scopeRef: string;
    period: 'hour' | 'day' | 'month' | 'total';
    limitMicros: string;
  }) {
    if (BigInt(input.limitMicros) <= 0n) {
      throw new PlatformError('admission_rejected', 'A budget limit must be positive', {
        got: input.limitMicros,
      });
    }
    return this.db
      .insertInto('budgets')
      .values({
        org_id: input.orgId,
        level: input.level,
        scope_ref: input.scopeRef,
        period: input.period,
        limit_micros: input.limitMicros,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'level', 'scope_ref', 'period']).doUpdateSet({
          limit_micros: input.limitMicros,
        }),
      )
      .returning(['id', 'level', 'scope_ref', 'period', 'limit_micros', 'spent_micros'])
      .executeTakeFirstOrThrow();
  }

  async list(orgId: string) {
    return this.db
      .selectFrom('budgets')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('level')
      .orderBy('scope_ref')
      .execute();
  }
}
