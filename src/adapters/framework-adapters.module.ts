import { Module } from '@nestjs/common';
import { EchoAdapter } from './framework/echo/echo.adapter.js';
import { PipelineAdapter } from './framework/pipeline/pipeline.adapter.js';
import { DeepAgentsAdapter } from './framework/deep-agents/deep-agents.adapter.js';
import { PostgresCheckpointSaver } from './framework/deep-agents/postgres.checkpoint-saver.js';
import { ObjectStoreAgentStore } from './framework/deep-agents/object-store-agent-store.js';
import { FRAMEWORK_ADAPTER, type FrameworkAdapter } from '../domain/ports/framework-adapter.port.js';
import { StorageAdaptersModule } from './storage-adapters.module.js';

/**
 * Orchestration frameworks, bound to one token as a list the run loop selects from.
 *
 * Adding a framework is one line here. That is the test §0.3 asks for: if adding the second
 * orchestration adapter had required changes elsewhere, the abstraction would already have
 * leaked.
 */
@Module({
  imports: [StorageAdaptersModule],
  providers: [
    EchoAdapter,
    PipelineAdapter,
    DeepAgentsAdapter,
    PostgresCheckpointSaver,
    ObjectStoreAgentStore,
    {
      provide: FRAMEWORK_ADAPTER,
      inject: [EchoAdapter, PipelineAdapter, DeepAgentsAdapter],
      useFactory: (...adapters: FrameworkAdapter[]) => adapters,
    },
  ],
  exports: [FRAMEWORK_ADAPTER],
})
export class FrameworkAdaptersModule {}
