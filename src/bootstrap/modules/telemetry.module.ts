import { Module } from '@nestjs/common';
import { TraceService } from '../../domain/observability/trace.service.js';
import { SpanProjectionService } from '../../domain/observability/span-projection.service.js';
import { AnalyticsService } from '../../domain/observability/analytics.service.js';
import { FeedbackService } from '../../domain/observability/feedback.service.js';
import { MemoryAdaptersModule } from '../../adapters/memory-adapters.module.js';
import { TelemetryAdaptersModule } from '../../adapters/telemetry-adapters.module.js';

/** Traces, lineage reads, analytics and feedback (§15), and the OTLP export the scheduler drives. */
@Module({
  imports: [MemoryAdaptersModule, TelemetryAdaptersModule],
  providers: [TraceService, SpanProjectionService, AnalyticsService, FeedbackService],
  exports: [TraceService, SpanProjectionService, AnalyticsService, FeedbackService],
})
export class TelemetryModule {}
