import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  ExportOutcome,
  ExportableSpan,
  TraceExporter,
} from '../../domain/ports/trace-exporter.port.js';

/**
 * Hosts a self-hosted collector can legitimately live on.
 *
 * Loopback, RFC1918/RFC4193 private space, and the suffixes an in-cluster service carries
 * (`.internal`, `.local`, `.svc`, `.svc.cluster.local`) plus a bare single-label hostname,
 * which is what a Kubernetes service name looks like from inside the cluster.
 */
function isInternalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '::1' || h.startsWith('127.')) return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (h.endsWith('.internal') || h.endsWith('.local') || h.endsWith('.svc')) return true;
  if (h.endsWith('.svc.cluster.local')) return true;
  return !h.includes('.');
}

/** OTLP wants 16 bytes of trace id and 8 of span id, as lowercase hex. */
const hex = (value: string, bytes: number): string =>
  createHash('sha256').update(value).digest('hex').slice(0, bytes * 2);

const nanos = (d: Date): string => `${BigInt(d.getTime()) * 1_000_000n}`;

function attributes(attrs: Record<string, string | number | boolean>): unknown[] {
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value:
      typeof value === 'number'
        ? Number.isInteger(value)
          ? { intValue: String(value) }
          : { doubleValue: value }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : { stringValue: value },
  }));
}

/**
 * OTLP/HTTP JSON exporter (§15.2), gated by §16.1 Constraint 1.
 *
 * **Constraint 1 is absolute: "Traces, metrics, evals, and prompt/completion logs never
 * leave our perimeter. Self-hosted without exception."** So this refuses an endpoint it
 * cannot establish as internal, and says so, rather than exporting and letting a config
 * review catch it later. That refusal is the same shape `LlmJudgeGrader` uses for an
 * external judge model: the check lives in code, not in a runbook.
 *
 * JSON over protobuf deliberately: OTLP/HTTP accepts both, every collector supports JSON,
 * and it costs no dependency. Encoding is the easy half of exporting; the hard half is
 * being sure it is allowed to leave, which is above.
 */
@Injectable()
export class OtlpTraceExporter implements TraceExporter {
  readonly id = 'otlp-http-json';
  private readonly log = new Logger(OtlpTraceExporter.name);
  private readonly endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? null;
  private readonly serviceName = process.env['OTEL_SERVICE_NAME'] ?? 'agent-platform';
  private readonly timeoutMs = Number(process.env['OTEL_EXPORTER_TIMEOUT_MS'] ?? 10_000);
  private refusal: string | null = null;

  constructor() {
    if (!this.endpoint) return;
    let host: string;
    try {
      host = new URL(this.endpoint).hostname;
    } catch {
      this.refusal = `OTEL_EXPORTER_OTLP_ENDPOINT is not a valid URL: "${this.endpoint}"`;
      this.log.error(this.refusal);
      return;
    }
    if (!isInternalHost(host)) {
      this.refusal =
        `refusing to export telemetry to "${host}" — §16.1 Constraint 1 is absolute: ` +
        `traces never leave the perimeter, and a collector must be self-hosted`;
      this.log.error(this.refusal);
      return;
    }
    this.log.log(`OTLP trace export enabled -> ${this.endpoint}`);
  }

  enabled(): boolean {
    return this.endpoint !== null && this.refusal === null;
  }

  async export(spans: ExportableSpan[]): Promise<ExportOutcome> {
    if (this.refusal) return { exported: 0, refused: this.refusal };
    if (!this.endpoint) return { exported: 0, refused: 'no OTEL_EXPORTER_OTLP_ENDPOINT configured' };
    if (spans.length === 0) return { exported: 0 };

    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: attributes({
              'service.name': this.serviceName,
              'telemetry.sdk.name': this.id,
            }),
          },
          scopeSpans: [
            {
              scope: { name: 'agent-platform' },
              spans: spans.map((s) => ({
                traceId: hex(s.traceKey, 16),
                spanId: hex(s.spanKey, 8),
                ...(s.parentSpanKey ? { parentSpanId: hex(s.parentSpanKey, 8) } : {}),
                name: s.name,
                kind: 1, // SPAN_KIND_INTERNAL
                startTimeUnixNano: nanos(s.startedAt),
                endTimeUnixNano: nanos(s.endedAt),
                attributes: attributes(s.attributes),
                status: {
                  code: s.status === 'ok' ? 1 : s.status === 'error' ? 2 : 0,
                  ...(s.statusMessage ? { message: s.statusMessage } : {}),
                },
              })),
            },
          ],
        },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        // Reported as a refusal so the caller does NOT advance its cursor: a rejected
        // batch is an unshipped batch, and stepping over it loses exactly the window the
        // collector was unhealthy for.
        return { exported: 0, refused: `collector returned ${response.status}` };
      }
      return { exported: spans.length };
    } catch (e) {
      return { exported: 0, refused: (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}
