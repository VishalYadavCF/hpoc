import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OtlpTraceExporter } from '../src/adapters/observability/otlp.exporter.js';
import { SpanProjectionService } from '../src/domain/observability/span-projection.service.js';
import type { ExportableSpan } from '../src/domain/ports/trace-exporter.port.js';
import { fixture, makeRun, type Fixture } from './fixtures.js';

let f: Fixture;
let collector: Server;
let collectorUrl = '';
const received: Record<string, unknown>[] = [];

const span = (over: Partial<ExportableSpan> = {}): ExportableSpan => ({
  spanKey: 'span-1',
  parentSpanKey: null,
  traceKey: 'trace-1',
  name: 'agent.run api',
  startedAt: new Date('2026-01-01T00:00:00Z'),
  endedAt: new Date('2026-01-01T00:00:01Z'),
  status: 'ok',
  attributes: { 'gen_ai.operation.name': 'invoke_agent', 'agent.run.step_count': 3 },
  ...over,
});

/** Builds an exporter against a specific endpoint, since it reads env once at construction. */
const exporterFor = (endpoint: string | undefined): OtlpTraceExporter => {
  const previous = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (endpoint === undefined) delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  else process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = endpoint;
  try {
    return new OtlpTraceExporter();
  } finally {
    if (previous === undefined) delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    else process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = previous;
  }
};

beforeAll(async () => {
  f = await fixture();
  collector = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push(JSON.parse(raw || '{}') as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
  collectorUrl = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => collector.close(() => r()));
  await f.close();
});

describe('§16.1 Constraint 1 — telemetry never leaves the perimeter', () => {
  it('refuses a hosted vendor endpoint and stays disabled', async () => {
    // Absolute, not policy-gated: there is no data class that makes this allowed.
    const exporter = exporterFor('https://otlp.observability-vendor.example.com');
    expect(exporter.enabled()).toBe(false);

    const outcome = await exporter.export([span()]);
    expect(outcome.exported).toBe(0);
    expect(outcome.refused).toMatch(/never leave the perimeter|§16.1/);
  });

  it('refuses a malformed endpoint rather than failing at the first export', async () => {
    const exporter = exporterFor('not-a-url');
    expect(exporter.enabled()).toBe(false);
    expect((await exporter.export([span()])).refused).toMatch(/not a valid URL/);
  });

  it('accepts loopback, private space and in-cluster names', () => {
    expect(exporterFor('http://127.0.0.1:4318').enabled()).toBe(true);
    expect(exporterFor('http://10.4.1.9:4318').enabled()).toBe(true);
    expect(exporterFor('http://otel-collector.observability.svc:4318').enabled()).toBe(true);
    // A bare single-label host is what a Kubernetes service looks like from in-cluster.
    expect(exporterFor('http://otel-collector:4318').enabled()).toBe(true);
  });

  it('is simply off, not refusing, when nothing is configured', async () => {
    const exporter = exporterFor(undefined);
    expect(exporter.enabled()).toBe(false);
    expect((await exporter.export([span()])).refused).toMatch(/no OTEL_EXPORTER_OTLP_ENDPOINT/);
  });
});

describe('OTLP wire format', () => {
  it('ships spans a collector can accept', async () => {
    received.length = 0;
    const exporter = exporterFor(collectorUrl);
    const outcome = await exporter.export([
      span(),
      span({ spanKey: 'span-2', parentSpanKey: 'span-1', name: 'agent.step model_call', status: 'error', statusMessage: 'boom' }),
    ]);

    expect(outcome.exported).toBe(2);
    expect(outcome.refused).toBeUndefined();

    const body = received[0] as {
      resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(2);

    // OTLP requires 16-byte trace ids and 8-byte span ids as lowercase hex; the platform's
    // own ids are neither, so the adapter derives them.
    expect(spans[0]!['traceId']).toMatch(/^[0-9a-f]{32}$/);
    expect(spans[0]!['spanId']).toMatch(/^[0-9a-f]{16}$/);
    // Both spans belong to ONE trace -- that is what makes a delegation tree one graph.
    expect(spans[1]!['traceId']).toBe(spans[0]!['traceId']);
    expect(spans[1]!['parentSpanId']).toBe(spans[0]!['spanId']);
    expect(spans[1]!['status']).toEqual({ code: 2, message: 'boom' });
    expect(spans[0]!['status']).toEqual({ code: 1 });
  });

  it('reports a collector error as a refusal, so the caller does not advance its cursor', async () => {
    const broken = createServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    await new Promise<void>((r) => broken.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(broken.address() as { port: number }).port}`;
    try {
      const outcome = await exporterFor(url).export([span()]);
      expect(outcome.exported).toBe(0);
      // An unshipped batch must stay unshipped: advancing past it loses exactly the
      // window the collector was unhealthy for.
      expect(outcome.refused).toMatch(/503/);
    } finally {
      await new Promise<void>((r) => broken.close(() => r()));
    }
  });
});

describe('span projection (§15.2)', () => {
  it('does nothing at all when the exporter is disabled', async () => {
    const projection = new SpanProjectionService(f.db, exporterFor(undefined));
    const result = await projection.exportFinished();
    expect(result.spans).toBe(0);
    expect(result.refused).toBe('exporter disabled');
  });

  it('projects a finished run into a span and advances the cursor', async () => {
    received.length = 0;
    const { runId } = await makeRun(f);
    // Terminalise it far enough in the past to clear the settle lag.
    await f.db
      .updateTable('runs')
      .set({
        status: 'completed',
        started_at: new Date(Date.now() - 60_000),
        ended_at: new Date(Date.now() - 30_000),
      })
      .where('id', '=', runId)
      .execute();

    // Start the cursor just before this run so the batch is small and deterministic.
    await f.db
      .insertInto('trace_export_cursor')
      .values({ id: true, exported_through: new Date(Date.now() - 45_000) })
      .onConflict((oc) => oc.column('id').doUpdateSet({ exported_through: new Date(Date.now() - 45_000) }))
      .execute();

    const projection = new SpanProjectionService(f.db, exporterFor(collectorUrl));
    const result = await projection.exportFinished();
    expect(result.spans).toBeGreaterThan(0);

    const body = received[0] as {
      resourceSpans: { scopeSpans: { spans: { name: string; attributes: { key: string }[] }[] }[] }[];
    };
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    const runSpan = spans.find((s) => s.name.startsWith('agent.run'))!;
    expect(runSpan).toBeDefined();
    // GenAI semantic conventions, per §15.2, alongside the tenancy a shared collector
    // needs to attribute the span without joining back to us.
    const keys = runSpan.attributes.map((a) => a.key);
    expect(keys).toContain('gen_ai.operation.name');
    expect(keys).toContain('tenant.ref');

    const cursor = await f.db
      .selectFrom('trace_export_cursor').select('exported_through').where('id', '=', true)
      .executeTakeFirstOrThrow();
    expect(cursor.exported_through.getTime()).toBeGreaterThan(Date.now() - 45_000);
  });
});
