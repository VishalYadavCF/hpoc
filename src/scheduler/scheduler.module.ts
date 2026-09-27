import { Module } from '@nestjs/common';
import { ConfigModule } from '../platform/config/config.module.js';
import { PersistenceModule } from '../platform/persistence/persistence.module.js';
import { ObservabilityModule } from '../platform/observability/observability.module.js';
import { RunStateModule } from '../bootstrap/modules/run-state.module.js';
import { RunsModule } from '../bootstrap/modules/runs.module.js';
import { MemoryModule } from '../bootstrap/modules/memory.module.js';
import { ArtifactsModule } from '../bootstrap/modules/artifacts.module.js';
import { TelemetryModule } from '../bootstrap/modules/telemetry.module.js';
import { SchedulerService } from './scheduler.service.js';

/**
 * Only what the singleton jobs touch: recovery and delivery (RunStateModule), schedules
 * (RunsModule, for TriggerService), memory expiry, artifact GC and trace export. No
 * execution engine -- the scheduler requeues runs, it never drives one.
 */
@Module({
  imports: [
    ConfigModule.forRole('scheduler'),
    PersistenceModule,
    ObservabilityModule,
    RunStateModule,
    RunsModule,
    MemoryModule,
    ArtifactsModule,
    TelemetryModule,
  ],
  providers: [SchedulerService],
})
export class SchedulerModule {}
