// Registers the two GitHub tool templates the `pr-review-agent` instantiates, plus their grants.
//
//   github.read    GET  under /repos   read_only        — fetch a PR, its changed files, its reviews
//   github.review  POST under /repos   non_idempotent   — post a review. Posting twice posts twice,
//                                                         so the platform never retries it.
//
// Two templates rather than one because the CONTRACT is per template (§18.5): one template covering
// both would have to declare the whole GitHub surface non_idempotent, and every read would lose
// retries for no reason.
//
// The GitHub user the agent comments AS is whichever token `credential_ref` resolves to (migration
// 0033). The row stores the NAME only; the secret store reads it at call time:
//
//   # .env — a fine-grained PAT with "Pull requests: Read and write" on the target repos
//   GITHUB_TOKEN=github_pat_...            # credential_ref "github_token" (the default)
//
//   node --env-file=.env scripts/seed-github-templates.mjs
//
//   # a second bot user, or GitHub Enterprise
//   CREDENTIAL_REF=github_reviewer_bot GITHUB_API_URL=https://ghe.example.com/api/v3 \
//     node --env-file=.env scripts/seed-github-templates.mjs
//
// Restart the worker after changing the token: it reads the environment once, at start.
// Idempotent: re-running updates both rows in place.
import { sql } from 'kysely';
import { createDb, createPool } from '../dist/platform/persistence/database.js';

const CREDENTIAL_REF = process.env.CREDENTIAL_REF ?? 'github_token';
/** Origin plus, for GHE, its `/api/v3` root. The sandbox refuses any other origin. */
const API_URL = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
const { origin, pathname } = new URL(API_URL);
const ROOT = pathname === '/' ? '' : pathname;
const PATH_PREFIX = `${ROOT}/repos`;
const STATIC_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  // GitHub rejects a request with no User-Agent.
  'user-agent': 'hpoc-pr-review-agent',
};

const TEMPLATES = [
  {
    ref: 'github.read',
    description: 'Read-only GitHub REST calls under /repos (pull requests, files, reviews)',
    default_effects: ['read_only'],
    allowed_methods: ['GET'],
    max_retries: 2,
  },
  {
    ref: 'github.review',
    description: 'Posts a pull request review on GitHub',
    default_effects: ['non_idempotent'],
    allowed_methods: ['POST'],
    // A review of unknown outcome must not be posted again by the platform.
    max_retries: 0,
  },
];

/** Resolved the way EnvSecretStore resolves it, so what this prints is what the worker will send. */
const resolveToken = () => {
  const name = CREDENTIAL_REF.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const raw = process.env[`MODEL_CREDENTIAL_${name}`] ?? process.env[name];
  if (!raw) return null;
  return raw.trimStart().startsWith('{') ? JSON.parse(raw).apiKey ?? JSON.parse(raw).token : raw;
};

const pool = createPool(process.env.DATABASE_URL, 2);
const db = createDb(pool);

try {
  const rows = await db.transaction().execute(async (tx) => {
    // tool_templates has FORCE ROW LEVEL SECURITY; see seed-relay-piece-template.mjs.
    await sql`select set_config('app.bypass_rls', 'on', false)`.execute(tx);

    const org = await tx.selectFrom('orgs').select('id').where('slug', '=', 'acme').executeTakeFirstOrThrow();
    const ns = await tx.selectFrom('namespaces').select('id')
      .where('org_id', '=', org.id).where('slug', '=', 'demo').executeTakeFirstOrThrow();
    const principal = await tx.selectFrom('principals').select('id')
      .where('org_id', '=', org.id).where('subject', '=', 'svc:demo-client').executeTakeFirstOrThrow();

    const out = [];
    for (const t of TEMPLATES) {
      const values = {
        description: t.description,
        default_effects: sql`${t.default_effects}::effect_class[]`,
        residency: 'external',
        sandbox_profile: 'http-egress',
        timeout_ms: 30_000,
        max_retries: t.max_retries,
        endpoint_url: origin,
        allowed_methods: t.allowed_methods,
        path_prefix: PATH_PREFIX,
        static_headers: JSON.stringify(STATIC_HEADERS),
        credential_ref: CREDENTIAL_REF,
        max_instances: 8,
        status: 'active',
      };
      const template = await tx
        .insertInto('tool_templates')
        .values({ org_id: org.id, namespace_id: ns.id, ref: t.ref, version: 1, ...values })
        .onConflict((oc) => oc.columns(['org_id', 'ref', 'version']).doUpdateSet(values))
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

      // Instantiated tools copy credential_ref and static_headers at admission. Re-pointing the
      // template must reach the rows already admitted under it, or a token rotation to a new ref
      // would silently keep sending the old one.
      await tx.updateTable('tools')
        .set({ credential_ref: CREDENTIAL_REF, static_headers: JSON.stringify(STATIC_HEADERS), endpoint_url: origin })
        .where('template_id', '=', template.id)
        .execute();

      out.push(`  ${`${template.ref}@${template.version}`.padEnd(18)} ${t.allowed_methods.join('|').padEnd(5)} ` +
        `${origin}${PATH_PREFIX}/…  [${t.default_effects.join(', ')}]  grant ${granted ? 'present' : 'created'}`);
    }
    return out;
  });

  console.log(['registered GitHub tool templates:', ...rows, `  credential_ref     ${CREDENTIAL_REF}`].join('\n'));

  // Which GitHub user will the reviews be posted as? Checked here so a wrong or missing token
  // shows up now, not as a 401 inside the agent's first run.
  const token = resolveToken();
  if (!token) {
    console.log(`\n  WARNING: no secret for "${CREDENTIAL_REF}" in this environment. Set it in .env and restart the worker.`);
  } else {
    const res = await fetch(`${API_URL}/user`, {
      headers: { ...STATIC_HEADERS, authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    console.log(res.ok
      ? `  github user        ${body.login}  (reviews will be posted as this user)`
      : `\n  WARNING: GitHub rejected the token (${res.status} ${body.message ?? ''})`);
  }
} finally {
  await db.destroy();
}
