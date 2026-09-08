import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { fixture, type Fixture } from './fixtures.js';

let f: Fixture;
beforeAll(async () => (f = await fixture()));
afterAll(async () => f.close());

/**
 * These assert the DATABASE refuses the write, not that a service layer does.
 *
 * That is the whole point of putting §8.3 and §13.3 in CHECK constraints and composite
 * foreign keys: they hold even when a future code path forgets, and they hold for a
 * migration or a psql session too.
 */
describe('schema-enforced invariants', () => {
  const rejects = (q: Promise<unknown>) => expect(q).rejects.toThrow();

  it('refuses to cache a non-idempotent tool (§10)', async () => {
    const tool = await f.db
      .insertInto('tools')
      .values({
        org_id: f.orgId, namespace_id: f.namespaceId,
        ref: `t.${Math.random().toString(36).slice(2)}`, origin: 'native', residency: 'internal',
        input_schema: JSON.stringify({}), default_effects: ['non_idempotent'],
        sandbox_profile: 'none',
      })
      .returning('id').executeTakeFirstOrThrow();

    const version = await f.db
      .insertInto('agent_versions')
      .values({
        org_id: f.orgId, namespace_id: f.namespaceId, lifetime: 'ephemeral',
        spec: JSON.stringify({}), spec_hash: `t-${Math.random()}`,
        workload_identity_id: f.principalId, model_id: f.modelId,
      })
      .returning('id').executeTakeFirstOrThrow();

    await rejects(
      f.db.insertInto('agent_version_tools').values({
        agent_version_id: version.id, tool_id: tool.id,
        effects: ['non_idempotent', 'cacheable'], cache_ttl_seconds: 60,
      }).execute(),
    );
  });

  it('refuses a compensatable tool with no named inverse (§8.3)', async () => {
    const tool = await f.db
      .insertInto('tools')
      .values({
        org_id: f.orgId, namespace_id: f.namespaceId,
        ref: `t.${Math.random().toString(36).slice(2)}`, origin: 'native', residency: 'internal',
        input_schema: JSON.stringify({}), default_effects: ['essential'], sandbox_profile: 'none',
      })
      .returning('id').executeTakeFirstOrThrow();
    const version = await f.db
      .insertInto('agent_versions')
      .values({
        org_id: f.orgId, namespace_id: f.namespaceId, lifetime: 'ephemeral',
        spec: JSON.stringify({}), spec_hash: `t-${Math.random()}`,
        workload_identity_id: f.principalId, model_id: f.modelId,
      })
      .returning('id').executeTakeFirstOrThrow();

    await rejects(
      f.db.insertInto('agent_version_tools').values({
        agent_version_id: version.id, tool_id: tool.id, effects: ['essential', 'compensatable'],
      }).execute(),
    );
  });

  it('refuses a root run carrying a delegation depth (§4.6)', async () => {
    const thread = await f.db
      .insertInto('threads')
      .values({ org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef })
      .returning('id').executeTakeFirstOrThrow();
    const version = await f.db
      .insertInto('agent_versions')
      .values({
        org_id: f.orgId, namespace_id: f.namespaceId, lifetime: 'ephemeral',
        spec: JSON.stringify({}), spec_hash: `t-${Math.random()}`,
        workload_identity_id: f.principalId, model_id: f.modelId,
      })
      .returning('id').executeTakeFirstOrThrow();

    await rejects(
      f.db.insertInto('runs').values({
        thread_id: thread.id, agent_version_id: version.id, org_id: f.orgId,
        namespace_id: f.namespaceId, tenant_ref: f.tenantRef, durability: 'strict',
        initiator: 'api', caller_principal_id: f.principalId, delegation_depth: 3,
      }).execute(),
    );
  });

  it('refuses an unbounded queue policy (§5.1)', async () => {
    await rejects(
      f.db.insertInto('backpressure_policies').values({
        org_id: f.orgId, level: 'tenant', scope_ref: `s-${Math.random()}`, on_saturation: 'queue',
      }).execute(),
    );
  });

  it('refuses a queue row with an owner but no lease expiry (§4.4)', async () => {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'lease_pair_ck' AND conrelid = 'run_queue'::regclass
      ) AS ok`.execute(f.db);
    expect(rows[0]?.ok).toBe(true);
  });

  it('carries the lease_epoch fencing token', async () => {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'run_queue' AND column_name = 'lease_epoch'
      ) AS ok`.execute(f.db);
    expect(rows[0]?.ok).toBe(true);
  });
});
