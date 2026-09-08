import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Executor, Tx } from '../../platform/persistence/database.js';
import { RUN_EVENTS_CHANNEL } from '../../platform/persistence/event-listener.js';
import { maybeContext } from '../../platform/context/platform-context.js';
import { CURRENT_EVENT_SCHEMA_VERSION, type EventTypeValue } from './taxonomy.js';
import { upcast } from './upcasters.js';
import { registerAllUpcasters } from './upcasters/index.js';

// Registered at import time: a read that needed an upcaster before the registry was
// populated would throw, and reads happen from three processes.
registerAllUpcasters();

export interface AppendInput {
  runId: string;
  threadId: string;
  agentVersionId: string;
  orgId: string;
  namespaceId: string;
  tenantRef: string;
  type: EventTypeValue;
  payload: Record<string, unknown>;
  stepId?: string | null;
  parentRunId?: string | null;
  protocolMetadata?: Record<string, unknown>;
}

export interface StoredEvent {
  seq: number;
  type: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  stepId: string | null;
}

@Injectable()
export class EventLog {
  /**
   * Appends one event, allocating its per-run sequence number in the same transaction.
   *
   * The `UPDATE ... RETURNING` takes the run's row lock, which serialises allocation per
   * run. That lock -- not the primary key -- is what delivers §4.5's total per-run
   * ordering: `events` is partitioned by occurred_at, so Postgres requires the partition
   * key in the PK and (run_id, seq) cannot be enforced by the index across partitions.
   * See db/ERD.md.
   *
   * MUST be called inside the same transaction as the state change it records.
   */
  async append(tx: Tx, input: AppendInput): Promise<number> {
    const { last_event_seq: seq } = await tx
      .updateTable('runs')
      .set({ last_event_seq: sql<string>`last_event_seq + 1` })
      .where('id', '=', input.runId)
      .returning('last_event_seq')
      .executeTakeFirstOrThrow();

    const ctx = maybeContext();

    await tx
      .insertInto('events')
      .values({
        run_id: input.runId,
        seq: String(seq),
        schema_version: CURRENT_EVENT_SCHEMA_VERSION,
        event_type: input.type,
        thread_id: input.threadId,
        parent_run_id: input.parentRunId ?? null,
        step_id: input.stepId ?? null,
        agent_version_id: input.agentVersionId,
        org_id: input.orgId,
        namespace_id: input.namespaceId,
        tenant_ref: input.tenantRef,
        trace_id: ctx?.traceId ?? null,
        span_id: null,
        causation_id: ctx?.runId ?? null,
        correlation_id: ctx?.correlationId ?? null,
        principal_id: ctx?.callerPrincipalId ?? null,
        delegation_chain: JSON.stringify(ctx?.delegationChain ?? []),
        protocol_metadata: JSON.stringify(input.protocolMetadata ?? {}),
        payload: JSON.stringify(input.payload),
      })
      .execute();

    return Number(seq);
  }

  /**
   * Notifies subscribers AFTER the transaction commits.
   *
   * Payload is `<runId>:<seq>` only -- the ~8 KB NOTIFY cap (§12.1) means the event is
   * never carried, just its identity, and the subscriber reads the row.
   */
  async notify(db: Executor, runId: string, seq: number): Promise<void> {
    await sql`SELECT pg_notify(${RUN_EVENTS_CHANNEL}, ${`${runId}:${seq}`})`.execute(db);
  }

  /** Reads events after a cursor, lifting historical payloads to the current shape (§0.2). */
  async read(
    db: Executor,
    runId: string,
    afterSeq: number,
    limit = 500,
  ): Promise<StoredEvent[]> {
    const rows = await db
      .selectFrom('events')
      .select(['seq', 'event_type', 'occurred_at', 'payload', 'schema_version', 'step_id'])
      .where('run_id', '=', runId)
      .where('seq', '>', String(afterSeq))
      .orderBy('seq', 'asc')
      .limit(limit)
      .execute();

    return rows.map((r) => ({
      seq: Number(r.seq),
      type: r.event_type,
      occurredAt: r.occurred_at,
      stepId: r.step_id,
      payload: upcast(
        r.event_type,
        r.schema_version,
        (r.payload ?? {}) as Record<string, unknown>,
      ),
    }));
  }
}
