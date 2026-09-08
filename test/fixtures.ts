import { createDb, createPool, type Db } from '../src/platform/persistence/database.js';

export interface Fixture {
  db: Db;
  orgId: string;
  namespaceId: string;
  tenantRef: string;
  principalId: string;
  modelId: string;
  close: () => Promise<void>;
}

/** Resolves the seeded reference data; `npm run db:seed` must have run. */
export async function fixture(): Promise<Fixture> {
  const pool = createPool(process.env['DATABASE_URL']!, 4);
  const db = createDb(pool);

  const org = await db.selectFrom('orgs').select('id').where('slug', '=', 'acme').executeTakeFirst();
  if (!org) throw new Error('Run `npm run db:migrate && npm run db:seed` first.');

  const ns = await db
    .selectFrom('namespaces').select('id')
    .where('org_id', '=', org.id).where('slug', '=', 'demo').executeTakeFirstOrThrow();
  const principal = await db
    .selectFrom('principals').select('id')
    .where('org_id', '=', org.id).where('subject', '=', 'svc:demo-client').executeTakeFirstOrThrow();
  const model = await db
    .selectFrom('models').select('id')
    .where('org_id', '=', org.id).where('ref', '=', 'internal/echo').executeTakeFirstOrThrow();

  return {
    db,
    orgId: org.id,
    namespaceId: ns.id,
    tenantRef: 'merchant-1',
    principalId: principal.id,
    modelId: model.id,
    close: () => db.destroy(),
  };
}

/** A minimal run row, enough to exercise the queue and event log. */
export async function makeRun(f: Fixture): Promise<{ runId: string; threadId: string }> {
  const thread = await f.db
    .insertInto('threads')
    .values({ org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef })
    .returning('id').executeTakeFirstOrThrow();

  const version = await f.db
    .insertInto('agent_versions')
    .values({
      org_id: f.orgId, namespace_id: f.namespaceId, lifetime: 'ephemeral',
      spec: JSON.stringify({ framework: 'echo' }),
      spec_hash: `test-${Math.random().toString(36).slice(2)}`,
      workload_identity_id: f.principalId, model_id: f.modelId,
    })
    .returning('id').executeTakeFirstOrThrow();

  const run = await f.db
    .insertInto('runs')
    .values({
      thread_id: thread.id, agent_version_id: version.id, org_id: f.orgId,
      namespace_id: f.namespaceId, tenant_ref: f.tenantRef, durability: 'strict',
      initiator: 'api', caller_principal_id: f.principalId,
    })
    .returning('id').executeTakeFirstOrThrow();

  return { runId: run.id, threadId: thread.id };
}
