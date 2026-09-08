import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Request } from 'express';
import { BackpressureService } from '../../domain/governance/backpressure.service.js';
import { maybeContext } from '../../platform/context/platform-context.js';

/**
 * §5.1, applied before work is queued.
 *
 * Checked at the edge rather than in the run loop: shedding after a run row, a queue entry
 * and a first event have been written is not shedding, it is doing the work and then
 * throwing it away.
 *
 * Only execution routes are guarded. Reads and the control plane are not what saturates a
 * worker pool, and throttling someone's attempt to LOOK at a stuck system is the wrong
 * moment to be strict.
 */
@Injectable()
export class BackpressureInterceptor implements NestInterceptor {
  constructor(private readonly backpressure: BackpressureService) {}

  async intercept(execution: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = execution.switchToHttp().getRequest<Request>();
    if (req.method !== 'POST') return next.handle();

    const ctx = maybeContext();
    if (!ctx) return next.handle();

    await this.backpressure.admit([
      { level: 'org', scopeRef: ctx.orgId },
      { level: 'namespace', scopeRef: ctx.namespaceId },
      { level: 'tenant', scopeRef: ctx.tenantRef },
    ]);
    return next.handle();
  }
}
