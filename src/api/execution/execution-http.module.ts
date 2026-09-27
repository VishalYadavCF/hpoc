import { Module } from '@nestjs/common';
import { RunStateModule } from '../../bootstrap/modules/run-state.module.js';
import { RunsModule } from '../../bootstrap/modules/runs.module.js';
import { MemoryModule } from '../../bootstrap/modules/memory.module.js';
import { ArtifactsModule } from '../../bootstrap/modules/artifacts.module.js';
import { StreamingModule } from '../streaming/streaming.module.js';
import { RunsController } from './runs.controller.js';
import { ThreadsController } from './threads.controller.js';
import { InteractionsController } from './interactions.controller.js';
import { TriggersController } from './triggers.controller.js';
import { MemoryController } from './memory.controller.js';
import { ArtifactsController } from './artifacts.controller.js';
import { MemorySharingController } from '../control-plane/memory-sharing.controller.js';

@Module({
  imports: [RunStateModule, RunsModule, MemoryModule, ArtifactsModule, StreamingModule],
  controllers: [
    RunsController, ThreadsController, InteractionsController,
    // MemorySharingController BEFORE MemoryController, and in the SAME module: Express
    // matches in registration order, so `@Get(':id')` on /v1/memory would otherwise swallow
    // /v1/memory/sharing and answer 404 for a route that exists. Across two modules the
    // order would depend on module scan order, which nothing here should rely on.
    MemorySharingController, MemoryController,
    TriggersController, ArtifactsController,
  ],
})
export class ExecutionHttpModule {}
