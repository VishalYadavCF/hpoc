import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '../src/platform/persistence/database.js';
import { tenantScopedPool, withTenantConnection } from '../src/platform/persistence/tenant-connection.js';
import { fixture, type Fixture } from './fixtures.js';

/**
 * §5.2 RLS, exercised through the exact stack production uses: a Kysely `Db` over
 * `tenantScopedPool`, connected as `hpoc_app` (migration 0019) rather than the owning
 * role every other test file connects as. `f.db` (the owner) is used only to read back
 * ground truth and to seed/clean up -- it always bypasses RLS, which is correct: it is
 * what migrations and seeding are supposed to do, not what this file is testing.
 */
const APP_URL = 'postgresql://hpoc_app:hpoc_app@localhost:5440/hpoc?schema=public';

let f: Fixture;
let appDb: Db;
let appPool: ReturnType<typeof createPool>;
let otherOrgId: string;

beforeAll(async () => {
  f = await fixture();
  appPool = createPool(APP_URL, 2);
  appDb = createDb(tenantScopedPool(appPool));

  const other = await f.db
    .insertInto('orgs')
    .values({ slug: `rls-other-${Math.random().toString(36).slice(2, 8)}`, name: 'RLS isolation test org' })
    .returning('id')
    .executeTakeFirstOrThrow();
  otherOrgId = other.id;
});

afterAll(async () => {
  await f.db.deleteFrom('orgs').where('id', '=', otherOrgId).execute();
  await appPool.end();
  await f.close();
});

describe('§5.2 row-level security across org-scoped tables', () => {
  it('the owner role (migrations, seeding, every other test file) always bypasses RLS', async () => {
    const total = await f.db.selectFrom('runs').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
    expect(Number(total?.n ?? 0)).toBeGreaterThan(0);
  });

  it('hpoc_app sees nothing outside a pinned tenant scope', async () => {
    const rows = await appDb.selectFrom('runs').selectAll().limit(1).execute();
    expect(rows).toEqual([]);
  });

  it('pinning app.org_id scopes hpoc_app to exactly that org, matching the owner’s count', async () => {
    const truth = await f.db
      .selectFrom('runs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('org_id', '=', f.orgId)
      .executeTakeFirst();

    const scoped = await withTenantConnection(appPool, { orgId: f.orgId }, () =>
      appDb.selectFrom('runs').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    );
    expect(Number(scoped?.n ?? 0)).toBe(Number(truth?.n ?? 0));
    expect(Number(scoped?.n ?? 0)).toBeGreaterThan(0);
  });

  it('a different org sees zero rows for this org’s tenant, not an error', async () => {
    const scoped = await withTenantConnection(appPool, { orgId: otherOrgId }, () =>
      appDb.selectFrom('runs').selectAll().limit(1).execute(),
    );
    expect(scoped).toEqual([]);
  });

  it('bypass sees across every org, for the platform sweeps that must', async () => {
    const bypassed = await withTenantConnection(appPool, { bypass: true }, () =>
      appDb.selectFrom('runs').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    );
    const total = await f.db.selectFrom('runs').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
    expect(Number(bypassed?.n ?? 0)).toBe(Number(total?.n ?? 0));
  });

  it('a pin releases cleanly: the NEXT unpinned use of the pool sees nothing again', async () => {
    await withTenantConnection(appPool, { orgId: f.orgId }, () => appDb.selectFrom('runs').selectAll().limit(1).execute());
    const rows = await appDb.selectFrom('runs').selectAll().limit(1).execute();
    expect(rows).toEqual([]);
  });

  it('covers the sibling tables that hold tenant data, not just runs', async () => {
    // `runs` alone was the proof of concept. A tenancy boundary that stops at one table
    // out of thirty-four is not a boundary: steps and events carry the model inputs and
    // tool arguments over again, and threads carry the conversation.
    for (const table of ['steps', 'events', 'threads', 'memory_records', 'artifacts'] as const) {
      const unpinned = await appDb.selectFrom(table).selectAll().limit(1).execute();
      expect(unpinned, `${table} is readable with no tenant pinned`).toEqual([]);
    }
  });

  it('leaves the three identity tables readable, because resolution precedes the pin', async () => {
    // ContextMiddleware turns headers into an identity by reading exactly these, and it
    // cannot pin to an org it has not resolved yet. Protecting them would make every
    // request fail to authenticate -- a documented trade, not an oversight.
    for (const table of ['namespaces', 'principals', 'tenants'] as const) {
      const rows = await appDb.selectFrom(table).selectAll().limit(1).execute();
      expect(rows.length, `${table} must stay readable for identity resolution`).toBe(1);
    }
  });

  it('a worker can still find any tenant’s leased run under bypass', async () => {
    // The failure this guards against is silent and total: RunLoop reads the run row to
    // discover WHICH org to pin to, so if that read were tenant-scoped the worker would
    // find nothing and simply stop processing every run in the system.
    const anyRun = await withTenantConnection(appPool, { bypass: true }, () =>
      appDb.selectFrom('runs').select(['id', 'org_id']).limit(1).executeTakeFirst(),
    );
    expect(anyRun).toBeDefined();
  });

  it('an INSERT for the wrong org under a pinned scope is refused, not silently reassigned', async () => {
    const version = await f.db
      .selectFrom('agent_versions').select('id')
      .where('org_id', '=', f.orgId).limit(1).executeTakeFirstOrThrow();
    const thread = await f.db
      .insertInto('threads')
      .values({ org_id: otherOrgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef })
      .returning('id')
      .executeTakeFirstOrThrow();

    const error = await withTenantConnection(appPool, { orgId: f.orgId }, () =>
      appDb
        .insertInto('runs')
        .values({
          thread_id: thread.id,
          agent_version_id: version.id,
          org_id: otherOrgId, // mismatched on purpose -- app.org_id is pinned to f.orgId
          namespace_id: f.namespaceId,
          tenant_ref: f.tenantRef,
          status: 'queued',
          durability: 'strict',
          initiator: 'api',
          caller_principal_id: f.principalId,
        })
        .execute(),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    await f.db.deleteFrom('threads').where('id', '=', thread.id).execute();
  });
});
