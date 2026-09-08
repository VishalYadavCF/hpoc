import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { NotFound } from '../errors/platform.errors.js';
import { upcast } from '../event-log/upcasters.js';
import { EventType } from '../event-log/taxonomy.js';

export interface ReplayedStep {
  seq: number;
  kind: string;
  status: 'running' | 'succeeded' | 'failed';
  toolRef?: string;
  costMicros: number;
}

export interface ReplayProjection {
  status: string;
  stepCount: number;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  output: unknown;
  error: unknown;
  steps: ReplayedStep[];
  interactionsOpened: number;
  interactionsResolved: number;
}

export interface Divergence {
  field: string;
  replayed: unknown;
  stored: unknown;
}

export interface ReplayResult {
  runId: string;
  eventsReplayed: number;
  throughSeq: number;
  schemaVersionsSeen: number[];
  projection: ReplayProjection;
  divergences: Divergence[];
  consistent: boolean;
  note: string;
}

/**
 * §0.2's replay, as an endpoint rather than only as a CI gate.
 *
 * The corpus test proves archived events can still be READ. This proves a specific run
 * can still be RECONSTRUCTED -- which is the thing anyone actually wants at 2am, and the
 * thing that quietly stops being true first.
 *
 * Two properties are deliberate:
 *
 *  - **Nothing executes.** Replay reads recorded outputs from the event log; it never
 *    calls a model, a tool or a peer, and never consults the response cache (§10: "a cache
 *    hit and a cache miss must produce identical replayable history"). Re-running side
 *    effects to reproduce a trace would be the single worst thing this endpoint could do.
 *
 *  - **It reports DIVERGENCE.** The projection is derived purely from events, then
 *    compared against the stored `runs` row. Agreement is the boring case; disagreement
 *    means the log and the tables tell different stories, which is exactly the corruption
 *    §0.2 exists to catch and which no other surface here would surface.
 */
@Injectable()
export class ReplayService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async replay(runId: string, throughSeq?: number): Promise<ReplayResult> {
    const ctx = requireContext();

    // Tenant-scoped like every other read: replaying another tenant's run would expose
    // its inputs, outputs and tool arguments wholesale (§5.2, and now RLS underneath).
    const run = await this.db
      .selectFrom('runs')
      .select([
        'id', 'status', 'output', 'error', 'cost_micros', 'input_tokens',
        'output_tokens', 'step_count', 'last_event_seq',
      ])
      .where('id', '=', runId)
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .executeTakeFirst();
    if (!run) throw new NotFound('run', runId);

    let q = this.db
      .selectFrom('events')
      .select(['seq', 'event_type', 'schema_version', 'payload'])
      .where('run_id', '=', runId);
    if (throughSeq !== undefined) q = q.where('seq', '<=', String(throughSeq));
    const rows = await q.orderBy('seq', 'asc').execute();

    const projection = this.project(rows);
    const divergences = this.compare(projection, run);

    return {
      runId,
      eventsReplayed: rows.length,
      throughSeq: rows.length > 0 ? Number(rows[rows.length - 1]!.seq) : 0,
      // Which historical shapes this run's log still contains. A run spanning a version
      // bump is the interesting one: it is where an absent upcaster shows up first.
      schemaVersionsSeen: [...new Set(rows.map((r) => r.schema_version))].sort((a, b) => a - b),
      projection,
      divergences,
      consistent: divergences.length === 0,
      note:
        'Reconstructed from the event log alone. No model, tool or peer was called and no ' +
        'cache was consulted, so this reproduces recorded history rather than re-running it.',
    };
  }

  /**
   * Folds the event log into the state it implies.
   *
   * Payloads are lifted through `upcast` first, so a run written before a schema bump
   * projects identically to one written after -- that equivalence IS §0.2's guarantee,
   * and a projection that read raw payloads would quietly stop honouring it.
   */
  private project(
    rows: { seq: string | number; event_type: string; schema_version: number; payload: unknown }[],
  ): ReplayProjection {
    const state: ReplayProjection = {
      status: 'queued',
      stepCount: 0,
      costMicros: 0,
      inputTokens: 0,
      outputTokens: 0,
      output: null,
      error: null,
      steps: [],
      interactionsOpened: 0,
      interactionsResolved: 0,
    };
    const stepBySeq = new Map<number, ReplayedStep>();

    for (const row of rows) {
      const payload = upcast(
        row.event_type,
        row.schema_version,
        (row.payload ?? {}) as Record<string, unknown>,
      );
      const num = (key: string): number => {
        const value = payload[key];
        return typeof value === 'number' ? value : 0;
      };

      switch (row.event_type) {
        case EventType.RunStarted:
        case EventType.RunResumed:
          state.status = 'running';
          break;
        case EventType.RunWaiting:
          state.status = 'waiting';
          break;
        case EventType.RunCheckpointed:
          state.status = 'checkpointed';
          break;
        case EventType.RunCompleted:
          state.status = 'completed';
          state.output = payload['output'] ?? null;
          break;
        case EventType.RunFailed:
          state.status = 'failed';
          state.error = payload['error'] ?? payload['message'] ?? null;
          break;
        case EventType.RunCancelled:
          state.status = 'cancelled';
          break;
        case EventType.RunDeadLettered:
          state.status = 'dead_letter';
          state.error = payload;
          break;

        case EventType.StepStarted: {
          const seq = num('seq');
          const step: ReplayedStep = {
            seq,
            kind: String(payload['kind'] ?? 'unknown'),
            status: 'running',
            costMicros: 0,
          };
          stepBySeq.set(seq, step);
          state.steps.push(step);
          state.stepCount += 1;
          break;
        }
        case EventType.StepCompleted: {
          const step = stepBySeq.get(num('seq'));
          if (step) step.status = 'succeeded';
          break;
        }
        case EventType.StepFailed: {
          const step = stepBySeq.get(num('seq'));
          if (step) step.status = 'failed';
          break;
        }

        case EventType.ModelCompleted: {
          state.inputTokens += num('inputTokens');
          state.outputTokens += num('outputTokens');
          state.costMicros += num('costMicros');
          const step = stepBySeq.get(num('seq'));
          if (step) step.costMicros += num('costMicros');
          break;
        }
        case EventType.ToolCalled: {
          const step = stepBySeq.get(num('seq'));
          if (step) step.toolRef = String(payload['toolRef'] ?? payload['tool'] ?? '');
          break;
        }
        case EventType.InteractionCreated:
          state.interactionsOpened += 1;
          break;
        case EventType.InteractionResolved:
          state.interactionsResolved += 1;
          break;
        default:
          break;
      }
    }

    return state;
  }

  /**
   * Compares the event-derived projection against the stored row.
   *
   * Only fields the log fully determines are compared. Cost is deliberately excluded from
   * the token/cost comparison when the run used a cached model response: §10 records a
   * cache hit as zero cost on the run while the event still carries what the call would
   * have cost, and reporting that as corruption would cry wolf on correct behaviour.
   */
  private compare(
    projection: ReplayProjection,
    stored: { status: string; step_count: number; input_tokens: string; output_tokens: string },
  ): Divergence[] {
    const divergences: Divergence[] = [];
    const check = (field: string, replayed: unknown, storedValue: unknown): void => {
      if (replayed !== storedValue) divergences.push({ field, replayed, stored: storedValue });
    };

    check('status', projection.status, stored.status);
    check('stepCount', projection.stepCount, stored.step_count);
    check('inputTokens', projection.inputTokens, Number(stored.input_tokens));
    check('outputTokens', projection.outputTokens, Number(stored.output_tokens));
    return divergences;
  }
}
