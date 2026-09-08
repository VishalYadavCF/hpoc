import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

const LOCK_KEY = 4_155_000; // distinct from the scheduler's leader lock

/**
 * Applies numbered .sql files once each, under an advisory lock so concurrent pods
 * cannot race. Re-applying is a no-op; a file whose content changed after being applied
 * is an error rather than a silent divergence.
 */
export async function migrate(pool: pg.Pool, dir: string): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        checksum    text NOT NULL
      )`);

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const seen = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = seen.get(file);

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was modified after being applied. ` +
              `Migrations are immutable history — add a new file instead.`,
          );
        }
        continue;
      }

      // Each migration is one transaction: a failure leaves no partial schema behind.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [file, checksum],
        );
        await client.query('COMMIT');
        applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`, { cause: e });
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
