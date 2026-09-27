import { Module } from '@nestjs/common';
import { TelemetryModule } from '../../bootstrap/modules/telemetry.module.js';
import { RunsModule } from '../../bootstrap/modules/runs.module.js';
import { ObservabilityController } from './observability.controller.js';
import { ReplayController } from './replay.controller.js';

@Module({
  imports: [TelemetryModule, RunsModule],
  controllers: [ObservabilityController, ReplayController],
})
export class ObservabilityHttpModule {}
