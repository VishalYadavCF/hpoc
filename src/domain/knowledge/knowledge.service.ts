import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import { EMBEDDER, type Embedder } from '../ports/memory.port.js';
import { KNOWLEDGE_INDEX, type KnowledgeHit, type KnowledgeIndex } from '../ports/knowledge.port.js';
import { AdmissionRejected, PlatformError } from '../errors/platform.errors.js';
import { chunk, DEFAULT_CHUNKING, type ChunkOptions } from './chunker.js';

export interface CreateCollectionInput {
  orgId: string;
  namespaceId: string;
  name: string;
  description?: string | null;
  createdBy?: string | null;
}

export interface IngestInput {
  orgId: string;
  collectionId: string;
  body: string;
  title?: string | null;
  sourceUri?: string | null;
  metadata?: Record<string, unknown>;
  chunking?: ChunkOptions;
}

export interface IngestResult {
  documentId: string;
  chunkCount: number;
  /** True when identical bytes were already indexed and nothing was re-embedded. */
  unchanged: boolean;
}

/**
 * Curated corpora over the shared embedding contract.
 *
 * The distinction this service exists to hold: memory is LEARNED and per-tenant, this is
 * AUTHORED and namespace-wide. Both are retrieved by cosine similarity over the same
 * Embedder -- that part genuinely is "just vector search" -- but a document can be
 * corrected, re-ingested and deleted, and every chunk it produced has to follow. Memory
 * records have no such owner, which is why they are not the same table.
 */
@Injectable()
export class KnowledgeService {
  private readonly log = new Logger(KnowledgeService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uow: UnitOfWork,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    @Inject(KNOWLEDGE_INDEX) private readonly index: KnowledgeIndex,
  ) {}

  async createCollection(input: CreateCollectionInput): Promise<{ id: string; name: string }> {
    const existing = await this.db
      .selectFrom('knowledge_collections')
      .select(['id', 'name'])
      .where('namespace_id', '=', input.namespaceId)
      .where('name', '=', input.name)
      .executeTakeFirst();
    if (existing) return existing;

    // The embedder is recorded, not referenced. A collection embedded by one model and
    // searched by another returns a ranking that looks plausible and is meaningless, so
    // the identity of the model that produced these vectors has to survive in the row.
    return this.uow.run(async (tx) => {
      const row = await tx
        .insertInto('knowledge_collections')
        .values({
          org_id: input.orgId,
          namespace_id: input.namespaceId,
          name: input.name,
          description: input.description ?? null,
          embedder_id: this.embedder.id,
          dimensions: this.embedder.dimensions,
          created_by: input.createdBy ?? null,
        })
        .returning(['id', 'name'])
        .executeTakeFirstOrThrow();

      // Creating a corpus in your own namespace authorises it there; the grant exists so
      // access can be REVOKED without deleting the corpus, which is the operation that
      // actually needs to exist. Requiring a separate grant call after every create would
      // just be a step every caller performs unconditionally.
      if (input.createdBy) {
        await tx
          .insertInto('capability_grants')
          .values({
            org_id: input.orgId,
            grant_source: 'service',
            namespace_id: input.namespaceId,
            resource_kind: 'knowledge_collection',
            resource_id: row.id,
            granted_by: input.createdBy,
          })
          .execute();
      }
      return row;
    });
  }

  async listCollections(namespaceId: string) {
    return this.db
      .selectFrom('knowledge_collections as c')
      .leftJoin('knowledge_documents as d', 'd.collection_id', 'c.id')
      .select(({ fn }) => [
        'c.id', 'c.name', 'c.description', 'c.embedder_id', 'c.dimensions', 'c.status',
        fn.count<string>('d.id').distinct().as('document_count'),
      ])
      .where('c.namespace_id', '=', namespaceId)
      .where('c.archived_at', 'is', null)
      .groupBy(['c.id', 'c.name', 'c.description', 'c.embedder_id', 'c.dimensions', 'c.status'])
      .orderBy('c.name')
      .execute();
  }

  /**
   * Ingests one document: chunk, embed, replace.
   *
   * Idempotent on content. The obvious way to keep a knowledge base fresh is a job that
   * re-pushes every source nightly, and that must not re-embed an unchanged corpus every
   * night -- it costs real money and rewrites rows for no benefit. The hash covers the
   * chunking parameters too, because the same bytes chunked differently are a different
   * index and reporting them as `unchanged` would be a lie.
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    const collection = await this.db
      .selectFrom('knowledge_collections')
      .select(['id', 'org_id', 'embedder_id', 'dimensions', 'status'])
      .where('id', '=', input.collectionId)
      .executeTakeFirst();
    if (!collection) {
      throw new PlatformError('not_found', `Collection ${input.collectionId} does not exist`);
    }
    if (collection.status !== 'active') {
      throw new PlatformError('invalid_transition', `Collection is ${collection.status}`);
    }
    if (collection.embedder_id !== this.embedder.id) {
      // Refuse rather than mix. Two embedders in one collection produce vectors that sit
      // in different spaces, and the distances between them are arithmetic, not meaning.
      throw new PlatformError(
        'invalid_transition',
        `Collection was embedded by "${collection.embedder_id}" but this node runs ` +
          `"${this.embedder.id}". Re-ingest the collection under the new embedder instead.`,
        { hint: 'Changing embedding model is a re-ingest, not a config change' },
      );
    }

    const chunking = input.chunking ?? DEFAULT_CHUNKING;
    const contentHash = createHash('sha256')
      .update(`${chunking.maxChars}:${chunking.overlapChars}\n`)
      .update(input.body)
      .digest('hex');

    const prior = await this.db
      .selectFrom('knowledge_documents')
      .select(['id', 'chunk_count'])
      .where('collection_id', '=', input.collectionId)
      .where('content_hash', '=', contentHash)
      .executeTakeFirst();
    if (prior) {
      return { documentId: prior.id, chunkCount: prior.chunk_count, unchanged: true };
    }

    const chunks = chunk(input.body, chunking);
    if (chunks.length === 0) {
      throw new AdmissionRejected(['body: document is empty after trimming']);
    }

    // Embedding happens BEFORE the transaction opens. It is a network call to a third
    // party with third-party latency, and holding a write transaction across it puts an
    // external service's p99 directly into this database's lock-wait time.
    const vectors = await this.embedder.embed(chunks.map((c) => c.content));
    if (vectors.length !== chunks.length) {
      throw new PlatformError(
        'upstream_failure',
        `Embedder returned ${vectors.length} vectors for ${chunks.length} chunks`,
      );
    }

    return this.uow.run(async (tx) => {
      const doc = await tx
        .insertInto('knowledge_documents')
        .values({
          collection_id: input.collectionId,
          org_id: collection.org_id,
          source_uri: input.sourceUri ?? null,
          title: input.title ?? null,
          content_hash: contentHash,
          body: input.body,
          metadata: JSON.stringify(input.metadata ?? {}),
          chunk_count: chunks.length,
          indexed_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await this.index.replaceChunks(
        tx,
        doc.id,
        input.collectionId,
        chunks.map((c, i) => ({ ord: c.ord, content: c.content, vector: vectors[i]! })),
      );

      this.log.debug(`ingested ${chunks.length} chunks into collection ${input.collectionId}`);
      return { documentId: doc.id, chunkCount: chunks.length, unchanged: false };
    });
  }

  async listDocuments(collectionId: string) {
    return this.db
      .selectFrom('knowledge_documents')
      .select(['id', 'title', 'source_uri', 'content_hash', 'chunk_count', 'indexed_at'])
      .where('collection_id', '=', collectionId)
      .orderBy('created_at', 'desc')
      .limit(200)
      .execute();
  }

  /** Chunks cascade with the document, which is the whole reason they are its children. */
  async deleteDocument(collectionId: string, documentId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('knowledge_documents')
      .where('id', '=', documentId)
      .where('collection_id', '=', collectionId)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n) > 0;
  }

  async search(query: {
    collectionIds: string[];
    text: string;
    limit?: number;
  }): Promise<KnowledgeHit[]> {
    if (query.collectionIds.length === 0 || query.text.trim().length === 0) return [];
    const [vector] = await this.embedder.embed([query.text]);
    if (!vector) return [];
    return this.index.search({
      vector,
      collectionIds: query.collectionIds,
      limit: query.limit ?? 5,
    });
  }
}
