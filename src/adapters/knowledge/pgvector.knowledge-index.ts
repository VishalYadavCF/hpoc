import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db, Tx } from '../../platform/persistence/database.js';
import { EMBEDDER, EMBEDDING_DIMENSIONS, type Embedder } from '../../domain/ports/memory.port.js';
import type { KnowledgeHit, KnowledgeIndex } from '../../domain/ports/knowledge.port.js';

/**
 * pgvector-backed search over authored corpora.
 *
 * Shares the Embedder with memory on purpose (see KnowledgeIndex), so it inherits the
 * same boot assertion: a mismatch between the embedder's dimension and the column's is a
 * migration, not a config change, and it fails loudly here rather than returning a
 * confidently wrong ranking later.
 */
@Injectable()
export class PgVectorKnowledgeIndex implements KnowledgeIndex, OnApplicationBootstrap {
  readonly id = 'pgvector-knowledge';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
  ) {}

  onApplicationBootstrap(): void {
    if (this.embedder.dimensions !== this.dimensions) {
      throw new Error(
        `Embedder "${this.embedder.id}" produces ${this.embedder.dimensions} dimensions but ` +
          `knowledge_chunks holds ${this.dimensions}. Changing embedding model means ` +
          `re-ingesting every collection, not editing config.`,
      );
    }
  }

  /**
   * Delete-then-insert, in the caller's transaction.
   *
   * An upsert keyed on (document_id, ord) would leave orphans behind whenever a re-ingest
   * produces FEWER chunks than the previous one -- the tail of the old version stays in
   * the index and keeps ranking, so the corpus answers from text the document no longer
   * contains. That failure is silent and permanent, which is worse than the write cost.
   */
  async replaceChunks(
    tx: Tx,
    documentId: string,
    collectionId: string,
    chunks: { ord: number; content: string; vector: number[] }[],
  ): Promise<void> {
    await tx.deleteFrom('knowledge_chunks').where('document_id', '=', documentId).execute();
    if (chunks.length === 0) return;

    for (const c of chunks) {
      if (c.vector.length !== this.dimensions) {
        throw new Error(`Expected ${this.dimensions} dimensions, got ${c.vector.length}`);
      }
      await sql`
        INSERT INTO knowledge_chunks (document_id, collection_id, ord, content, embedding)
        VALUES (${documentId}, ${collectionId}, ${c.ord}, ${c.content},
                ${`[${c.vector.join(',')}]`}::vector)
      `.execute(tx);
    }
  }

  async search(query: {
    vector: number[];
    collectionIds: string[];
    limit: number;
  }): Promise<KnowledgeHit[]> {
    // An empty collection list means "search nothing", never "search everything". The
    // other reading turns a misconfigured agent into a cross-corpus reader.
    if (query.collectionIds.length === 0) return [];

    const literal = `[${query.vector.join(',')}]`;
    const rows = await sql<{
      id: string;
      document_id: string;
      collection_id: string;
      ord: number;
      content: string;
      score: number;
    }>`
      SELECT c.id, c.document_id, c.collection_id, c.ord, c.content,
             1 - (c.embedding <=> ${literal}::vector) AS score
        FROM knowledge_chunks c
       WHERE c.collection_id = ANY(${query.collectionIds}::uuid[])
         AND c.embedding IS NOT NULL
       ORDER BY c.embedding <=> ${literal}::vector
       LIMIT ${query.limit}
    `.execute(this.db);

    return rows.rows.map((r) => ({
      chunkId: r.id,
      documentId: r.document_id,
      collectionId: r.collection_id,
      ord: r.ord,
      content: r.content,
      score: Number(r.score),
    }));
  }
}
