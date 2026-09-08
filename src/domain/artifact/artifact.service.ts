import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db, Tx } from '../../platform/persistence/database.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { OBJECT_STORE, type ObjectStore } from '../ports/object-store.port.js';
import { RELATION_INDEX, type RelationIndex } from '../ports/memory.port.js';
import { NotFound, PlatformError } from '../errors/platform.errors.js';

export interface WriteArtifact {
  body: Buffer;
  mediaType: string;
  threadId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  /** Supersedes an earlier artifact, forming a version chain (§11.2). */
  parentArtifactId?: string | null;
  retentionPolicy?: string | null;
  ttlSeconds?: number | null;
  metadata?: Record<string, unknown>;
  derivedFrom?: { kind: string; id: string }[];
}

export interface ArtifactRow {
  id: string;
  contentHash: string;
  mediaType: string;
  sizeBytes: number;
  version: number;
  parentArtifactId: string | null;
  legalHold: boolean;
  state: string;
  expiresAt: Date | null;
  metadata: unknown;
  createdAt: Date;
  deduped: boolean;
}

/**
 * §11.2. Postgres holds metadata, hash and reference; the bytes live in an object store.
 *
 * The lifecycle is the point, not the storage: ownership, versioning, retention, TTL,
 * dedup, garbage collection, access control, lineage and legal hold. Artifacts are what
 * a coding agent's patches, a workflow draft and a §7 context offload all become, so
 * getting the lifecycle wrong is not recoverable by the consumers.
 */
@Injectable()
export class ArtifactService {
  private readonly log = new Logger(ArtifactService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(RELATION_INDEX) private readonly relations: RelationIndex,
    private readonly uow: UnitOfWork,
  ) {}

  describe(): Record<string, string> {
    return { objectStore: this.store.id };
  }

  /**
   * Writes bytes and their metadata, deduplicating within the tenant.
   *
   * The key is `{org}/{namespace}/{tenant}/{hash}`, so identical bytes in two tenants are
   * two objects. Sharing one path would mean deleting one tenant's artifact destroys
   * bytes the other still references, and refcounting across a tenant boundary is a worse
   * problem than paying twice for a blob.
   */
  async write(input: WriteArtifact, existingTx?: Tx): Promise<ArtifactRow> {
    const ctx = requireContext();
    const contentHash = createHash('sha256').update(input.body).digest('hex');

    const existing = await this.db
      .selectFrom('artifacts')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .where('content_hash', '=', contentHash)
      .where('state', '<>', 'deleted')
      .executeTakeFirst();

    if (existing) {
      // Same bytes, same tenant: reuse. A TTL extension is honoured -- a second producer
      // wanting the content kept longer must win over the first wanting it dropped.
      if (input.ttlSeconds) {
        const wanted = new Date(Date.now() + input.ttlSeconds * 1000);
        if (!existing.expires_at || new Date(existing.expires_at) < wanted) {
          await this.db.updateTable('artifacts').set({ expires_at: wanted })
            .where('id', '=', existing.id).execute();
        }
      }
      return { ...toRow(existing), deduped: true };
    }

    const key = `${ctx.orgId}/${ctx.namespaceId}/${encodeURIComponent(ctx.tenantRef)}/${contentHash}`;
    const stored = await this.store.put(key, input.body, input.mediaType);

    const write = async (tx: Tx): Promise<ArtifactRow> => {
      const version = input.parentArtifactId
        ? ((
            await tx.selectFrom('artifacts').select('version')
              .where('id', '=', input.parentArtifactId).executeTakeFirst()
          )?.version ?? 0) + 1
        : 1;

      const row = await tx
        .insertInto('artifacts')
        .values({
          org_id: ctx.orgId,
          namespace_id: ctx.namespaceId,
          tenant_ref: ctx.tenantRef,
          thread_id: input.threadId ?? null,
          produced_by_run_id: input.runId ?? null,
          produced_by_step_id: input.stepId ?? null,
          content_hash: contentHash,
          storage_uri: stored.uri,
          media_type: input.mediaType,
          size_bytes: String(stored.sizeBytes),
          // Phase 1 relies on storage-level encryption; the column records WHICH key so a
          // rotation can find what it must re-wrap. Naming it now costs nothing; adding
          // it later is a migration across every artifact.
          encryption_key_ref: process.env['ARTIFACT_KEY_REF'] ?? 'storage-default',
          version,
          parent_artifact_id: input.parentArtifactId ?? null,
          retention_policy: input.retentionPolicy ?? null,
          expires_at: input.ttlSeconds ? new Date(Date.now() + input.ttlSeconds * 1000) : null,
          metadata: JSON.stringify(input.metadata ?? {}),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      for (const source of input.derivedFrom ?? []) {
        await this.relations.relate(tx, {
          orgId: ctx.orgId,
          tenantRef: ctx.tenantRef,
          fromKind: 'artifact',
          fromId: row.id,
          toKind: source.kind,
          toId: source.id,
          relation: 'derived_from',
          runId: input.runId ?? null,
        });
      }
      if (input.parentArtifactId) {
        await this.relations.relate(tx, {
          orgId: ctx.orgId,
          tenantRef: ctx.tenantRef,
          fromKind: 'artifact',
          fromId: row.id,
          toKind: 'artifact',
          toId: input.parentArtifactId,
          relation: 'supersedes',
        });
      }
      return { ...toRow(row), deduped: false };
    };

    return existingTx ? write(existingTx) : this.uow.run(write);
  }

  async get(id: string): Promise<ArtifactRow> {
    return { ...toRow(await this.row(id)), deduped: false };
  }

  async read(id: string): Promise<{ body: Buffer; mediaType: string }> {
    const row = await this.row(id);
    if (row.state === 'deleted') throw new NotFound('artifact content', id);
    return { body: await this.store.get(row.storage_uri), mediaType: row.media_type };
  }

  async stream(id: string): Promise<{ stream: Readable; mediaType: string; sizeBytes: number }> {
    const row = await this.row(id);
    if (row.state === 'deleted') throw new NotFound('artifact content', id);
    return {
      stream: await this.store.stream(row.storage_uri),
      mediaType: row.media_type,
      sizeBytes: Number(row.size_bytes),
    };
  }

  async list(filter: { threadId?: string; runId?: string; limit?: number }) {
    const ctx = requireContext();
    let q = this.db
      .selectFrom('artifacts')
      .select(['id', 'content_hash', 'media_type', 'size_bytes', 'version',
               'parent_artifact_id', 'legal_hold', 'state', 'expires_at', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .where('state', '<>', 'deleted')
      .orderBy('created_at', 'desc')
      .limit(filter.limit ?? 100);
    if (filter.threadId) q = q.where('thread_id', '=', filter.threadId);
    if (filter.runId) q = q.where('produced_by_run_id', '=', filter.runId);
    return q.execute();
  }

  /** The version chain, oldest first. */
  async versions(id: string) {
    const row = await this.row(id);
    const rows = await sql<{ id: string; version: number; content_hash: string; created_at: Date }>`
      WITH RECURSIVE chain AS (
        SELECT id, version, content_hash, parent_artifact_id, created_at
          FROM artifacts WHERE id = ${row.id}
        UNION ALL
        SELECT a.id, a.version, a.content_hash, a.parent_artifact_id, a.created_at
          FROM artifacts a JOIN chain c ON a.id = c.parent_artifact_id
      )
      SELECT id, version, content_hash, created_at FROM chain ORDER BY version
    `.execute(this.db);
    return rows.rows;
  }

  /** §11.2: a dispute transcript under hold must survive TTL expiry. */
  async setLegalHold(id: string, held: boolean): Promise<void> {
    await this.row(id);
    await this.db.updateTable('artifacts').set({ legal_hold: held }).where('id', '=', id).execute();
  }

  async remove(id: string): Promise<void> {
    const row = await this.row(id);
    if (row.legal_hold) {
      // Refused, not deferred. A hold that a delete can bypass is not a hold.
      throw new PlatformError('capability_denied', 'Artifact is under legal hold', { id });
    }
    await this.store.delete(row.storage_uri).catch((e: Error) =>
      this.log.warn(`blob for ${id} could not be removed: ${e.message}`),
    );
    await this.db
      .updateTable('artifacts')
      .set({ state: 'deleted', deleted_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Garbage collection: expired, live, not held.
   *
   * The row is tombstoned rather than deleted so lineage pointing at it still resolves --
   * §15.3 must be able to say "this came from an artifact that has since been collected"
   * instead of dead-ending on a missing id.
   */
  async collectGarbage(now = new Date(), limit = 200): Promise<number> {
    const due = await this.db
      .selectFrom('artifacts')
      .select(['id', 'storage_uri'])
      .where('state', '=', 'live')
      .where('legal_hold', '=', false)
      .where('expires_at', 'is not', null)
      .where('expires_at', '<=', now)
      .limit(limit)
      .execute();

    for (const row of due) {
      await this.store.delete(row.storage_uri).catch(() => undefined);
      await this.db
        .updateTable('artifacts')
        .set({ state: 'deleted', deleted_at: sql`now()` })
        .where('id', '=', row.id)
        .execute();
    }
    if (due.length > 0) this.log.log(`collected ${due.length} expired artifact(s)`);
    return due.length;
  }

  private async row(id: string) {
    const ctx = requireContext();
    const row = await this.db
      .selectFrom('artifacts')
      .selectAll()
      // Tenant-scoped: another tenant's artifact is indistinguishable from a missing one.
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('tenant_ref', '=', ctx.tenantRef)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFound('artifact', id);
    return row;
  }
}

const toRow = (r: {
  id: string; content_hash: string; media_type: string; size_bytes: string; version: number;
  parent_artifact_id: string | null; legal_hold: boolean; state: string;
  expires_at: Date | null; metadata: unknown; created_at: Date;
}): Omit<ArtifactRow, 'deduped'> => ({
  id: r.id,
  contentHash: r.content_hash,
  mediaType: r.media_type,
  sizeBytes: Number(r.size_bytes),
  version: r.version,
  parentArtifactId: r.parent_artifact_id,
  legalHold: r.legal_hold,
  state: r.state,
  expiresAt: r.expires_at,
  metadata: r.metadata,
  createdAt: r.created_at,
});
