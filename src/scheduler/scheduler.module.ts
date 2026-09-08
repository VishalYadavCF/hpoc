import { Module } from '@nestjs/common';
import { ConfigModule } from '../platform/config/config.module.js';
import { PersistenceModule } from '../platform/persistence/persistence.module.js';
import { ObservabilityModule } from '../platform/observability/observability.module.js';
import { DomainModule } from '../domain/domain.module.js';
import { SchedulerService } from './scheduler.service.js';

@Module({
  imports: [
    ConfigModule.forRole('scheduler'),
    PersistenceModule,
    ObservabilityModule,
    DomainModule,
  ],
  providers: [SchedulerService],
})
export class SchedulerModule {}
