import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type pg from 'pg';
import type { NextFunction, Request, Response } from 'express';
import { DB, POOL } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { acquireTenantConnection, runPinned } from '../../platform/persistence/tenant-connection.js';
import { runInContext } from '../../platform/context/platform-context.js';
import { CapabilityDenied, PlatformError } from '../../domain/errors/platform.errors.js';
import { newId } from '../../platform/ids.js';

/**
 * Establishes PlatformContext for the request.
 *
 * Middleware rather than a guard, deliberately: a guard's AsyncLocalStorage scope ends
 * when canActivate returns, so the controller would run outside it. Wrapping next() is
 * what keeps the whole request -- guards, interceptors, controller, repositories -- in
 * one scope.
 *
 * Phase 1 authenticates from headers. That is the seam where mTLS peer identity or a
 * signed service token lands in Phase 3; the shape it produces does not change, which is
 * why the rest of the codebase can already depend on it.
 *
 * The tenancy rule matters now: a tenant the caller holds no grant for is a 403, never an
 * empty result set. Silent narrowing is how a service returns records it was never
 * entitled to see (§16.2).
 */
@Injectable()
export class ContextMiddleware implements NestMiddleware {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(POOL) private readonly pool: pg.Pool,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const subject = header(req, 'x-caller-subject');
    const namespaceSlug = header(req, 'x-namespace');
    const tenantRef = header(req, 'x-tenant-ref');

    if (!subject || !namespaceSlug || !tenantRef) {
      return next(
        new PlatformError('capability_denied', 'Missing caller identity headers', {
          required: ['x-caller-subject', 'x-namespace', 'x-tenant-ref'],
        }),
      );
    }

    try {
      const namespace = await this.db
        .selectFrom('namespaces')
        .select(['id', 'org_id'])
        .where('slug', '=', namespaceSlug)
        .executeTakeFirst();
      if (!namespace) throw new CapabilityDenied('namespace', namespaceSlug);

      const principal = await this.db
        .selectFrom('principals')
        .select(['id'])
        .where('org_id', '=', namespace.org_id)
        .where('subject', '=', subject)
        .where('disabled_at', 'is', null)
        .executeTakeFirst();
      if (!principal) throw new CapabilityDenied('principal', subject);

      const tenant = await this.db
        .selectFrom('tenants')
        .select('id')
        .where('namespace_id', '=', namespace.id)
        .where('tenant_ref', '=', tenantRef)
        .executeTakeFirst();
      if (!tenant) throw new CapabilityDenied('tenant', tenantRef);

      // §5.2 RLS: one physical connection pinned for the rest of this request, with
      // app.org_id set at the session level, so every query issued by the controller and
      // every repository it calls -- not only ones inside an explicit transaction -- is
      // subject to the tenant policy. Released on the response lifecycle, not when
      // next() returns: next() only kicks the rest of the chain off, it does not wait
      // for the request to finish.
      const { client, release } = await acquireTenantConnection(this.pool, { orgId: namespace.org_id });
      res.once('finish', () => void release());
      res.once('close', () => void release());

      runPinned(client, () =>
        runInContext(
          {
            orgId: namespace.org_id,
            namespaceId: namespace.id,
            tenantRef,
            callerPrincipalId: principal.id,
            onBehalfOfPrincipalId: header(req, 'x-on-behalf-of') ?? null,
            // §0.1 — recorded even when absent. "No interactive human" is an answer.
            authorizingHumanId: header(req, 'x-authorizing-human') ?? null,
            delegationChain: [],
            traceId: header(req, 'x-trace-id') ?? newId(),
            correlationId: header(req, 'x-correlation-id') ?? newId(),
          },
          () => next(),
        ),
      );
    } catch (e) {
      next(e);
    }
  }
}

const header = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};
