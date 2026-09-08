import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { NotFound } from '../errors/platform.errors.js';
import { RELATION_INDEX, type RelationIndex } from '../ports/memory.port.js';

export interface TraceStep {
  seq: number;
  kind: string;
  status: string;
  latencyMs: number | null;
  detail: Record<string, unknown>;
}

export interface TraceRun {
  runId: string;
  parentRunId: string | null;
  agentVersionId: string;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  wallMs: number | null;
  costMicros: number;
  tokens: { input: number; output: number };
  steps: TraceStep[];
  interactions: { id: string; kind: string; status: string; waitedMs: number | null }[];
  /** §15.2: where did latency originate? */
  latency: {
    queueWaitMs: number | null;
    modelMs: number;
    toolMs: number;
    humanWaitMs: number;
    unaccountedMs: number | null;
  };
  children: TraceRun[];
}

/**
 * §15.2. Assembles one distributed execution as a single graph.
 *
 * The questions it has to answer are named in the spec: which agent initiated this, which
 * were delegated work, which tools each invoked, WHERE LATENCY ORIGINATED, which execution
 * failed, which model calls consumed tokens, and the complete causal path.
 *
 * Latency attribution is the part worth getting right. Wall time minus the sum of step
 * latencies is not overhead -- it is queue wait plus human wait plus genuine overhead, and
 * conflating those sends people optimising the wrong thing. A chatbot that "feels slow"
 * because it sat in a queue needs more workers, not a faster model.
 */
@Injectable()
export class TraceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RELATION_INDEX) private readonly relations: RelationIndex,
  ) {}

  async forRun(runId: string): Promise<TraceRun> {
    const ctx = requireContext();
    const root = await this.db
      .selectFrom('runs')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!root) throw new NotFound('run', runId);
    return this.assemble(runId);
  }

  /** Every run sharing a trace id — a request that fanned out across agents. */
  async forTraceId(traceId: string): Promise<{ traceId: string; runs: TraceRun[] }> {
    const ctx = requireContext();
    const roots = await this.db
      .selectFrom('runs')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .where('trace_id', '=', traceId)
      .where('parent_run_id', 'is', null)
      .orderBy('created_at')
      .execute();
    if (roots.length === 0) throw new NotFound('trace', traceId);
    return {
      traceId,
      runs: await Promise.all(roots.map((r) => this.assemble(r.id))),
    };
  }

  /** A whole conversation: every turn on a thread, oldest first. */
  async forThread(threadId: string): Promise<{ threadId: string; turns: TraceRun[] }> {
    const ctx = requireContext();
    const runs = await this.db
      .selectFrom('runs')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .where('thread_id', '=', threadId)
      .where('parent_run_id', 'is', null)
      .orderBy('created_at')
      .execute();
    return { threadId, turns: await Promise.all(runs.map((r) => this.assemble(r.id))) };
  }

  async lineage(kind: string, id: string, depth = 3) {
    const edges = await this.relations.neighbours({ kind, id }, 'out', depth);
    return { node: { kind, id }, depth, edges };
  }

  private async assemble(runId: string, seen = new Set<string>()): Promise<TraceRun> {
    // Cycle guard: §4.6's depth limit is enforced at dispatch, but a trace assembled from
    // stored rows must not assume that held for historical data.
    if (seen.has(runId)) {
      throw new Error(`Cycle in run graph at ${runId}`);
    }
    seen.add(runId);

    const run = await this.db
      .selectFrom('runs')
      .select([
        'id', 'parent_run_id', 'agent_version_id', 'status', 'queued_at', 'started_at',
        'ended_at', 'cost_micros', 'input_tokens', 'output_tokens',
      ])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();

    const steps = await this.db
      .selectFrom('steps as s')
      .leftJoin('tool_invocations as ti', 'ti.step_id', 's.id')
      .leftJoin('models as m', 'm.id', 's.model_id')
      .leftJoin('tools as t', 't.id', 'ti.tool_id')
      .select((eb) => [
        's.seq', 's.kind', 's.status', 's.latency_ms', 's.error',
        's.input_tokens', 's.output_tokens', 's.cost_micros',
        eb.ref('m.ref').as('model_ref'),
        's.fallback_from_model_id',
        eb.ref('t.ref').as('tool_ref'),
        eb.ref('ti.status').as('tool_status'),
        eb.ref('ti.latency_ms').as('tool_latency_ms'),
        sql<string[] | null>`ti.effects::text[]`.as('effects'),
      ])
      .where('s.run_id', '=', runId)
      .orderBy('s.seq')
      .execute();

    const interactions = await this.db
      .selectFrom('interactions')
      .select(['id', 'kind', 'status', 'created_at', 'resolved_at'])
      .where('run_id', '=', runId)
      .orderBy('created_at')
      .execute();

    const childRows = await this.db
      .selectFrom('runs').select('id').where('parent_run_id', '=', runId).orderBy('created_at').execute();
    const children = await Promise.all(childRows.map((c) => this.assemble(c.id, seen)));

    const modelMs = sum(steps.filter((s) => s.kind === 'model_call').map((s) => s.latency_ms));
    const toolMs = sum(steps.filter((s) => s.kind === 'tool_call').map((s) => s.latency_ms));
    const humanWaitMs = sum(interactions.map((i) => durationMs(i.created_at, i.resolved_at)));

    // Clamped at zero. All of these timestamps now come from the database clock, so a
    // negative value means something is writing one with a different clock -- worth
    // never surfacing as a negative duration, which reads as a measurement bug rather
    // than the configuration bug it is.
    const wallMs = durationMs(run.started_at, run.ended_at);
    const queueWaitMs = durationMs(run.queued_at, run.started_at);

    return {
      runId: run.id,
      parentRunId: run.parent_run_id,
      agentVersionId: run.agent_version_id,
      status: run.status,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      wallMs,
      costMicros: Number(run.cost_micros),
      tokens: { input: Number(run.input_tokens), output: Number(run.output_tokens) },
      steps: steps.map((s) => ({
        seq: s.seq,
        kind: s.kind,
        status: s.status,
        latencyMs: s.latency_ms,
        detail: prune({
          model: s.model_ref,
          // A run that silently switched models must be diagnosable here, not only in the
          // event log (§9).
          fellBackFrom: s.fallback_from_model_id,
          tool: s.tool_ref,
          toolStatus: s.tool_status,
          effects: s.effects,
          inputTokens: s.input_tokens,
          outputTokens: s.output_tokens,
          costMicros: s.cost_micros === null ? null : Number(s.cost_micros),
          error: s.error,
        }),
      })),
      interactions: interactions.map((i) => ({
        id: i.id,
        kind: i.kind,
        status: i.status,
        waitedMs: durationMs(i.created_at, i.resolved_at),
      })),
      latency: {
        queueWaitMs,
        modelMs,
        toolMs,
        humanWaitMs,
        // What is left after model, tool and human time. Large values here mean framework
        // or platform overhead, which is a different fix from a slow model.
        unaccountedMs: wallMs === null ? null : Math.max(wallMs - modelMs - toolMs - humanWaitMs, 0),
      },
      children,
    };
  }
}

const durationMs = (from: Date | null, to: Date | null): number | null =>
  from && to ? Math.max(new Date(to).getTime() - new Date(from).getTime(), 0) : null;

const sum = (values: (number | null)[]): number =>
  values.reduce<number>((total, v) => total + (v ?? 0), 0);

const prune = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
