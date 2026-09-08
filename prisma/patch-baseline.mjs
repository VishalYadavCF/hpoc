#!/usr/bin/env node
// Re-applies the three things Prisma's datamodel cannot express to a freshly
// generated baseline migration:
//
//   1. PARTITION BY RANGE (occurred_at) on events / usage_ledger / audit_log,
//      plus their DEFAULT partitions. A plain table cannot be turned into a
//      partitioned one by ALTER, so this has to happen in the CREATE TABLE.
//   2. The hnsw index on memory_embeddings.embedding. Prisma emits a btree
//      index for @@index([embedding]), which pgvector cannot use for ANN search.
//   3. The CHECK constraints. These are the invariants the ERD describes as
//      engine-enforced; without them the database accepts states the design
//      says are unrepresentable.
//
// The CHECK definitions are read from a *reference database* rather than
// parsed out of db/schema.sql. Postgres names an inline column constraint
// (`size_bytes bigint CHECK (size_bytes >= 0)`) itself, as
// <table>_<column>_check, so text parsing has to reimplement that naming to
// get the same result. pg_get_constraintdef is the canonical rendering and
// covers both the named and inline forms for free.
//
// See prisma/README.md for the full regeneration procedure.
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const PARTITIONED = {
  events: 'occurred_at',
  usage_ledger: 'occurred_at',
  audit_log: 'occurred_at',
};

const [migrationPath, referenceUrl] = process.argv.slice(2);
if (!migrationPath || !referenceUrl) {
  console.error(
    'usage: node prisma/patch-baseline.mjs <migration.sql> <reference database url>',
  );
  console.error('  the reference database is one with db/schema.sql applied');
  process.exit(1);
}

let sql = readFileSync(migrationPath, 'utf8');

if (sql.includes('-- BEGIN hand-maintained')) {
  console.error(`${migrationPath} is already patched; regenerate it first.`);
  process.exit(1);
}

// --- 0. extensions the datamodel depends on --------------------------------
// These three must be in the migration, not only in the container's init
// script. `migrate dev` builds its shadow database from template0 and replays
// the migrations into it, so anything the init script did is absent there -
// the first CITEXT column then fails with `type "citext" does not exist`, in
// the shadow database only, which is a confusing way to find out.
//
// timescaledb, pg_cron and the observability extensions deliberately stay out
// of here: nothing in the datamodel refers to them, and two of them need
// shared_preload_libraries anyway, so a migration cannot create them from
// nothing. They belong to the server, not the schema.
sql =
  [
    '-- Extensions required by this datamodel.',
    '-- See prisma/README.md for why they live here and not only in',
    '-- db/postgres/init/00-extensions.sql.',
    'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
    'CREATE EXTENSION IF NOT EXISTS citext;',
    'CREATE EXTENSION IF NOT EXISTS vector;',
    '',
    '',
  ].join('\n') + sql;

// --- 1. partitioning -------------------------------------------------------
// Turn the closing `);` of each partitioned table's CREATE TABLE into
// `) PARTITION BY RANGE ("<key>");`.
for (const [table, key] of Object.entries(PARTITIONED)) {
  const re = new RegExp(`(CREATE TABLE "${table}" \\([\\s\\S]*?\\n)\\);`, 'm');
  const before = sql;
  sql = sql.replace(re, `$1) PARTITION BY RANGE ("${key}");`);
  if (sql === before) {
    console.error(`could not find CREATE TABLE "${table}" to partition`);
    process.exit(1);
  }
}

// --- 2. hnsw ---------------------------------------------------------------
// Drop Prisma's btree rendering of the ANN index; the real one is appended below.
const annRe = /^CREATE INDEX "memory_embeddings_ann_idx".*$/m;
if (!annRe.test(sql)) {
  console.error('could not find memory_embeddings_ann_idx to replace');
  process.exit(1);
}
sql = sql.replace(
  annRe,
  '-- memory_embeddings_ann_idx is created as hnsw at the end of this file.',
);

// --- 3. CHECK constraints --------------------------------------------------
// coninhcount = 0 and NOT relispartition together exclude the copies Postgres
// propagates down to partition children - those come back automatically when
// the partition is created, and re-adding them by hand would fail.
const client = new pg.Client({ connectionString: referenceUrl });
await client.connect();

let checks;
try {
  const { rows } = await client.query(`
    SELECT rel.relname AS table_name,
           con.conname AS constraint_name,
           pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE con.contype = 'c'
      AND n.nspname = 'public'
      AND con.coninhcount = 0
      AND NOT rel.relispartition
    ORDER BY rel.relname, con.conname
  `);
  checks = rows;
} finally {
  await client.end();
}

if (checks.length === 0) {
  console.error(`no CHECK constraints found in ${referenceUrl}`);
  console.error('is db/schema.sql applied to it?');
  process.exit(1);
}

const lines = [
  '',
  '-- BEGIN hand-maintained -----------------------------------------------',
  '-- Everything below is outside what the Prisma datamodel can express, and',
  '-- is reapplied by prisma/patch-baseline.mjs when this baseline is',
  '-- regenerated. Editing schema.prisma does not update any of it.',
  '',
  '-- Default partitions. Monthly partitions are created by the retention job;',
  '-- DEFAULT catches anything landing outside a declared range rather than',
  '-- failing the insert.',
];
for (const table of Object.keys(PARTITIONED)) {
  lines.push(
    `CREATE TABLE "${table}_default" PARTITION OF "${table}" DEFAULT;`,
  );
}

lines.push(
  '',
  '-- ANN index for pgvector. vector_cosine_ops matches the cosine distance',
  '-- operator (<=>); a query written with a different operator will not use it.',
  'CREATE INDEX "memory_embeddings_ann_idx"',
  '    ON "memory_embeddings" USING hnsw ("embedding" vector_cosine_ops);',
  '',
  `-- ${checks.length} CHECK constraints.`,
);

for (const c of checks) {
  lines.push(
    `ALTER TABLE "${c.table_name}" ADD CONSTRAINT "${c.constraint_name}" ${c.definition};`,
  );
}

lines.push(
  '',
  '-- END hand-maintained -------------------------------------------------',
  '',
);

writeFileSync(migrationPath, sql + lines.join('\n'));

console.log(`patched ${migrationPath}`);
console.log(`  partitioned : ${Object.keys(PARTITIONED).join(', ')}`);
console.log(`  hnsw index  : memory_embeddings_ann_idx`);
console.log(`  checks      : ${checks.length}`);
