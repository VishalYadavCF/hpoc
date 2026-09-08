import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './platform/config/env.schema.js';
import { createPool } from './platform/persistence/database.js';
import { migrate } from './platform/persistence/migrator.js';

const env = loadEnv('api');
const pool = createPool(env.DATABASE_URL, 2);
// Migrations live in db/, beside schema.sql, not in dist/.
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'db', 'migrations');

try {
  const applied = await migrate(pool, dir);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date');
} finally {
  await pool.end();
}
