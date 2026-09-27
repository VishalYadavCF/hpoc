import { Module } from '@nestjs/common';
import { ConfigModule } from '../platform/config/config.module.js';
import { PersistenceModule } from '../platform/persistence/persistence.module.js';
import { ObservabilityModule } from '../platform/observability/observability.module.js';
import { DomainModule } from '../domain/domain.module.js';
import { ExecutionModule } from '../bootstrap/execution.module.js';
import { WorkerService } from './worker.service.js';

@Module({
  imports: [
    ConfigModule.forRole('worker'),
    PersistenceModule,
    ObservabilityModule,
    DomainModule,
    ExecutionModule,
  ],
  providers: [WorkerService],
})
export class WorkerModule {}
