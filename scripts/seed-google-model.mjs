// Seeds a Google model row and its capability grant. Reads no secret: the row stores a
// credential_ref NAME, which EnvSecretStore resolves at call time.
//
//   MODEL=gemini-flash-latest node --env-file=.env scripts/seed-google-model.mjs
//
// Limits are taken from the model's own metadata rather than guessed, because
// `max_output_tokens` is now actually forwarded to the provider (see ModelGateway.providerRequest)
// — a value invented here would silently truncate a reasoning model's answer.
import { createDb, createPool } from '../dist/platform/persistence/database.js';

const MODEL = process.env.MODEL ?? 'gemini-flash-latest';
const CREDENTIAL_REF = process.env.CREDENTIAL_REF ?? 'test_llm_key';
const BASE_URL = 'https://generativelanguage.googleapis.com';

const key = process.env.TEST_LLM_KEY ?? process.env.MODEL_CREDENTIAL_TEST_LLM_KEY;
if (!key) throw new Error('No TEST_LLM_KEY in the environment to read model metadata with');

const meta = await fetch(`${BASE_URL}/v1beta/models/${MODEL}?key=${key}`).then((r) => r.json());
if (meta.error) throw new Error(`${MODEL}: ${meta.error.message}`);

const pool = createPool(process.env.DATABASE_URL, 2);
const db = createDb(pool);
try {
  const org = await db.selectFrom('orgs').select('id').where('slug', '=', 'acme').executeTakeFirstOrThrow();
  const ns = await db.selectFrom('namespaces').select('id')
    .where('org_id', '=', org.id).where('slug', '=', 'demo').executeTakeFirstOrThrow();
  const principal = await db.selectFrom('principals').select('id')
    .where('org_id', '=', org.id).where('subject', '=', 'svc:demo-client').executeTakeFirstOrThrow();

  const values = {
    org_id: org.id,
    ref: `google/${MODEL}`,
    provider: 'google',
    provider_model_id: MODEL,
    residency: 'external',
    region: 'global',
    base_url: BASE_URL,
    credential_ref: CREDENTIAL_REF,
    capabilities: JSON.stringify({ nativeLongContext: true, nativeToolLoop: true }),
    context_window_tokens: meta.inputTokenLimit ?? null,
    max_output_tokens: meta.outputTokenLimit ?? null,
    input_cost_micros_per_1k: '300',
    output_cost_micros_per_1k: '2500',
  };

  const model = await db.insertInto('models').values(values)
    .onConflict((oc) => oc.columns(['org_id', 'ref']).doUpdateSet({
      provider_model_id: values.provider_model_id,
      base_url: values.base_url,
      credential_ref: values.credential_ref,
      context_window_tokens: values.context_window_tokens,
      max_output_tokens: values.max_output_tokens,
      status: 'active',
    }))
    .returning('id').executeTakeFirstOrThrow();

  // Without the grant, admission refuses every spec naming the model (§16.2).
  const granted = await db.selectFrom('capability_grants').select('id')
    .where('org_id', '=', org.id).where('resource_kind', '=', 'model')
    .where('resource_id', '=', model.id).where('revoked_at', 'is', null).executeTakeFirst();
  if (!granted) {
    await db.insertInto('capability_grants').values({
      org_id: org.id, grant_source: 'service', namespace_id: ns.id,
      resource_kind: 'model', resource_id: model.id, granted_by: principal.id,
    }).execute();
  }

  console.log(
    [
      `seeded google/${MODEL}`,
      `  id             ${model.id}`,
      `  context        ${values.context_window_tokens}`,
      `  max output     ${values.max_output_tokens}`,
      `  credential_ref ${CREDENTIAL_REF}`,
      `  grant          ${granted ? 'already present' : 'created'}`,
    ].join('\n'),
  );
} finally {
  await db.destroy();
}
