import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetService } from '../src/domain/governance/budget.service.js';
import { Metrics } from '../src/platform/observability/metrics.js';
import { BudgetExhausted } from '../src/domain/errors/platform.errors.js';
import { fixture, type Fixture } from './fixtures.js';

let f: Fixture;
let budgets: BudgetService;

const SUFFIX = Math.random().toString(36).slice(2, 8);
const NAMESPACE_SCOPE = `ns-${SUFFIX}`;
const TENANT_SCOPE = `tenant-${SUFFIX}`;
const TOTAL_SCOPE = `total-${SUFFIX}`;

beforeAll(async () => {
  f = await fixture();
  budgets = new BudgetService(f.db, new Metrics());
});

afterAll(async () => {
  await f.db.deleteFrom('budgets').where('org_id', '=', f.orgId)
    .where('scope_ref', 'in', [NAMESPACE_SCOPE, TENANT_SCOPE, TOTAL_SCOPE]).execute();
  await f.close();
});

describe('§5.2 hierarchical budgets', () => {
  it('a scope with no budget row is unmetered', async () => {
    await expect(
      budgets.checkNotExceeded(f.orgId, [{ level: 'namespace', scopeRef: `no-budget-${SUFFIX}` }]),
    ).resolves.toBeUndefined();
  });

  it('record() accrues spend, and check refuses once the limit is reached', async () => {
    await budgets.upsert({
      orgId: f.orgId, level: 'namespace', scopeRef: NAMESPACE_SCOPE, period: 'day', limitMicros: '1000',
    });

    await budgets.record(f.orgId, [{ level: 'namespace', scopeRef: NAMESPACE_SCOPE }], 400);
    await expect(
      budgets.checkNotExceeded(f.orgId, [{ level: 'namespace', scopeRef: NAMESPACE_SCOPE }]),
    ).resolves.toBeUndefined();

    await budgets.record(f.orgId, [{ level: 'namespace', scopeRef: NAMESPACE_SCOPE }], 700);
    const error = await budgets
      .checkNotExceeded(f.orgId, [{ level: 'namespace', scopeRef: NAMESPACE_SCOPE }])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExhausted);
    expect((error as BudgetExhausted).level).toBe('namespace');
    expect((error as BudgetExhausted).scopeRef).toBe(NAMESPACE_SCOPE);
  });

  it('checks every scope named, refusing on the first one that is over', async () => {
    // namespace above is already exhausted; tenant has no row at all (unmetered).
    const error = await budgets
      .checkNotExceeded(f.orgId, [
        { level: 'tenant', scopeRef: TENANT_SCOPE },
        { level: 'namespace', scopeRef: NAMESPACE_SCOPE },
      ])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExhausted);
  });

  it('a "total" period never rolls over', async () => {
    await budgets.upsert({
      orgId: f.orgId, level: 'tenant', scopeRef: TOTAL_SCOPE, period: 'total', limitMicros: '500',
    });
    await budgets.record(f.orgId, [{ level: 'tenant', scopeRef: TOTAL_SCOPE }], 500);

    const row = await f.db
      .selectFrom('budgets').select(['resets_at', 'spent_micros'])
      .where('org_id', '=', f.orgId).where('level', '=', 'tenant').where('scope_ref', '=', TOTAL_SCOPE)
      .where('period', '=', 'total')
      .executeTakeFirstOrThrow();
    expect(row.resets_at).toBeNull();
    expect(row.spent_micros).toBe('500');

    const error = await budgets
      .checkNotExceeded(f.orgId, [{ level: 'tenant', scopeRef: TOTAL_SCOPE }])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExhausted);
  });

  it('rejects a non-positive limit rather than storing an unenforceable budget', async () => {
    await expect(
      budgets.upsert({ orgId: f.orgId, level: 'org', scopeRef: `bad-${SUFFIX}`, period: 'day', limitMicros: '0' }),
    ).rejects.toThrow();
  });

  it('list() returns every budget row for the org', async () => {
    const rows = await budgets.list(f.orgId);
    expect(rows.map((r) => r.scope_ref)).toEqual(expect.arrayContaining([NAMESPACE_SCOPE, TOTAL_SCOPE]));
  });
});
