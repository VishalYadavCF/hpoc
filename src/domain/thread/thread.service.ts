import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { NotFound } from '../errors/platform.errors.js';

export interface ThreadMessage {
  role: 'user' | 'assistant';
  content: unknown;
  runId: string;
  at: Date;
}

/**
 * §3. The thread carries continuity -- workspace, artifacts, memory -- while the run
 * carries execution: retries, checkpoints, leases. Conflating them is what loses
 * resumability across turns, so they are separate aggregates here too.
 */
@Injectable()
export class ThreadService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(input: { title?: string; externalRef?: string; metadata?: Record<string, unknown> }) {
    const ctx = requireContext();
    return this.db
      .insertInto('threads')
      .values({
        org_id: ctx.orgId,
        namespace_id: ctx.namespaceId,
        tenant_ref: ctx.tenantRef,
        user_principal_id: ctx.onBehalfOfPrincipalId,
        title: input.title ?? null,
        external_ref: input.externalRef ?? null,
        metadata: JSON.stringify(input.metadata ?? {}),
      })
      .returning(['id', 'created_at'])
      .executeTakeFirstOrThrow();
  }

  async get(id: string) {
    const ctx = requireContext();
    const row = await this.db
      .selectFrom('threads')
      .selectAll()
      // Tenant predicates from context, never from arguments: a thread in another tenant
      // must be indistinguishable from one that does not exist.
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFound('thread', id);
    return row;
  }

  async list(limit = 50) {
    const ctx = requireContext();
    return this.db
      .selectFrom('threads')
      .select(['id', 'title', 'status', 'external_ref', 'created_at', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .execute();
  }

  async listRuns(threadId: string) {
    await this.get(threadId);
    return this.db
      .selectFrom('runs')
      .select(['id', 'status', 'input', 'output', 'error', 'step_count', 'cost_micros', 'created_at', 'ended_at'])
      .where('thread_id', '=', threadId)
      .orderBy('created_at', 'asc')
      .execute();
  }

  /**
   * §6.3 transcript fidelity: this projects what the user actually RECEIVED, from run
   * inputs and terminal outputs -- not from intermediate model generations. An agent that
   * generated text and then had it discarded (a barge-in, a failed run) must not appear
   * to have said it.
   */
  async messages(threadId: string): Promise<ThreadMessage[]> {
    const runs = await this.listRuns(threadId);
    const out: ThreadMessage[] = [];
    for (const run of runs) {
      if (run.input !== null) {
        out.push({ role: 'user', content: run.input, runId: run.id, at: run.created_at });
      }
      if (run.status === 'completed' && run.output !== null) {
        out.push({
          role: 'assistant',
          content: (run.output as { text?: unknown }).text ?? run.output,
          runId: run.id,
          at: run.ended_at ?? run.created_at,
        });
      }
    }
    return out;
  }

  async archive(id: string): Promise<void> {
    await this.get(id);
    await this.db
      .updateTable('threads')
      .set({ status: 'archived', archived_at: new Date() })
      .where('id', '=', id)
      .execute();
  }
}
