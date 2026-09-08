import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { type Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request } from 'express';
import { maybeContext } from '../../platform/context/platform-context.js';

interface Entry {
  at: number;
  body: unknown;
}

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 10_000;

/**
 * Paths that implement idempotency DURABLY, in the database.
 *
 * Run creation has a unique index on `(namespace_id, tenant_ref, idempotency_key)`, which
 * holds across processes and restarts and reports `reused: true` so a caller can tell a
 * duplicate from a fresh run. Caching in front of that would replay the FIRST response --
 * including its `reused: false` -- and hide the more accurate answer behind a weaker
 * mechanism. Where a real guarantee exists, the convenience layer stands aside.
 */
const DURABLY_IDEMPOTENT = [/^\/v1\/runs\/?$/, /^\/v1\/threads\/[^/]+\/runs\/?$/];

/**
 * Replays the stored response for a repeated `Idempotency-Key` (§4.5).
 *
 * This is a CONVENIENCE layer, not the guarantee. Run creation is idempotent in the
 * database via a unique index on `(namespace_id, tenant_ref, idempotency_key)`, and that
 * is what actually holds across processes and restarts. This only saves a caller the
 * round trip; if the process restarts the DB still refuses the duplicate.
 *
 * Keyed by tenant as well as by the key itself, so two tenants choosing the same
 * idempotency key cannot read each other's response.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly seen = new Map<string, Entry>();

  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = execution.switchToHttp().getRequest<Request>();
    const rawKey = req.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (req.method !== 'POST' || !key) return next.handle();
    if (DURABLY_IDEMPOTENT.some((p) => p.test(req.path))) return next.handle();

    const ctx = maybeContext();
    const scoped = `${ctx?.orgId ?? '-'}:${ctx?.tenantRef ?? '-'}:${req.path}:${key}`;

    const hit = this.seen.get(scoped);
    if (hit && Date.now() - hit.at < TTL_MS) return of(hit.body);

    return next.handle().pipe(
      tap((body: unknown) => {
        if (this.seen.size >= MAX_ENTRIES) {
          const oldest = this.seen.keys().next().value;
          if (oldest !== undefined) this.seen.delete(oldest);
        }
        this.seen.set(scoped, { at: Date.now(), body });
      }),
    );
  }
}
