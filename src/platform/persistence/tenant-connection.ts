import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';

export interface TenantScope {
  /** Set for tenant-scoped work: everything this connection touches belongs to this org. */
  orgId?: string;
  /** Set for platform-internal sweeps that must see across every org by design. */
  bypass?: boolean;
}

const pinStorage = new AsyncLocalStorage<pg.PoolClient>();
const wrapperCache = new WeakMap<pg.PoolClient, pg.PoolClient>();

/**
 * A client whose `.release()` is a no-op. The PIN, not Kysely, owns the real release --
 * Kysely calls `.release()` once per query when it is not inside its own `.transaction()`,
 * and a real release there would hand this physical connection back to the pool mid-request.
 */
function nonReleasing(client: pg.PoolClient): pg.PoolClient {
  const cached = wrapperCache.get(client);
  if (cached) return cached;
  const wrapped = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'release') return () => {};
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  wrapperCache.set(client, wrapped);
  return wrapped;
}

/**
 * §5.2 RLS. Wraps a real pool so Kysely's driver -- which calls `.connect()` once per
 * top-level query outside an explicit transaction -- transparently reuses the ONE pinned
 * connection for every query issued inside `withTenantConnection` or `runPinned`.
 *
 * This is what makes a session-level `SET app.org_id` (via `set_config`) actually apply
 * to every later statement in the pin's scope. `SET LOCAL` was not an option: most reads
 * in this codebase are standalone autocommit statements, each its own implicit
 * transaction, and a transaction-local setting evaporates before the next one runs.
 *
 * Harmless to apply unconditionally, including when the connecting role is the table
 * owner (the default today, until `APP_DATABASE_URL` points at a separate, non-owner
 * role): an owner bypasses RLS regardless of what `app.org_id` is set to, so this is
 * inert until that role separation is actually adopted.
 */
export function tenantScopedPool(pool: pg.Pool): pg.Pool {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return async (...args: unknown[]) => {
          const pinned = pinStorage.getStore();
          if (pinned) return nonReleasing(pinned);
          return (target.connect as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as pg.Pool;
}

/**
 * Checks out one real connection, sets its session-level tenant GUC, and returns it
 * pinned along with a release function. Split from `withTenantConnection` for callers
 * whose scope does not correspond to one bounded `await` -- an HTTP middleware's `next()`
 * returns long before the request it kicked off actually finishes, so the release there
 * has to be tied to the response lifecycle instead of to `next()` returning.
 */
export async function acquireTenantConnection(
  pool: pg.Pool,
  scope: TenantScope,
): Promise<{ client: pg.PoolClient; release: () => Promise<void> }> {
  const client = await pool.connect();
  if (scope.bypass) {
    await client.query(`select set_config('app.bypass_rls', 'on', false)`);
  } else if (scope.orgId) {
    await client.query(`select set_config('app.org_id', $1, false)`, [scope.orgId]);
  }

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    // Reset before the connection goes back to the pool: the NEXT checkout, tenant-scoped
    // or not, must never inherit a GUC this request set and forgot to clear.
    await client
      .query(`select set_config('app.org_id', null, false), set_config('app.bypass_rls', null, false)`)
      .catch(() => {});
    client.release();
  };
  return { client, release };
}

/** Runs `fn` with `client` as the pinned connection every query in its scope reuses. */
export function runPinned<T>(client: pg.PoolClient, fn: () => T): T {
  return pinStorage.run(client, fn);
}

/**
 * Runs `fn` on its OWN physical connection, even when the caller is already pinned.
 *
 * The deliberate opposite of `withTenantConnection`, which nests. Nesting is right for
 * everything that wants to participate in the caller's session; this exists for the one thing
 * that must NOT -- a write whose whole purpose is to survive the failure of the work happening
 * on the caller's connection.
 *
 * `ToolRuntime` is that caller. A run pins one connection for its entire drive (RunLoop.execute),
 * so the step's transaction and every `this.db` query share one physical session: a statement
 * issued through the pool while that transaction is open joins it, and is rolled back with it.
 * A record written to prove a side effect was ATTEMPTED cannot live on the transaction whose
 * rollback is the thing it has to outlive.
 *
 * The pin is exited only for the checkout itself, so the proxy in `tenantScopedPool` reaches the
 * real pool; `fn` then runs pinned to the NEW connection, which carries its own `app.org_id` and
 * is reset and released on the way out.
 *
 * COSTS A SECOND CONNECTION for as long as `fn` runs, while the caller still holds its own. Keep
 * `fn` to a statement or two, and keep `DB_POOL_MAX` comfortably above `WORKER_CONCURRENCY`:
 * a pool sized to exactly the number of concurrent drives would have nothing left to hand out.
 */
export async function withSeparateConnection<T>(
  pool: pg.Pool,
  scope: TenantScope,
  fn: () => Promise<T>,
): Promise<T> {
  const { client, release } = await pinStorage.exit(() => acquireTenantConnection(pool, scope));
  try {
    return await runPinned(client, fn);
  } finally {
    await release();
  }
}

/**
 * Convenience for a scope that IS one bounded `await` -- driving one run to completion,
 * firing one trigger, handling one background sweep. Nests cleanly: a call already inside
 * a pinned scope reuses it rather than acquiring a second connection, so pinned code
 * calling into other pinned code does not deadlock waiting on itself.
 */
export async function withTenantConnection<T>(
  pool: pg.Pool,
  scope: TenantScope,
  fn: () => Promise<T>,
): Promise<T> {
  if (pinStorage.getStore()) return fn();

  const { client, release } = await acquireTenantConnection(pool, scope);
  try {
    return await runPinned(client, fn);
  } finally {
    await release();
  }
}
