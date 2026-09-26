// Registers a generic HTTP tool template, plus the capability grant admission checks for it.
//
// The general form of seed-relay-piece-template.mjs: same contract-on-the-template rule (§18.5),
// every field taken from the environment so one script serves any HTTP origin. See that script
// for why templates are seeded by an operator rather than registered through the API.
//
// Defaults register `demo.workflow` against scripts/tool-target.mjs, which is what the A2A test
// against agentorchestratorsvc uses as its "create workflow" tool — a stub, so the A2A path is
// the thing under test rather than a real workflow service.
//
//   npm run tool:target &                                        # stub origin on :4001
//   node --env-file=.env scripts/seed-http-template.mjs
//
//   TEMPLATE_REF=relay.workflowsvc ENDPOINT_URL=https://regression.qa.cashfree.net \
//     PATH_PREFIX=/workflowsvc/wfcd/v1/workflows \
//     STATIC_HEADERS='{"X-Merchant-Id":"66625","X-User-Id":"66625"}' \
//     node --env-file=.env scripts/seed-http-template.mjs         # a real origin
//
// Idempotent: re-running updates the row in place.
import { sql } from 'kysely';
import { createDb, createPool } from '../dist/platform/persistence/database.js';

const REF = process.env.TEMPLATE_REF ?? 'demo.workflow';
const DESCRIPTION = process.env.TEMPLATE_DESCRIPTION ?? 'Creates a workflow over HTTP (stub origin)';
/** Origin only. The sandbox refuses any resolved URL whose origin differs from this one. */
const ENDPOINT_URL = process.env.ENDPOINT_URL ?? 'http://127.0.0.1:4001';
const PATH_PREFIX = process.env.PATH_PREFIX ?? '/workflows';
const METHODS = (process.env.METHODS ?? 'POST').split(',').map((m) => m.trim().toUpperCase());
// `non_idempotent` unless told otherwise: creating a workflow twice creates two workflows.
const EFFECTS = (process.env.EFFECTS ?? 'non_idempotent').split(',').map((e) => e.trim());
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 30_000);
/** JSON object of headers sent on every call. Never credentials: those are minted per call. */
const STATIC_HEADERS = JSON.parse(process.env.STATIC_HEADERS ?? '{}');

const pool = createPool(process.env.DATABASE_URL, 2);
const db = createDb(pool);

try {
  await db.transaction().execute(async (tx) => {
    // tool_templates has FORCE ROW LEVEL SECURITY; see seed-relay-piece-template.mjs.
    await sql`select set_config('app.bypass_rls', 'on', false)`.execute(tx);

    const org = await tx.selectFrom('orgs').select('id').where('slug', '=', 'acme').executeTakeFirstOrThrow();
    const ns = await tx.selectFrom('namespaces').select('id')
      .where('org_id', '=', org.id).where('slug', '=', 'demo').executeTakeFirstOrThrow();
    const principal = await tx.selectFrom('principals').select('id')
      .where('org_id', '=', org.id).where('subject', '=', 'svc:demo-client').executeTakeFirstOrThrow();

    const template = await tx
      .insertInto('tool_templates')
      .values({
        org_id: org.id,
        namespace_id: ns.id,
        ref: REF,
        version: 1,
        description: DESCRIPTION,
        default_effects: EFFECTS,
        residency: 'internal',
        sandbox_profile: 'http-egress',
        timeout_ms: TIMEOUT_MS,
        // A non-idempotent call of unknown outcome must not be repeated by the platform.
        max_retries: EFFECTS.includes('non_idempotent') ? 0 : 2,
        endpoint_url: ENDPOINT_URL,
        allowed_methods: METHODS,
        path_prefix: PATH_PREFIX,
        static_headers: JSON.stringify(STATIC_HEADERS),
        max_instances: 16,
        status: 'active',
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'ref', 'version']).doUpdateSet({
          description: DESCRIPTION,
          default_effects: EFFECTS,
          endpoint_url: ENDPOINT_URL,
          allowed_methods: METHODS,
          path_prefix: PATH_PREFIX,
          timeout_ms: TIMEOUT_MS,
          static_headers: JSON.stringify(STATIC_HEADERS),
          status: 'active',
        }),
      )
      .returning(['id', 'ref', 'version'])
      .executeTakeFirstOrThrow();

    // Without the grant, admission refuses every spec that instantiates this template (§16.2).
    const granted = await tx.selectFrom('capability_grants').select('id')
      .where('org_id', '=', org.id).where('resource_kind', '=', 'tool_template')
      .where('resource_id', '=', template.id).where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (!granted) {
      await tx.insertInto('capability_grants').values({
        org_id: org.id, grant_source: 'service', namespace_id: ns.id,
        resource_kind: 'tool_template', resource_id: template.id, granted_by: principal.id,
      }).execute();
    }

    console.log([
      'registered tool template:',
      `  ref       ${template.ref}@${template.version}`,
      `  id        ${template.id}`,
      `  endpoint  ${METHODS.join('|')} ${ENDPOINT_URL}${PATH_PREFIX}/…`,
      `  effects   [${EFFECTS.join(', ')}]`,
      `  headers   ${JSON.stringify(STATIC_HEADERS)}`,
      `  grant     ${granted ? 'already present' : 'created'}`,
    ].join('\n'));
  });
} finally {
  await db.destroy();
}
