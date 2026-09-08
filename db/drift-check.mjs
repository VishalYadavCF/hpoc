/**
 * Fails when db/schema.sql and db/migrations/ describe different schemas.
 *
 * `db/schema.sql` is documentation -- the readable whole-schema reference -- while the
 * migrations are what actually runs. Documentation that can drift silently is worse than
 * none, because it gets trusted: this reference was missing `run_queue.lease_epoch` (the
 * fencing token, i.e. the single most load-bearing column in the queue) plus a whole
 * table and a dozen columns, having drifted since migration 0005.
 *
 * Compares the migrated database against a scratch database built from schema.sql, on
 * columns, constraints and indexes. Auto-created partitions and extension-owned relations
 * are excluded -- they exist in the migrated database by operation, not by declaration.
 */
import { execFileSync } from 'node:child_process';

const container = process.env['PG_CONTAINER'] ?? 'hpoc-pg';
const user = process.env['POSTGRES_USER'] ?? 'hpoc';
const migrated = process.env['POSTGRES_DB'] ?? 'hpoc';
const reference = process.env['REFERENCE_DB'] ?? 'hpoc_reference';

// Monthly partitions are created by the scheduler, and extension views by CREATE
// EXTENSION. Neither is declared in schema.sql and neither should be.
const EXCLUDE = `
  table_name !~ '_[0-9]{4}_[0-9]{2}$'
  AND left(table_name, 3) <> 'pg_'
  AND left(table_name, 6) <> 'hypopg'
  AND table_name <> 'schema_migrations'
`;

const q = (db, sql) =>
  execFileSync('docker', ['exec', container, 'psql', '-U', user, '-d', db, '-tAc', sql], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();

const QUERIES = {
  columns: `SELECT table_name || '.' || column_name || ' ' || data_type ||
                   coalesce(' default ' || column_default, '') ||
                   ' ' || is_nullable
              FROM information_schema.columns
             WHERE table_schema = 'public' AND ${EXCLUDE}`,
  constraints: `SELECT c.conname || ' ' || pg_get_constraintdef(c.oid)
                  FROM pg_constraint c
                  JOIN pg_class t ON t.oid = c.conrelid
                  JOIN pg_namespace n ON n.oid = t.relnamespace
                 WHERE n.nspname = 'public'
                   AND t.relname !~ '_[0-9]{4}_[0-9]{2}$'
                   AND t.relname <> 'schema_migrations'`,
  indexes: `SELECT indexname || ' ' || indexdef FROM pg_indexes
             WHERE schemaname = 'public'
               AND tablename !~ '_[0-9]{4}_[0-9]{2}$'
               AND left(tablename, 3) <> 'pg_'
               AND tablename <> 'schema_migrations'`,
};

let drifted = false;
for (const [what, sql] of Object.entries(QUERIES)) {
  const live = q(migrated, sql);
  const ref = q(reference, sql);
  const onlyLive = live.filter((x) => !ref.includes(x));
  const onlyRef = ref.filter((x) => !live.includes(x));
  if (onlyLive.length === 0 && onlyRef.length === 0) {
    console.log(`  ${what}: ${live.length} match`);
    continue;
  }
  drifted = true;
  console.error(`\n  ${what}: DRIFT`);
  for (const x of onlyLive) console.error(`    migrations only:  ${x}`);
  for (const x of onlyRef) console.error(`    schema.sql only:  ${x}`);
}

if (drifted) {
  console.error(
    '\ndb/schema.sql disagrees with db/migrations/. The migrations are what runs, so fold\n' +
      'the difference into schema.sql -- as real DDL inside the CREATE TABLE, not as a\n' +
      'commented ALTER, or this check cannot see it.\n',
  );
  process.exit(1);
}
console.log('db/schema.sql matches db/migrations/');
