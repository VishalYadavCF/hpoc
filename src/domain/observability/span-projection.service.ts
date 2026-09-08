import { Inject, Injectable, Logger } from '@nestjs/common';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { TRACE_EXPORTER, type ExportableSpan, type TraceExporter } from '../ports/trace-exporter.port.js';

/** Runs newer than this are still settling; exporting them risks missing their last steps. */
const SETTLE_LAG_MS = 5_000;

/**
 * Projects finished runs into spans and ships them (§15.2).
 *
 * The platform already answers every §15.2 question from its own tables -- that is what
 * TraceService does. What it could not do was hand the same execution to a collector
 * everything else in the estate already reports to, which is the difference between "our
 * agent traces are queryable in our console" and "our agent traces sit beside the traces
 * of the services they call".
 *
 * A projection, not a second store. Nothing here is written back: if the exporter is off,
 * or refuses on residency grounds, the traces remain exactly as queryable as before.
 */
@Injectable()
export class SpanProjectionService {
  private readonly log = new Logger(SpanProjectionService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TRACE_EXPORTER) private readonly exporter: TraceExporter,
  ) {}

  /**
   * Exports every run that finished since the cursor, then advances it.
   *
   * The cursor is a single row rather than a per-run marker: runs are exported in
   * `ended_at` order and a run's `ended_at` is set once, in its terminal transaction, so
   * one high-water mark is sufficient and costs no per-run bookkeeping. `SETTLE_LAG_MS`
   * is what keeps that honest -- without it a run whose terminal transaction commits
   * microseconds after the cursor read would be stepped over and never shipped.
   */
  async exportFinished(batch = 200): Promise<{ runs: number; spans: number; refused?: string }> {
    if (!this.exporter.enabled()) return { runs: 0, spans: 0, refused: 'exporter disabled' };

    const cursor = await this.db
      .selectFrom('trace_export_cursor')
      .select('exported_through')
      .where('id', '=', true)
      .executeTakeFirst();
    const through = cursor?.exported_through ?? new Date(0);

    const runs = await this.db
      .selectFrom('runs')
      .select([
        'id', 'agent_version_id', 'org_id', 'namespace_id', 'tenant_ref', 'status',
        'trace_id', 'parent_run_id', 'started_at', 'ended_at', 'cost_micros',
        'input_tokens', 'output_tokens', 'step_count', 'initiator', 'queued_at', 'error',
      ])
      .where('ended_at', 'is not', null)
      .where('ended_at', '>', through)
      .where('ended_at', '<', new Date(Date.now() - SETTLE_LAG_MS))
      .orderBy('ended_at', 'asc')
      .limit(batch)
      .execute();
    if (runs.length === 0) return { runs: 0, spans: 0 };

    const steps = await this.db
      .selectFrom('steps')
      .select([
        'id', 'run_id', 'seq', 'kind', 'status', 'started_at', 'ended_at', 'latency_ms',
        'model_id', 'input_tokens', 'output_tokens', 'cost_micros', 'error',
      ])
      .where('run_id', 'in', runs.map((r) => r.id))
      .orderBy('seq', 'asc')
      .execute();

    const spans: ExportableSpan[] = [];
    for (const run of runs) {
      // A run with no started_at never left the queue; its span is the queue wait itself,
      // which is the honest thing to show rather than dropping it from the trace.
      const start = run.started_at ?? run.queued_at;
      const end = run.ended_at!;
      spans.push({
        spanKey: run.id,
        parentSpanKey: null,
        // §15.2 wants ONE distributed trace across delegation hops, so a child run joins
        // its parent's trace rather than starting its own.
        traceKey: run.trace_id ?? run.id,
        name: `agent.run ${run.initiator}`,
        startedAt: start,
        endedAt: end,
        status: run.status === 'completed' ? 'ok' : 'error',
        ...(run.status === 'completed' ? {} : { statusMessage: errorMessage(run.error) }),
        attributes: {
          // GenAI semantic conventions where they exist, platform names where they do not.
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.usage.input_tokens': Number(run.input_tokens),
          'gen_ai.usage.output_tokens': Number(run.output_tokens),
          'agent.run.id': run.id,
          'agent.run.status': run.status,
          'agent.run.initiator': run.initiator,
          'agent.version.id': run.agent_version_id,
          'agent.run.step_count': run.step_count,
          'agent.cost.micros': Number(run.cost_micros),
          // Tenancy travels with the span: a collector shared across teams must be able
          // to answer "whose run was this" without joining back to us (§5.2).
          'org.id': run.org_id,
          'namespace.id': run.namespace_id,
          'tenant.ref': run.tenant_ref,
          ...(run.parent_run_id ? { 'agent.parent_run.id': run.parent_run_id } : {}),
        },
      });

      for (const step of steps.filter((s) => s.run_id === run.id)) {
        // A step still running when its run ended has no end to report. Clamping it to the
        // run's end would invent a duration; skipping it loses the fact that it existed,
        // so it is exported with a zero-width span and an unset status.
        const stepStart = step.started_at ?? start;
        const stepEnd = step.ended_at ?? stepStart;
        spans.push({
          spanKey: step.id,
          parentSpanKey: run.id,
          traceKey: run.trace_id ?? run.id,
          name: `agent.step ${step.kind}`,
          startedAt: stepStart,
          endedAt: stepEnd,
          status: step.status === 'succeeded' ? 'ok' : step.status === 'failed' ? 'error' : 'unset',
          ...(step.status === 'failed' ? { statusMessage: errorMessage(step.error) } : {}),
          attributes: {
            'gen_ai.operation.name': step.kind === 'model_call' ? 'chat' : step.kind,
            'agent.step.seq': step.seq,
            'agent.step.kind': step.kind,
            'agent.step.status': step.status,
            'agent.run.id': run.id,
            'org.id': run.org_id,
            'namespace.id': run.namespace_id,
            'tenant.ref': run.tenant_ref,
            ...(step.model_id ? { 'gen_ai.request.model': step.model_id } : {}),
            ...(step.input_tokens === null ? {} : { 'gen_ai.usage.input_tokens': step.input_tokens }),
            ...(step.output_tokens === null ? {} : { 'gen_ai.usage.output_tokens': step.output_tokens }),
            ...(step.cost_micros === null ? {} : { 'agent.cost.micros': Number(step.cost_micros) }),
            ...(step.latency_ms === null ? {} : { 'agent.step.latency_ms': step.latency_ms }),
          },
        });
      }
    }

    const outcome = await this.exporter.export(spans);
    if (outcome.refused) {
      // The cursor does NOT advance. A refused batch is unshipped, and stepping over it
      // would silently drop exactly the window in which the misconfiguration existed.
      this.log.warn(`trace export refused: ${outcome.refused}`);
      return { runs: 0, spans: 0, refused: outcome.refused };
    }

    const last = runs[runs.length - 1]!.ended_at!;
    await this.db
      .insertInto('trace_export_cursor')
      .values({ id: true, exported_through: last })
      .onConflict((oc) => oc.column('id').doUpdateSet({ exported_through: last }))
      .execute();

    return { runs: runs.length, spans: outcome.exported };
  }
}

const errorMessage = (error: unknown): string => {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return 'failed';
};
