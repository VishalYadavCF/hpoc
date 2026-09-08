export const TRACE_EXPORTER = Symbol('TraceExporter');

/**
 * One span, in the neutral shape the domain produces (§0.3).
 *
 * Deliberately not an OTLP type. The domain describes what happened; translating that
 * into protobuf-shaped JSON with 16-byte hex trace ids is the adapter's job, exactly as
 * MCP and A2A message shapes stay out of the core model.
 */
export interface ExportableSpan {
  /** Stable within a run. The adapter derives the wire-format ids from these. */
  spanKey: string;
  parentSpanKey: string | null;
  traceKey: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  /** OTLP has exactly two outcomes plus unset; a step that is still running is unset. */
  status: 'unset' | 'ok' | 'error';
  statusMessage?: string;
  attributes: Record<string, string | number | boolean>;
}

export interface ExportOutcome {
  exported: number;
  /** Set when the exporter declined to ship anything, with the reason (§16.1). */
  refused?: string;
}

/**
 * §15.2's "OpenTelemetry with GenAI semantic conventions", as a seam.
 *
 * A port rather than a direct OTLP call so §16.1 Constraint 1 has one enforcement point:
 * telemetry never leaves the perimeter, and an exporter pointed at a hosted vendor must
 * be refused rather than configured around.
 */
export interface TraceExporter {
  readonly id: string;
  /** True when an endpoint is configured AND passed the residency check. */
  enabled(): boolean;
  export(spans: ExportableSpan[]): Promise<ExportOutcome>;
}
