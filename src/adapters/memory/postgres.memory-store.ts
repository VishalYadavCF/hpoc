import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db, Tx } from '../../platform/persistence/database.js';
import type {
  MemoryFilter,
  MemoryRecord,
  MemoryStore,
} from '../../domain/ports/memory.port.js';

type Row = {
  id: string; org_id: string; namespace_id: string; tenant_ref: string;
  tier: string; scope: string; scope_user_id: string | null; scope_agent_id: string | null;
  scope_thread_id: string | null; scope_run_id: string | null;
  content: string | null; structured: unknown; artifact_id: string | null;
  provenance: string; trusted: boolean; delivered: boolean | null;
  salience: number; access_count: number; superseded_by: string | null;
  expires_at: Date | null; created_at: Date;
  shared: boolean; sharing_policy_id: string | null; source_tenant_ref: string | null;
};

@Injectable()
export class PostgresMemoryStore implements MemoryStore {
  readonly id = 'postgres';

  constructor(@Inject(DB) private readonly db: Db) {}

  async put(
    tx: Tx,
    record: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt'> & { id?: string },
  ): Promise<string> {
    const row = await tx
      .insertInto('memory_records')
      .values({
        ...(record.id ? { id: record.id } : {}),
        org_id: record.orgId,
        namespace_id: record.namespaceId,
        tenant_ref: record.tenantRef,
        tier: record.tier,
        scope: record.scope,
        scope_user_id: record.scopeRef.userId ?? null,
        scope_agent_id: record.scopeRef.agentId ?? null,
        scope_thread_id: record.scopeRef.threadId ?? null,
        scope_run_id: record.scopeRef.runId ?? null,
        content: record.content,
        structured: record.structured === undefined ? null : JSON.stringify(record.structured),
        artifact_id: record.artifactId,
        provenance: record.provenance,
        trusted: record.trusted,
        delivered: record.delivered,
        salience: record.salience,
        superseded_by: record.supersededBy,
        expires_at: record.expiresAt,
        shared: record.shared ?? false,
        sharing_policy_id: record.sharingPolicyId ?? null,
        source_tenant_ref: record.sourceTenantRef ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const row = await this.db
      .selectFrom('memory_records').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toRecord(row as unknown as Row) : null;
  }

  async byIds(ids: string[]): Promise<MemoryRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom('memory_records').selectAll().where('id', 'in', ids).execute();
    return rows.map((r) => toRecord(r as unknown as Row));
  }

  async query(filter: MemoryFilter): Promise<MemoryRecord[]> {
    let q = this.db
      .selectFrom('memory_records')
      .selectAll()
      // Tenancy is not optional on any path (§5.2).
      .where('org_id', '=', filter.orgId)
      .where('namespace_id', '=', filter.namespaceId)
      // Own rows always; shared rows only when the caller asked. Defaulting to include
      // them would mean a tenant silently reading another's data (§5.2).
      .where((eb) =>
        filter.includeShared
          ? eb.or([eb('tenant_ref', '=', filter.tenantRef), eb('shared', '=', true)])
          : eb('tenant_ref', '=', filter.tenantRef),
      );

    if (!filter.includeSuperseded) q = q.where('superseded_by', 'is', null);
    if (filter.tiers?.length) q = q.where('tier', 'in', filter.tiers as never[]);
    if (filter.scopes?.length) q = q.where('scope', 'in', filter.scopes as never[]);
    if (filter.provenance?.length) q = q.where('provenance', 'in', filter.provenance as never[]);
    if (filter.trustedOnly) q = q.where('trusted', '=', true);

    const ref = filter.scopeRef;
    if (ref?.threadId) q = q.where('scope_thread_id', '=', ref.threadId);
    if (ref?.agentId) q = q.where('scope_agent_id', '=', ref.agentId);
    if (ref?.userId) q = q.where('scope_user_id', '=', ref.userId);
    if (ref?.runId) q = q.where('scope_run_id', '=', ref.runId);

    const rows = await q
      .orderBy('salience', 'desc')
      .orderBy('created_at', 'desc')
      .limit(filter.limit ?? 50)
      .execute();
    return rows.map((r) => toRecord(r as unknown as Row));
  }

  async update(
    id: string,
    patch: Partial<Pick<MemoryRecord, 'content' | 'salience' | 'expiresAt' | 'supersededBy' | 'trusted'>>,
  ): Promise<void> {
    await this.db
      .updateTable('memory_records')
      .set({
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.salience !== undefined ? { salience: patch.salience } : {}),
        ...(patch.expiresAt !== undefined ? { expires_at: patch.expiresAt } : {}),
        ...(patch.supersededBy !== undefined ? { superseded_by: patch.supersededBy } : {}),
        ...(patch.trusted !== undefined ? { trusted: patch.trusted } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('memory_records').where('id', '=', id).execute();
  }

  async deleteByScope(filter: MemoryFilter): Promise<number> {
    let q = this.db
      .deleteFrom('memory_records')
      .where('org_id', '=', filter.orgId)
      .where('namespace_id', '=', filter.namespaceId)
      .where('tenant_ref', '=', filter.tenantRef);
    if (filter.tiers?.length) q = q.where('tier', 'in', filter.tiers as never[]);
    if (filter.scopeRef?.threadId) q = q.where('scope_thread_id', '=', filter.scopeRef.threadId);
    if (filter.scopeRef?.agentId) q = q.where('scope_agent_id', '=', filter.scopeRef.agentId);
    if (filter.scopeRef?.userId) q = q.where('scope_user_id', '=', filter.scopeRef.userId);
    const result = await q.executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  /** What was read, and how often, is the decay signal consolidation later acts on. */
  async touch(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .updateTable('memory_records')
      .set({ access_count: sql`access_count + 1`, last_accessed_at: new Date() })
      .where('id', 'in', ids)
      .execute();
  }

  async sharingPolicy(orgId: string, namespaceId: string) {
    const row = await this.db
      .selectFrom('memory_sharing_policies')
      // ::text[] because node-postgres has no parser for a custom enum array and hands
      // back the literal '{semantic}' string. Third time this has bitten: any read of a
      // Postgres enum ARRAY needs this cast.
      .select((eb) => [
        'id', 'redaction_policy',
        sql<string[]>`tiers::text[]`.as('tiers'),
      ])
      .where('org_id', '=', orgId)
      .where('namespace_id', '=', namespaceId)
      .where('enabled', '=', true)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return row
      ? { id: row.id, tiers: row.tiers as MemoryRecord['tier'][], redactionPolicy: row.redaction_policy }
      : null;
  }

  async expire(now: Date): Promise<number> {
    const result = await this.db
      .deleteFrom('memory_records')
      .where('expires_at', 'is not', null)
      .where('expires_at', '<=', now)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }
}

const toRecord = (r: Row): MemoryRecord => ({
  id: r.id,
  orgId: r.org_id,
  namespaceId: r.namespace_id,
  tenantRef: r.tenant_ref,
  tier: r.tier as MemoryRecord['tier'],
  scope: r.scope as MemoryRecord['scope'],
  scopeRef: {
    scope: r.scope as MemoryRecord['scope'],
    userId: r.scope_user_id,
    agentId: r.scope_agent_id,
    threadId: r.scope_thread_id,
    runId: r.scope_run_id,
  },
  content: r.content,
  structured: r.structured,
  artifactId: r.artifact_id,
  provenance: r.provenance as MemoryRecord['provenance'],
  trusted: r.trusted,
  delivered: r.delivered,
  salience: r.salience,
  accessCount: r.access_count,
  supersededBy: r.superseded_by,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  shared: r.shared,
  sharingPolicyId: r.sharing_policy_id,
  sourceTenantRef: r.source_tenant_ref,
});
