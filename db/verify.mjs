#!/usr/bin/env node
// Verifies that the database Prisma migrated actually enforces what the design
// requires. Counting catalog rows is not enough: the three things Prisma cannot
// express are reapplied by prisma/patch-baseline.mjs, and a regeneration that
// silently dropped them would still produce a database with all 54 tables.
//
// Everything runs inside a transaction that is rolled back, so it is safe
// against a database with data in it.
//
//   npm run db:verify
import pg from 'pg';

const url =
  process.env.DATABASE_URL ?? 'postgresql://hpoc:hpoc@localhost:5440/hpoc';

const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
}

/** Asserts a statement is rejected, and by the constraint we expect. */
async function expectRejection(client, name, constraint, sql, params = []) {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(sql, params);
    await client.query('ROLLBACK TO SAVEPOINT probe');
    record(name, false, 'statement was ACCEPTED; constraint is not enforced');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    const hit = err.constraint ?? '(none)';
    record(name, hit === constraint, `rejected by ${hit}`);
  }
}

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('BEGIN');

try {
  // --- extensions --------------------------------------------------------
  const wanted = [
    ['vector', 'vector storage'],
    ['timescaledb', 'time series'],
    ['pg_cron', 'caching: scheduled refresh'],
    ['pg_prewarm', 'caching: buffer preload'],
    ['pg_stat_statements', 'observability'],
    ['pg_buffercache', 'observability'],
    ['pg_wait_sampling', 'observability'],
    ['pg_stat_kcache', 'observability'],
    ['pgcrypto', 'schema'],
    ['citext', 'schema'],
  ];
  const { rows: ext } = await client.query('SELECT extname FROM pg_extension');
  const have = new Set(ext.map((r) => r.extname));
  for (const [name, why] of wanted) {
    record(`extension ${name}`, have.has(name), why);
  }

  // --- structure ---------------------------------------------------------
  const one = async (sql) => (await client.query(sql)).rows[0].v;

  const tables = await one(`
    SELECT count(*)::int AS v FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      AND c.relname <> '_prisma_migrations'
      AND c.oid NOT IN (SELECT objid FROM pg_depend WHERE deptype = 'e')`);
  record('54 application tables', tables === 54, `found ${tables}`);

  const checks = await one(`
    SELECT count(*)::int AS v FROM pg_constraint
    WHERE contype = 'c' AND connamespace = 'public'::regnamespace`);
  record('38 CHECK constraints', checks === 38, `found ${checks}`);

  const fks = await one(`
    SELECT count(*)::int AS v FROM pg_constraint
    WHERE contype = 'f' AND connamespace = 'public'::regnamespace`);
  record('166 foreign keys', fks === 166, `found ${fks}`);

  const enums = await one(`
    SELECT count(*)::int AS v FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'`);
  record('28 enum types', enums === 28, `found ${enums}`);

  // --- partitioning ------------------------------------------------------
  const { rows: parts } = await client.query(`
    SELECT c.relname, pg_get_partkeydef(c.oid) AS keydef,
           (SELECT count(*)::int FROM pg_inherits i WHERE i.inhparent = c.oid) AS children
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'p'
    ORDER BY c.relname`);
  record(
    'events / usage_ledger / audit_log partitioned',
    parts.length === 3 &&
      parts.every((p) => p.keydef === 'RANGE (occurred_at)' && p.children >= 1),
    parts
      .map((p) => `${p.relname} ${p.keydef} children=${p.children}`)
      .join('; '),
  );

  // --- the vector column and its index -----------------------------------
  const vecType = await one(`
    SELECT format_type(atttypid, atttypmod) AS v FROM pg_attribute
    WHERE attrelid = 'memory_embeddings'::regclass AND attname = 'embedding'`);
  record('embedding is vector(1536)', vecType === 'vector(1536)', vecType);

  const amname = await one(`
    SELECT am.amname AS v
    FROM pg_class i
    JOIN pg_am am ON am.oid = i.relam
    WHERE i.relname = 'memory_embeddings_ann_idx'`);
  record('ANN index uses hnsw', amname === 'hnsw', `access method: ${amname}`);

  // An hnsw index that exists but is never chosen is no better than none.
  // Empty tables always seq scan, so force the planner's hand.
  await client.query('SET LOCAL enable_seqscan = off');
  const probeVector = `[${Array(1536).fill(0).join(',')}]`;
  const { rows: planRows } = await client.query(
    `EXPLAIN (FORMAT JSON) SELECT memory_id FROM memory_embeddings
     ORDER BY embedding <=> $1::vector LIMIT 5`,
    [probeVector],
  );
  const plan = JSON.stringify(planRows[0]['QUERY PLAN']);
  record(
    'planner chooses the ANN index for <=>',
    plan.includes('memory_embeddings_ann_idx'),
    plan.includes('memory_embeddings_ann_idx')
      ? 'index scan'
      : plan.slice(0, 120),
  );

  // --- enforcement probes ------------------------------------------------
  const { rows: orgRows } = await client.query(
    `INSERT INTO orgs (slug, name) VALUES ('probe-org', 'Probe Org') RETURNING id`,
  );
  const orgId = orgRows[0].id;

  await expectRejection(
    client,
    'CHECK rejects a self-referencing lineage edge',
    'lineage_no_self_ck',
    `INSERT INTO lineage_edges
       (org_id, tenant_ref, derived_kind, derived_id, source_kind, source_id, relation)
     VALUES ($1, 't', 'run', $2, 'run', $2, 'derived_from')`,
    [orgId, orgId],
  );

  await expectRejection(
    client,
    'unique index rejects a duplicate org slug',
    'orgs_slug_key',
    `INSERT INTO orgs (slug, name) VALUES ('probe-org', 'Duplicate')`,
  );

  // A valid lineage edge must still insert - a probe that only proves things
  // are rejected cannot distinguish a working constraint from a broken table.
  await client.query('SAVEPOINT ok');
  try {
    await client.query(
      `INSERT INTO lineage_edges
         (org_id, tenant_ref, derived_kind, derived_id, source_kind, source_id, relation)
       VALUES ($1, 't', 'run', gen_random_uuid(), 'artifact', gen_random_uuid(), 'derived_from')`,
      [orgId],
    );
    record('a valid lineage edge still inserts', true, 'accepted');
  } catch (err) {
    record('a valid lineage edge still inserts', false, err.message);
  }
  await client.query('ROLLBACK TO SAVEPOINT ok');
} finally {
  await client.query('ROLLBACK');
  await client.end();
}

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(
    `${r.ok ? '  ok  ' : ' FAIL '} ${r.name.padEnd(width)}  ${r.detail ?? ''}`,
  );
}
console.log(
  `\n${results.length - failed}/${results.length} checks passed` +
    (failed ? ` — ${failed} FAILED` : ''),
);
process.exit(failed ? 1 : 0);
