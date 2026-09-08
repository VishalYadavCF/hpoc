import { z } from 'zod';

/**
 * One schema, validated once at boot, reporting EVERY problem rather than the first.
 * A process that starts with three bad vars should say so once, not three deploys running.
 */
const base = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1),
  /**
   * §5.2 RLS. The role api/worker/scheduler connect as -- distinct from the owner role
   * `DATABASE_URL` uses for migrations and seeding, which always bypasses RLS. Falls back
   * to `DATABASE_URL` (the owner) when unset, which makes RLS a no-op until an operator
   * actually creates the least-privileged role (migration 0019) and points this at it.
   */
  APP_DATABASE_URL: z.string().min(1).optional(),
  /**
   * Direct connection, bypassing any transaction-mode pooler. LISTEN holds a session,
   * so it cannot run through PgBouncer in transaction pooling mode (§12.1). Falls back
   * to DATABASE_URL for local development where there is no pooler in the way.
   */
  LISTENER_DATABASE_URL: z.string().min(1).optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** A lease crash is retried at most this many times before the scheduler dead-letters it. */
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
});

const api = base.extend({
  PORT: z.coerce.number().int().positive().default(3000),
  SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(20_000),
  /** Clients reconnecting past this window must re-read state, not assume continuity. */
  SSE_REPLAY_RETENTION_HOURS: z.coerce.number().int().positive().default(24),
  SSE_MAX_BUFFERED_EVENTS: z.coerce.number().int().positive().default(1_000),
});

const worker = base.extend({
  WORKER_POOL: z.string().default('default'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  LEASE_TTL_MS: z.coerce.number().int().positive().default(30_000),
  /** Heartbeat at a third of the TTL: two may be lost before the lease is at risk. */
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  MAX_DELEGATION_DEPTH: z.coerce.number().int().positive().max(16).default(8),
  SANDBOX_PROFILE: z.string().default('default'),
  HEALTH_PORT: z.coerce.number().int().positive().default(3001),
});

const scheduler = base.extend({
  SCHEDULER_LOCK_KEY: z.coerce.number().int().default(4_155_001),
  RECLAIM_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  RECLAIM_BATCH_SIZE: z.coerce.number().int().positive().default(1_000),
  OUTBOX_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  EXPIRY_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  HEALTH_PORT: z.coerce.number().int().positive().default(3002),
});

export type ApiEnv = z.infer<typeof api>;
export type WorkerEnv = z.infer<typeof worker>;
export type SchedulerEnv = z.infer<typeof scheduler>;
export type AnyEnv = ApiEnv & Partial<WorkerEnv> & Partial<SchedulerEnv>;

const schemas = { api, worker, scheduler } as const;
export type ProcessRole = keyof typeof schemas;

export function loadEnv<R extends ProcessRole>(
  role: R,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<(typeof schemas)[R]> {
  const result = schemas[role].safeParse(source);
  if (result.success) return result.data as z.infer<(typeof schemas)[R]>;

  // Collect-all, not fail-first.
  const problems = result.error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid configuration for "${role}" process:\n${problems}`);
}
