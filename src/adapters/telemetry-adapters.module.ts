import { Module } from '@nestjs/common';
import { OtlpTraceExporter } from './observability/otlp.exporter.js';
import { TRACE_EXPORTER } from '../domain/ports/trace-exporter.port.js';

/**
 * §16.1 Constraint 1 lives inside this adapter: it refuses an endpoint it cannot establish
 * as internal, so "self-hosted without exception" is code, not a runbook.
 */
@Module({
  providers: [OtlpTraceExporter, { provide: TRACE_EXPORTER, useExisting: OtlpTraceExporter }],
  exports: [TRACE_EXPORTER],
})
export class TelemetryAdaptersModule {}
