// Registers the `relay.piece` tool template — the one an ap-executor `ai-agent-v2` node
// instantiates, once per piece action a workflow author selects.
//
// A SCRIPT rather than an API call because there is no control-plane route for tool templates, and
// that is deliberate: §18.5 puts the CONTRACT (effects, residency, sandbox profile, timeout, and the
// reachable origin) on the template, where only an operator can set it, and lets a spec supply only
// the SHAPE. A caller able to declare its own effects could self-declare a payment tool read-only,
// skip its approval gate and have the result cached.
//
// Idempotent: re-running updates the row in place. Usage:
//   node --env-file=.env scripts/seed-relay-piece-template.mjs
//   AP_EXECUTOR_URL=http://ap-executor:3000 node --env-file=.env scripts/seed-relay-piece-template.mjs
import { sql } from 'kysely';
import { createDb, createPool } from '../dist/platform/persistence/database.js';

/**
 * ap-executor's ORIGIN only. `buildHttpRequest` joins this with the path, so including a path here
 * would duplicate it — and the sandbox refuses any resolved URL whose origin differs from this one.
 */
const AP_EXECUTOR_URL = process.env.AP_EXECUTOR_URL ?? 'http://127.0.0.1:3100';

/**
 * ap-executor's EXISTING execute route. No dedicated endpoint is needed: an instantiation names
 * `/api/v1/execute/{nodeName}` below this prefix, and the node shapes the body to match
 * `ExecuteRequestSchema` exactly.
 */
const PATH_PREFIX = '/api/v1/execute';

const pool = createPool(process.env.DATABASE_URL, 2);
const db = createDb(pool);

try {
  await db.transaction().execute(async (tx) => {
    // tool_templates has FORCE ROW LEVEL SECURITY, so even the table owner is subject to the
    // policy. Set inside the transaction so it applies to this pinned connection — the same
    // mechanism the platform's own ops path uses (see tenant-connection.ts).
    await sql`select set_config('app.bypass_rls', 'on', false)`.execute(tx);

    const org = await tx
      .selectFrom('orgs')
      .select('id')
      .where('slug', '=', 'acme')
      .executeTakeFirstOrThrow();

    const ns = await tx
      .selectFrom('namespaces')
      .select('id')
      .where('org_id', '=', org.id)
      .where('slug', '=', 'demo')
      .executeTakeFirstOrThrow();

    const principal = await tx
      .selectFrom('principals')
      .select('id')
      .where('org_id', '=', org.id)
      .where('subject', '=', 'svc:demo-client')
      .executeTakeFirstOrThrow();

    const template = await tx
      .insertInto('tool_templates')
      .values({
        org_id: org.id,
        namespace_id: ns.id,
        ref: 'relay.piece',
        version: 1,
        description: 'Executes one Relay piece action through ap-executor',

        // THE CONTRACT — inherited by every instantiation, not expressible in a spec.
        //
        // `non_idempotent` because ONE template covers every piece action, and the set spans
        // "list spreadsheet rows" to "send a payment". The contract has to hold for the most
        // dangerous member, so nothing here is cacheable or auto-retryable. A read-only,
        // cacheable subset would need its OWN template that only such actions may instantiate.
        default_effects: ['non_idempotent'],
        residency: 'internal',
        sandbox_profile: 'http-egress',
        // Matches ap-executor's AGENT_TOOL_TIMEOUT_MS default.
        timeout_ms: 30_000,
        // A non-idempotent call of unknown outcome must not be repeated by the platform.
        max_retries: 0,

        // THE REACHABLE SURFACE — origin fixed here; a spec may only name a path below the prefix.
        endpoint_url: AP_EXECUTOR_URL,
        allowed_methods: ['POST'],
        path_prefix: PATH_PREFIX,
        // Never credentials: those are minted per call by the broker against this audience.
        //
        // `x-agent-depth` preserves v1's recursion guard across the platform hop: ap-executor
        // refuses to start an async action from a nested tool call, so an agent cannot invoke an
        // agent. Without it every call from hpoc would look like an original request.
        static_headers: JSON.stringify({ 'x-agent-depth': '1' }),

        // One instantiation per piece action per node. The spec itself caps `tools` at 64, so
        // this ceiling is the binding one only for a node configured beyond that.
        max_instances: 64,
        status: 'active',
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'ref', 'version']).doUpdateSet({
          endpoint_url: AP_EXECUTOR_URL,
          path_prefix: PATH_PREFIX,
          static_headers: JSON.stringify({ 'x-agent-depth': '1' }),
          status: 'active',
        }),
      )
      .returning(['id', 'ref', 'version'])
      .executeTakeFirstOrThrow();

    // The grant is the point. Admission checks `tool_template` capability at instantiation, so
    // without this every spec naming `relay.piece` is REJECTED — which is correct behaviour
    // (§16.2), and seeding around it would hide the check the platform exists to enforce.
    const granted = await tx
      .selectFrom('capability_grants')
      .select('id')
      .where('org_id', '=', org.id)
      .where('resource_kind', '=', 'tool_template')
      .where('resource_id', '=', template.id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    if (!granted) {
      await tx
        .insertInto('capability_grants')
        .values({
          org_id: org.id,
          grant_source: 'service',
          namespace_id: ns.id,
          resource_kind: 'tool_template',
          resource_id: template.id,
          granted_by: principal.id,
        })
        .execute();
    }

    console.log(
      [
        'registered tool template:',
        `  ref            ${template.ref}@${template.version}`,
        `  id             ${template.id}`,
        `  endpoint       ${AP_EXECUTOR_URL}${PATH_PREFIX}/{nodeName}`,
        `  effects        [non_idempotent]  (not cacheable, not auto-retried)`,
        `  grant          ${granted ? 'already present' : 'created'}`,
      ].join('\n'),
    );
  });
} finally {
  await db.destroy();
}
