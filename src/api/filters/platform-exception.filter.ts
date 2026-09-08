import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import {
  AdmissionRejected,
  PlatformError,
  Saturated,
  type ErrorCode,
} from '../../domain/errors/platform.errors.js';

/** §5.1: saturation is not a 500, and the caller must be able to act on the difference. */
const STATUS: Record<ErrorCode, number> = {
  admission_rejected: 422,
  capability_denied: 403,
  throttled: 429,
  shed: 503,
  budget_exhausted: 402,
  invalid_transition: 409,
  not_found: 404,
  upstream_failure: 502,
  lease_lost: 409,
  indeterminate_side_effect: 500,
  internal: 500,
};

@Catch()
export class PlatformExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger(PlatformExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (error instanceof PlatformError) {
      const status = STATUS[error.code];
      // level and scopeRef travel in the body: backing off from a tenant limit and from
      // an MCP server limit are different behaviours, and the caller cannot tell without them.
      if (error instanceof Saturated) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      res.status(status).json({
        code: error.code,
        message: error.message,
        ...(error instanceof AdmissionRejected ? { rejections: error.rejections } : {}),
        ...error.detail,
      });
      return;
    }

    if (error instanceof HttpException) {
      res.status(error.getStatus()).json(error.getResponse());
      return;
    }

    this.log.error((error as Error)?.stack ?? String(error));
    res.status(500).json({ code: 'internal', message: 'Internal error' });
  }
}
