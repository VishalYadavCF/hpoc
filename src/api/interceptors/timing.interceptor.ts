import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { Metrics } from '../../platform/observability/metrics.js';

/**
 * Request timing as Prometheus histograms (§15.4).
 *
 * The route TEMPLATE is the label, never the concrete path: `/v1/runs/:id` and not
 * `/v1/runs/<uuid>`. Per-id labels are unbounded cardinality, which is the single
 * fastest way to make a Prometheus server fall over.
 */
@Injectable()
export class TimingInterceptor implements NestInterceptor {
  constructor(private readonly metrics: Metrics) {
    metrics.describe('http_request_duration_ms', 'API request duration by route and status');
    metrics.describe('http_requests_total', 'API requests by route, method and status');
  }

  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = execution.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const started = Date.now();

    const record = (): void => {
      const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
      const labels = { route, method: req.method, status: String(res.statusCode) };
      this.metrics.observe('http_request_duration_ms', Date.now() - started, labels);
      this.metrics.increment('http_requests_total', labels);
    };

    // tap's observer form, not pipe's: `pipe` takes operators, and passing it an observer
    // type-checks under a cast while recording nothing at all.
    return next.handle().pipe(tap({ error: record, complete: record }));
  }
}
