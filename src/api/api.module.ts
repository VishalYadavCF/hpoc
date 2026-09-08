import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '../platform/config/config.module.js';
import { PersistenceModule } from '../platform/persistence/persistence.module.js';
import { ObservabilityModule } from '../platform/observability/observability.module.js';
import { DomainModule } from '../domain/domain.module.js';
import { RunsController } from './execution/runs.controller.js';
import { ThreadsController } from './execution/threads.controller.js';
import { InteractionsController } from './execution/interactions.controller.js';
import { TriggersController } from './execution/triggers.controller.js';
import { AgentsController } from './control-plane/agents.controller.js';
import { MemoryController } from './execution/memory.controller.js';
import { ObservabilityController } from './observability/observability.controller.js';
import { ReplayController } from './observability/replay.controller.js';
import { ArtifactsController } from './execution/artifacts.controller.js';
import { McpController } from './control-plane/mcp.controller.js';
import { MemorySharingController } from './control-plane/memory-sharing.controller.js';
import { SkillsController } from './control-plane/skills.controller.js';
import { KnowledgeController } from './control-plane/knowledge.controller.js';
import { PeersController } from './control-plane/peers.controller.js';
import { PromptsController } from './control-plane/prompts.controller.js';
import { PoliciesController } from './control-plane/policies.controller.js';
import { CatalogController } from './control-plane/catalog.controller.js';
import { A2aController } from './a2a/a2a.controller.js';
import { EvalsController } from './evals/evals.controller.js';
import { DeploymentsController } from './evals/deployments.controller.js';
import { UiController } from './ui/ui.controller.js';
import { OpsController } from './ops/ops.controller.js';
import { RunStreamService } from './streaming/run-stream.service.js';
import { ContextMiddleware } from './middleware/context.middleware.js';
import { OpsBypassMiddleware } from './middleware/ops-bypass.middleware.js';
import { PlatformExceptionFilter } from './filters/platform-exception.filter.js';
import { TimingInterceptor } from './interceptors/timing.interceptor.js';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor.js';
import { BackpressureInterceptor } from './interceptors/backpressure.interceptor.js';
import { GatewayWiring } from '../bootstrap/gateway-wiring.js';

@Module({
  imports: [
    ConfigModule.forRole('api'),
    PersistenceModule,
    ObservabilityModule,
    DomainModule,
  ],
  controllers: [
    RunsController, ThreadsController, InteractionsController,
    // MemorySharingController BEFORE MemoryController: Express matches in registration
    // order, so `@Get(':id')` on /v1/memory would otherwise swallow /v1/memory/sharing
    // and answer 404 for a route that exists.
    MemorySharingController, MemoryController,
    AgentsController, TriggersController,
    ObservabilityController, ReplayController, ArtifactsController, McpController,
    SkillsController, KnowledgeController, PeersController, PromptsController,
    PoliciesController,
    CatalogController,
    EvalsController,
    // Shares the /v1/agents prefix with AgentsController but collides with none of its
    // routes: every route here is /:name/<literal>, and AgentsController's widest pattern
    // is a single-segment `@Get(':name')`. Order is therefore not load-bearing -- unlike
    // MemorySharingController above, where it is.
    DeploymentsController,
    // Outside /v1 and outside the tenant middleware: a peer authenticates as a peer.
    A2aController,
    UiController, OpsController,
  ],
  providers: [
    RunStreamService,
    GatewayWiring,
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
