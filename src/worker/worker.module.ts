import { Module } from '@nestjs/common';
import { ConfigModule } from '../platform/config/config.module.js';
import { PersistenceModule } from '../platform/persistence/persistence.module.js';
import { ObservabilityModule } from '../platform/observability/observability.module.js';
import { RunStateModule } from '../bootstrap/modules/run-state.module.js';
import { ExecutionModule } from '../bootstrap/modules/execution.module.js';
import { WorkerService } from './worker.service.js';

@Module({
  imports: [
    ConfigModule.forRole('worker'),
    PersistenceModule,
    ObservabilityModule,
    RunStateModule,
    ExecutionModule,
  ],
  providers: [WorkerService],
})
export class WorkerModule {}
