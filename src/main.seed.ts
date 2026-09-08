import { loadEnv } from './platform/config/env.schema.js';
import { createDb, createPool } from './platform/persistence/database.js';

/**
 * Minimum reference data for a local run: one org, namespace, tenant, service principal,
 * one model on the echo provider, one HTTP tool, and the capability grants that let the
 * caller select them.
 *
 * The grants are the point. Without them admission refuses the spec -- which is correct
 * behaviour (§16.2), and seeding around it would hide the check this platform exists to
 * enforce.
 */
const env = loadEnv('api');
const pool = createPool(env.DATABASE_URL, 2);
const db = createDb(pool);

const TOOL_TARGET = process.env['SEED_TOOL_URL'] ?? 'http://127.0.0.1:4001/echo';

try {
  await db.transaction().execute(async (tx) => {
    const org = await tx
      .insertInto('orgs')
      .values({ slug: 'acme', name: 'Acme' })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ name: 'Acme' }))
      .returning('id')
      .executeTakeFirstOrThrow();

    const ns = await tx
      .insertInto('namespaces')
      .values({
        org_id: org.id,
        slug: 'demo',
        owning_team: 'platform-eng',
        owner_contact: 'platform-eng@acme',
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'slug']).doUpdateSet({ owning_team: 'platform-eng' }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('tenants')
      .values({ org_id: org.id, namespace_id: ns.id, tenant_ref: 'merchant-1' })
      .onConflict((oc) => oc.columns(['namespace_id', 'tenant_ref']).doNothing())
      .execute();

    const caller = await tx
      .insertInto('principals')
      .values({ org_id: org.id, kind: 'service', subject: 'svc:demo-client', display_name: 'Demo client' })
      .onConflict((oc) =>
        oc.columns(['org_id', 'kind', 'subject']).doUpdateSet({ display_name: 'Demo client' }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();

    const model = await tx
      .insertInto('models')
      .values({
        org_id: org.id,
        ref: 'internal/echo',
        provider: 'echo',
        provider_model_id: 'echo-1',
        residency: 'internal',
        input_cost_micros_per_1k: '100',
        output_cost_micros_per_1k: '300',
      })
      .onConflict((oc) => oc.columns(['org_id', 'ref']).doUpdateSet({ provider: 'echo' }))
      .returning('id')
      .executeTakeFirstOrThrow();

    const tool = await tx
      .insertInto('tools')
      .values({
        org_id: org.id,
        namespace_id: ns.id,
        ref: 'demo.echo',
        origin: 'http',
        residency: 'internal',
        description: 'Echoes its arguments back',
        input_schema: JSON.stringify({ type: 'object' }),
        // read_only + cacheable is the only combination the schema permits to be cached,
        // and it is enforced by a CHECK constraint rather than by this seed remembering.
        default_effects: ['read_only', 'cacheable'],
        sandbox_profile: 'http-egress',
        endpoint_url: TOOL_TARGET,
        timeout_ms: 5_000,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'ref', 'version']).doUpdateSet({ endpoint_url: TOOL_TARGET }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();

    // A gated tool, so the §14 approval path is exercisable rather than theoretical.
    const gated = await tx
      .insertInto('tools')
      .values({
        org_id: org.id,
        namespace_id: ns.id,
        ref: 'demo.gated',
        origin: 'http',
        residency: 'internal',
        description: 'Requires human approval before it runs',
        input_schema: JSON.stringify({ type: 'object' }),
        // §8.3: a side-effecting tool that must not be lost, is safe to retry with a key,
        // and is gated on a human. The binding picks the execution strategy from this.
        default_effects: ['essential', 'idempotent', 'human_approval_required'],
        sandbox_profile: 'http-egress',
        endpoint_url: TOOL_TARGET,
        timeout_ms: 5_000,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'ref', 'version']).doUpdateSet({ endpoint_url: TOOL_TARGET }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();

    for (const [kind, id] of [
      ['model', model.id],
      ['tool', tool.id],
      ['tool', gated.id],
    ] as const) {
      const existing = await tx
        .selectFrom('capability_grants')
        .select('id')
        .where('org_id', '=', org.id)
        .where('resource_kind', '=', kind)
        .where('resource_id', '=', id)
        .executeTakeFirst();
      if (!existing) {
        await tx
          .insertInto('capability_grants')
          .values({
            org_id: org.id,
            grant_source: 'service',
            namespace_id: ns.id,
            resource_kind: kind,
            resource_id: id,
            granted_by: caller.id,
          })
          .execute();
      }
    }

    console.log(
      [
        'seeded:',
        `  org        acme            ${org.id}`,
        `  namespace  demo            ${ns.id}`,
        `  tenant     merchant-1`,
        `  principal  svc:demo-client ${caller.id}`,
        `  model      internal/echo   ${model.id}`,
        `  tool       demo.echo    -> ${TOOL_TARGET}   [readOnly, cacheable]`,
        `  tool       demo.gated   -> ${TOOL_TARGET}   [essential, idempotent, humanApprovalRequired]`,
      ].join('\n'),
    );
  });
} finally {
  await db.destroy();
}
