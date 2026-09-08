// Seeds a live Gemini model. Reads no secret: the row stores a credential_ref NAME only.
import { createDb, createPool } from '../dist/platform/persistence/database.js';

const pool = createPool(process.env.DATABASE_URL, 2);
const db = createDb(pool);
try {
  const org = await db.selectFrom('orgs').select('id').where('slug', '=', 'acme').executeTakeFirstOrThrow();
  const ns = await db.selectFrom('namespaces').select('id')
    .where('org_id', '=', org.id).where('slug', '=', 'demo').executeTakeFirstOrThrow();
  const principal = await db.selectFrom('principals').select('id')
    .where('org_id', '=', org.id).where('subject', '=', 'svc:demo-client').executeTakeFirstOrThrow();

  const model = await db.insertInto('models').values({
    org_id: org.id,
    ref: 'google/gemini-2.5-flash',
    provider: 'google',
    provider_model_id: 'gemini-2.5-flash',
    residency: 'external',
    region: 'global',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    credential_ref: 'test_llm_key',
    capabilities: JSON.stringify({ nativeLongContext: true, nativeToolLoop: true }),
    context_window_tokens: 1048576,
    max_output_tokens: 8192,
    input_cost_micros_per_1k: '300',
    output_cost_micros_per_1k: '2500',
  }).onConflict((oc) => oc.columns(['org_id','ref']).doUpdateSet({
    provider_model_id: 'gemini-2.5-flash',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    credential_ref: 'test_llm_key',
  })).returning('id').executeTakeFirstOrThrow();

  const existing = await db.selectFrom('capability_grants').select('id')
    .where('org_id','=',org.id).where('resource_kind','=','model')
    .where('resource_id','=',model.id).executeTakeFirst();
  if (!existing) {
    await db.insertInto('capability_grants').values({
      org_id: org.id, grant_source: 'service', namespace_id: ns.id,
      resource_kind: 'model', resource_id: model.id, granted_by: principal.id,
    }).execute();
  }
  console.log(`seeded google/gemini-2.5-flash  model_id=${model.id}  credential_ref=test_llm_key`);
} finally { await db.destroy(); }
