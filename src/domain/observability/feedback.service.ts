import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { NotFound, PlatformError } from '../errors/platform.errors.js';

export interface SubmitFeedback {
  runId?: string | null;
  threadId?: string | null;
  interactionId?: string | null;
  rating?: number | null;
  label?: string | null;
  comment?: string | null;
  correction?: Record<string, unknown> | null;
}

/**
 * §15.5's production signal: user feedback, task success, human corrections.
 *
 * Feedback is bound to an AGENT VERSION, resolved from the run rather than supplied by the
 * caller. A caller-supplied version could attribute a complaint to the wrong release,
 * which is precisely the number a promotion decision turns on.
 */
@Injectable()
export class FeedbackService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async submit(input: SubmitFeedback): Promise<{ id: string; agentVersionId: string }> {
    const ctx = requireContext();

    if (!input.runId && !input.threadId) {
      throw new PlatformError('admission_rejected', 'Feedback needs a runId or a threadId', {
        required: ['runId', 'threadId'],
      });
    }

    const run = input.runId
      ? await this.db
          .selectFrom('runs')
          .select(['id', 'thread_id', 'agent_version_id'])
          .where('org_id', '=', ctx.orgId)
          .where('namespace_id', '=', ctx.namespaceId)
          .where('tenant_ref', '=', ctx.tenantRef)
          .where('id', '=', input.runId)
          .executeTakeFirst()
      : await this.db
          .selectFrom('runs')
          .select(['id', 'thread_id', 'agent_version_id'])
          .where('org_id', '=', ctx.orgId)
          .where('namespace_id', '=', ctx.namespaceId)
          .where('tenant_ref', '=', ctx.tenantRef)
          .where('thread_id', '=', input.threadId!)
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst();

    // Tenant-scoped: feedback on a run the caller cannot see is a 404, not a silent
    // orphan row that would then skew someone else's version comparison.
    if (!run) throw new NotFound('run for feedback', input.runId ?? input.threadId!);

    const row = await this.db
      .insertInto('feedback')
      .values({
        org_id: ctx.orgId,
        namespace_id: ctx.namespaceId,
        tenant_ref: ctx.tenantRef,
        run_id: run.id,
        thread_id: input.threadId ?? run.thread_id,
        interaction_id: input.interactionId ?? null,
        agent_version_id: run.agent_version_id,
        principal_id: ctx.onBehalfOfPrincipalId ?? ctx.callerPrincipalId,
        rating: input.rating ?? null,
        label: input.label ?? null,
        comment: input.comment ?? null,
        correction: input.correction ? JSON.stringify(input.correction) : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return { id: row.id, agentVersionId: run.agent_version_id };
  }

  async list(filter: { runId?: string; threadId?: string; limit?: number }) {
    const ctx = requireContext();
    let q = this.db
      .selectFrom('feedback')
      .select(['id', 'run_id', 'thread_id', 'agent_version_id', 'rating', 'label', 'comment', 'correction', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .orderBy('created_at', 'desc')
      .limit(filter.limit ?? 100);
    if (filter.runId) q = q.where('run_id', '=', filter.runId);
    if (filter.threadId) q = q.where('thread_id', '=', filter.threadId);
    return q.execute();
  }

  /** Rolled up by version — the number a promotion or rollback decision reads. */
  async summary(sinceHours = 24 * 7) {
    const ctx = requireContext();
    const rows = await sql<{
      agent_version_id: string; agent_name: string | null; version: number | null;
      total: string; avg_rating: number | null; negative: string; corrections: string;
    }>`
      SELECT f.agent_version_id,
             a.name AS agent_name,
             av.version,
             count(*)                                        AS total,
             avg(f.rating)                                   AS avg_rating,
             count(*) FILTER (WHERE f.rating IS NOT NULL AND f.rating <= 0) AS negative,
             count(*) FILTER (WHERE f.correction IS NOT NULL)               AS corrections
        FROM feedback f
        JOIN agent_versions av ON av.id = f.agent_version_id
        LEFT JOIN agents a ON a.id = av.agent_id
       WHERE f.org_id = ${ctx.orgId} AND f.namespace_id = ${ctx.namespaceId}
         AND f.tenant_ref = ${ctx.tenantRef}
         AND f.created_at > now() - ${`${sinceHours} hours`}::interval
       GROUP BY f.agent_version_id, a.name, av.version
       ORDER BY total DESC
       LIMIT 50
    `.execute(this.db);

    return rows.rows.map((r) => ({
      agentVersionId: r.agent_version_id,
      agent: r.agent_name,
      version: r.version,
      total: Number(r.total),
      avgRating: r.avg_rating === null ? null : Math.round(Number(r.avg_rating) * 100) / 100,
      negative: Number(r.negative),
      // Human corrections are the highest-signal feedback there is: someone cared enough
      // to say what the right answer was.
      corrections: Number(r.corrections),
    }));
  }
}
