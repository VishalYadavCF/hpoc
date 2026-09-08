import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { ENV } from '../config/config.module.js';
import type { AnyEnv } from '../config/env.schema.js';
import { createDb, createPool, type Db } from './database.js';
import { tenantScopedPool } from './tenant-connection.js';
import { UnitOfWork } from './unit-of-work.js';
import { EventListener } from './event-listener.js';
import { DB, LISTENER_POOL, POOL } from './tokens.js';

export { DB, LISTENER_POOL, POOL } from './tokens.js';


@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(LISTENER_POOL) private readonly listenerPool: pg.Pool,
  ) {}
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.pool.end(), this.listenerPool.end()]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: POOL,
      inject: [ENV],
      // Wrapped unconditionally (§5.2 RLS): harmless while the connecting role is still
      // the table owner (the default until APP_DATABASE_URL is set), and it is what lets
      // ContextMiddleware, RunLoop and the background sweeps pin a tenant-scoped session
      // the moment that role separation is actually adopted.
      useFactory: (env: AnyEnv) =>
        tenantScopedPool(createPool(env.APP_DATABASE_URL ?? env.DATABASE_URL, env.DB_POOL_MAX)),
    },
    {
      // Separate pool because LISTEN holds a session and cannot run through a
      // transaction-mode pooler (§12.1). One connection, direct to Postgres.
      provide: LISTENER_POOL,
      inject: [ENV],
      useFactory: (env: AnyEnv) =>
        createPool(env.LISTENER_DATABASE_URL ?? env.DATABASE_URL, 1),
    },
    { provide: DB, inject: [POOL], useFactory: (pool: pg.Pool): Db => createDb(pool) },
    UnitOfWork,
    EventListener,
    PoolLifecycle,
  ],
  exports: [DB, POOL, LISTENER_POOL, UnitOfWork, EventListener],
})
export class PersistenceModule {}
