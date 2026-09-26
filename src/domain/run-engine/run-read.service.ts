import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { NotFound } from '../errors/platform.errors.js';
import type { EffectClass } from '../../platform/persistence/schema.types.js';

export interface ListRunsFilter {
  threadId?: string;
  agentVersionId?: string;
  agentName?: string;
  status?: string[];
  initiator?: string;
  since?: Date;
  limit: number;
  cursor?: string;
}

/**
 * The read side of a run.
 *
 * Separate from `RunService` on purpose: that class owns transitions, and mixing
 * twenty projections into it would bury the state machine. Nothing here writes.
 *
 * Every method is tenant-scoped through `requireContext`, and a run belonging to another
 * tenant is a 404 rather than a 403 — distinguishing them lets a caller enumerate run ids
 * that exist but are not theirs.
 */
@Injectable()
export class RunReadService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Keyset pagination on (created_at, id), not OFFSET.
   *
   * A run list is append-heavy and read while it grows. `OFFSET` re-scans and skips, so
   * page 40 gets slower as the table fills, and a run inserted between requests shifts
   * every subsequent page — the caller silently misses rows. A cursor on an indexed,
   * unique-per-row pair does neither.
   */
  async list(filter: ListRunsFilter) {
    const ctx = requireContext();
    let q = this.db
      .selectFrom('runs as r')
      .leftJoin('agent_versions as v', 'v.id', 'r.agent_version_id')
      .leftJoin('agents as a', 'a.id', 'v.agent_id')
      .select([
        'r.id', 'r.thread_id', 'r.agent_version_id', 'a.name as agent_name', 'v.version',
        'r.status', 'r.initiator', 'r.step_count', 'r.cost_micros',
        'r.created_at', 'r.started_at', 'r.ended_at', 'r.parent_run_id',
      ])
      .where('r.namespace_id', '=', ctx.namespaceId)
      .where('r.tenant_ref', '=', ctx.tenantRef)
      .orderBy('r.created_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(filter.limit + 1);

    if (filter.threadId) q = q.where('r.thread_id', '=', filter.threadId);
    if (filter.agentVersionId) q = q.where('r.agent_version_id', '=', filter.agentVersionId);
    if (filter.agentName) q = q.where('a.name', '=', filter.agentName);
    if (filter.status?.length) q = q.where('r.status', 'in', filter.status as never[]);
    if (filter.initiator) q = q.where('r.initiator', '=', filter.initiator as never);
    if (filter.since) q = q.where('r.created_at', '>=', filter.since);

    if (filter.cursor) {
      const decoded = decodeCursor(filter.cursor);
      if (decoded) {
        // Row-value comparison, so the tie-break on id is part of the same index scan
        // rather than a second filter applied after the fact.
        q = q.where(sql<boolean>`(r.created_at, r.id) < (${decoded.createdAt}, ${decoded.id})`);
      }
    }

    const rows = await q.execute();
    // One extra row was requested: its presence is how "there is another page" is known
    // without a second COUNT query over a growing table.
    const hasMore = rows.length > filter.limit;
    const page = hasMore ? rows.slice(0, filter.limit) : rows;
    const last = page[page.length - 1];

    return {
      runs: page.map((r) => ({ ...r, cost_micros: Number(r.cost_micros) })),
      nextCursor: hasMore && last ? encodeCursor(last.created_at as Date, last.id) : null,
    };
  }

  /** One step by its sequence number, which is what a trace or an error message names. */
  async step(runId: string, seq: number) {
    await this.assertVisible(runId);
    const step = await this.db
      .selectFrom('steps')
      .select([
        'id', 'seq', 'kind', 'status', 'attempt', 'input', 'output', 'error',
        'latency_ms', 'started_at', 'ended_at',
      ])
      .where('run_id', '=', runId)
      .where('seq', '=', seq)
      .executeTakeFirst();
    if (!step) throw new NotFound('step', `${runId}#${seq}`);
    return step;
  }

  /**
   * Tool calls with the authorization that permitted each one (§16.2).
   *
   * `effects` and `capability_decision` are the point. "What did this run do" is
   * answerable from the step list; "what was it allowed to do, and who decided" is only
   * answerable here, and it is the question an incident actually asks.
   */
  async toolInvocations(runId: string) {
    await this.assertVisible(runId);
    const rows = await this.db
      .selectFrom('tool_invocations as ti')
      .innerJoin('tools as t', 't.id', 'ti.tool_id')
      .innerJoin('steps as s', 's.id', 'ti.step_id')
      .select((eb) => [
        'ti.id', 's.seq as step_seq', 't.ref as tool_ref', 'ti.origin',
        // ::text[] deliberately: pg hands back the literal '{a,b}' string for a custom
        // enum array, on which Array methods silently do not exist.
        sql<EffectClass[]>`ti.effects::text[]`.as('effects'),
        'ti.definition_hash', 'ti.idempotency_key', 'ti.attempt',
        'ti.authorized_principal_id', 'ti.capability_decision', 'ti.interaction_id',
        'ti.sandbox_profile', 'ti.error', 'ti.started_at', 'ti.ended_at',
        'ti.status', 'ti.request', 'ti.request_artifact_id',
        'ti.response', 'ti.response_artifact_id',
      ])
      .where('ti.run_id', '=', runId)
      .orderBy('s.seq')
      .execute();
    // An offloaded payload is named by its artifact id, never inlined (as `checkpoints`).
    return rows.map((r) => ({
      ...r,
      request: r.request_artifact_id !== null ? null : r.request,
      response: r.response_artifact_id !== null ? null : r.response,
    }));
  }

  async checkpoints(runId: string) {
    await this.assertVisible(runId);
    return this.db
      .selectFrom('checkpoints')
      .select([
        'id', 'step_seq', 'schema_version', 'parent_checkpoint_id',
        'state_artifact_id', 'state_hash', 'durability', 'created_at',
      ])
      // The state itself is deliberately omitted from the list: an adapter state can be
      // megabytes, and a list endpoint that returns every one of them is a memory
      // incident waiting for a long-running run.
      .where('run_id', '=', runId)
      .orderBy('step_seq', 'desc')
      .execute();
  }

  async checkpoint(runId: string, checkpointId: string) {
    await this.assertVisible(runId);
    const row = await this.db
      .selectFrom('checkpoints')
      .select([
        'id', 'step_seq', 'schema_version', 'parent_checkpoint_id', 'state',
        'state_artifact_id', 'state_hash', 'durability', 'created_at',
      ])
      .where('run_id', '=', runId)
      .where('id', '=', checkpointId)
      .executeTakeFirst();
    if (!row) throw new NotFound('checkpoint', checkpointId);
    return {
      ...row,
      // §0.2: a state written under an older schema is readable, and the reader is told
      // which version it was written under rather than being left to assume the current one.
      note:
        row.state_artifact_id !== null
          ? 'State was offloaded to an artifact (§11.2); fetch it from /v1/artifacts.'
          : undefined,
    };
  }

  async interactions(runId: string) {
    await this.assertVisible(runId);
    return this.db
      .selectFrom('interactions')
      .select([
        'id', 'kind', 'status', 'prompt', 'response', 'responder_principal_id',
        'originating_run_id', 'delegation_chain',
        'expires_at', 'created_at', 'resolved_at',
      ])
      .where('run_id', '=', runId)
      .orderBy('created_at')
      .execute();
  }

  async artifacts(runId: string) {
    await this.assertVisible(runId);
    return this.db
      .selectFrom('artifacts')
      .select([
        'id', 'content_hash', 'media_type', 'size_bytes', 'version',
        'parent_artifact_id', 'state', 'legal_hold', 'expires_at', 'created_at',
      ])
      .where('produced_by_run_id', '=', runId)
      .orderBy('created_at')
      .execute();
  }

  /**
   * Children: sub-agent delegations AND peer calls (§4.6, §13.4).
   *
   * Both, in one list, distinguished by `initiator` and by the peer name where there is
   * one. A caller debugging "why is my run still waiting" does not care which mechanism
   * produced the child — it cares which child has not finished.
   */
  async children(runId: string) {
    await this.assertVisible(runId);
    return this.db
      .selectFrom('runs as r')
      .leftJoin('peer_tasks as pt', 'pt.child_run_id', 'r.id')
      .leftJoin('peers as p', 'p.id', 'pt.peer_id')
      .leftJoin('agent_versions as v', 'v.id', 'r.agent_version_id')
      .leftJoin('agents as a', 'a.id', 'v.agent_id')
      .select([
        'r.id', 'r.status', 'r.initiator', 'a.name as agent_name',
        'p.name as peer_name', 'pt.binding as peer_binding',
        'r.delegation_depth', 'r.cost_micros', 'r.created_at', 'r.ended_at',
      ])
      .where('r.parent_run_id', '=', runId)
      .orderBy('r.created_at')
      .execute();
  }

  /**
   * Token and cost accounting, including everything the run's children spent.
   *
   * `usage_ledger` records per-step usage for THIS run; the recursive half matters because
   * §13.5 makes a child spend the originating tenant's ceiling. A usage report that
   * stopped at the run's own steps would understate a delegating agent's real cost by
   * however much its children used, which is exactly the number anyone asking is after.
   */
  async usage(runId: string) {
    await this.assertVisible(runId);

    const own = await this.db
      .selectFrom('usage_ledger as u')
      .leftJoin('models as m', 'm.id', 'u.model_id')
      .select(({ fn }) => [
        'm.ref as model_ref',
        fn.sum<string>('u.input_tokens').as('input_tokens'),
        fn.sum<string>('u.output_tokens').as('output_tokens'),
        fn.sum<string>('u.cost_micros').as('cost_micros'),
        fn.count<string>('u.id').as('calls'),
      ])
      .where('u.run_id', '=', runId)
      .groupBy('m.ref')
      .execute();

    const tree = await sql<{ total_cost_micros: string; run_count: string }>`
      WITH RECURSIVE descendants AS (
        SELECT id, cost_micros FROM runs WHERE id = ${runId}
        UNION ALL
        SELECT r.id, r.cost_micros
          FROM runs r JOIN descendants d ON r.parent_run_id = d.id
      )
      SELECT COALESCE(SUM(cost_micros), 0)::text AS total_cost_micros,
             COUNT(*)::text AS run_count
        FROM descendants
    `.execute(this.db);

    const own_cost = own.reduce((t, r) => t + Number(r.cost_micros ?? 0), 0);
    return {
      byModel: own.map((r) => ({
        modelRef: r.model_ref,
        inputTokens: Number(r.input_tokens ?? 0),
        outputTokens: Number(r.output_tokens ?? 0),
        costMicros: Number(r.cost_micros ?? 0),
        calls: Number(r.calls ?? 0),
      })),
      ownCostMicros: own_cost,
      treeCostMicros: Number(tree.rows[0]?.total_cost_micros ?? 0),
      runsInTree: Number(tree.rows[0]?.run_count ?? 1),
    };
  }

  /**
   * §15.3: where each piece of information in the output came from.
   *
   * Read from `lineage_edges`, which the memory engine and artifact service write as they
   * go. Derived at read time from steps instead, this would be a plausible-looking
   * reconstruction rather than a record — and the whole value of lineage is that it was
   * observed rather than inferred.
   */
  async lineage(runId: string) {
    await this.assertVisible(runId);
    const edges = await this.db
      .selectFrom('lineage_edges')
      .select(['derived_kind', 'derived_id', 'source_kind', 'source_id', 'relation', 'observed_at'])
      .where('run_id', '=', runId)
      .orderBy('observed_at')
      .limit(2_000)
      .execute();

    return {
      edges,
      ...(edges.length === 0
        ? {
            note:
              'No lineage edges were recorded. Edges are written by the memory engine and ' +
              'artifact service as they run, so a run that used neither has none — this is ' +
              'not a gap in the trace.',
          }
        : {}),
    };
  }

  /** Tenant scoping, in one place so no projection above can forget it. */
  private async assertVisible(runId: string): Promise<void> {
    const ctx = requireContext();
    const row = await this.db
      .selectFrom('runs')
      .select('id')
      .where('id', '=', runId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .executeTakeFirst();
    // 404, not 403: telling a caller that a run exists but is not theirs is an
    // enumeration oracle over other tenants' run ids.
    if (!row) throw new NotFound('run', runId);
  }
}

const encodeCursor = (createdAt: Date, id: string): string =>
  Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    // A malformed cursor is ignored rather than thrown on: the worst case is the caller
    // gets page one again, where throwing would break a client that stored a cursor
    // across a deploy.
    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}
