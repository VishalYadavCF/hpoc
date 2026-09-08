import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type pg from 'pg';
import type { NextFunction, Request, Response } from 'express';
import { POOL } from '../../platform/persistence/tokens.js';
import { acquireTenantConnection, runPinned } from '../../platform/persistence/tenant-connection.js';

/**
 * §5.2 RLS for the operator surface.
 *
 * `/v1/ops` is deliberately outside ContextMiddleware: queue depth, dead letters and
 * subsystem health are questions ABOUT the platform, asked by whoever is on call, and
 * they span every tenant by construction. There is no org to pin to, and with RLS on
 * `runs`, `steps` and the rest, an unpinned connection would answer every one of them
 * with a confident zero -- the worst possible failure for a page at 2am, because it looks
 * like a healthy system.
 *
 * So these routes run under `bypass`, for the same reason SchedulerService's jobs do, and
 * with the same containment: the flag lives on one pinned connection for the duration of
 * one request, not on the pool and not in a config file.
 *
 * Applied as middleware rather than per-handler so an ops endpoint added later inherits
 * it. Forgetting it on a new endpoint would not fail loudly; it would just start
 * reporting nothing.
 */
@Injectable()
export class OpsBypassMiddleware implements NestMiddleware {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  async use(_req: Request, res: Response, next: NextFunction): Promise<void> {
    const { client, release } = await acquireTenantConnection(this.pool, { bypass: true });
    // Released on the response lifecycle, not when next() returns: next() only kicks off
    // the rest of the chain, it does not wait for the request to finish.
    res.once('finish', () => void release());
    res.once('close', () => void release());
    runPinned(client, () => next());
  }
}
