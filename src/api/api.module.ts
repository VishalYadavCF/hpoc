import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '../platform/config/config.module.js';
import { PersistenceModule } from '../platform/persistence/persistence.module.js';
import { ObservabilityModule } from '../platform/observability/observability.module.js';
import { GovernanceModule } from '../bootstrap/modules/governance.module.js';
import { ExecutionHttpModule } from './execution/execution-http.module.js';
import { ControlPlaneHttpModule } from './control-plane/control-plane-http.module.js';
import { ObservabilityHttpModule } from './observability/observability-http.module.js';
import { EvalsHttpModule } from './evals/evals-http.module.js';
import { A2aHttpModule } from './a2a/a2a-http.module.js';
import { OpsHttpModule } from './ops/ops-http.module.js';
import { ContextMiddleware } from './middleware/context.middleware.js';
import { OpsBypassMiddleware } from './middleware/ops-bypass.middleware.js';
import { PlatformExceptionFilter } from './filters/platform-exception.filter.js';
import { TimingInterceptor } from './interceptors/timing.interceptor.js';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor.js';
import { BackpressureInterceptor } from './interceptors/backpressure.interceptor.js';

@Module({
  imports: [
    ConfigModule.forRole('api'),
    PersistenceModule,
    ObservabilityModule,
    // For the backpressure interceptor, registered globally below.
    GovernanceModule,
    ExecutionHttpModule,
    ControlPlaneHttpModule,
    ObservabilityHttpModule,
    EvalsHttpModule,
    A2aHttpModule,
    OpsHttpModule,
  ],
  providers: [
    // Order matters: timing wraps everything so a shed request is still measured;
    // backpressure runs before idempotency so a saturated system does not spend a cache
    // slot per rejected call.
    { provide: APP_INTERCEPTOR, useClass: TimingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: BackpressureInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: PlatformExceptionFilter },
  ],
})
export class ApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Health, readiness and metrics are deliberately outside the tenant context: an
    // orchestrator probing readiness has no tenant, and requiring one would make the
    // pod permanently unready.
    // `v1/triggers` is absent deliberately: an external webhook caller has no identity
    // headers, and the trigger row supplies the tenancy instead.
    consumer
      .apply(ContextMiddleware)
      .forRoutes(
        'v1/runs', 'v1/threads', 'v1/interactions', 'v1/agents', 'v1/memory',
        'v1/traces', 'v1/lineage', 'v1/analytics', 'v1/feedback', 'v1/artifacts',
        'v1/mcp', 'v1/skills', 'v1/knowledge', 'v1/peers', 'v1/evals', 'v1/prompts',
        'v1/catalog', 'v1/replay', 'v1/policies',
      );

    // §5.2: the operator surface spans every tenant by construction, so it is pinned with
    // `bypass` rather than to an org. Without this, RLS would answer every queue-depth and
    // dead-letter question with a zero and look like a healthy system.
    consumer.apply(OpsBypassMiddleware).forRoutes('v1/ops');
  }
}
