import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.types.js';

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;
/** Either a pooled handle or an open transaction — every repository accepts both. */
export type Executor = Db | Tx;

// int8 stays a string on the way out, deliberately. `last_event_seq` is incremented
// server-side (UPDATE ... SET last_event_seq = last_event_seq + 1), never in JS, so no
// arithmetic happens here and a string cannot silently lose precision above 2^53.

export function createPool(connectionString: string, max: number): pg.Pool {
  return new pg.Pool({ connectionString, max, application_name: 'agent-platform' });
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
