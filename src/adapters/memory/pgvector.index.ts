import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db, Tx } from '../../platform/persistence/database.js';
import {
  EMBEDDER,
  EMBEDDING_DIMENSIONS,
  type Embedder,
  type MemoryFilter,
  type VectorIndex,
} from '../../domain/ports/memory.port.js';

/**
 * pgvector-backed ANN search.
 *
 * Pre-filters by tenant IN SQL rather than over-fetching and filtering in memory: a
 * tenant with a thousand records must not have its ranking decided by another tenant's
 * million. A dedicated vector database swapping in here has to offer the same, which is
 * why the port carries the filter.
 */
@Injectable()
export class PgVectorIndex implements VectorIndex, OnApplicationBootstrap {
  readonly id = 'pgvector';
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private readonly log = new Logger(PgVectorIndex.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
  ) {}

  /**
   * Vectors from two models are not comparable, and a column that accepted both would
   * return nonsense rankings rather than an error. Fail at boot instead.
   */
  onApplicationBootstrap(): void {
    if (this.embedder.dimensions !== this.dimensions) {
      throw new Error(
        `Embedder "${this.embedder.id}" produces ${this.embedder.dimensions} dimensions but ` +
          `the pgvector column holds ${this.dimensions}. Changing embedding model is a ` +
          `migration and a re-embed, not a config change.`,
      );
    }
  }

  async upsert(tx: Tx, memoryId: string, modelId: string, vector: number[]): Promise<void> {
    if (vector.length !== this.dimensions) {
      throw new Error(`Expected ${this.dimensions} dimensions, got ${vector.length}`);
    }
    const literal = `[${vector.join(',')}]`;
    await sql`
      INSERT INTO memory_embeddings (memory_id, model_id, dimensions, embedding)
      VALUES (${memoryId}, ${modelId}, ${this.dimensions}, ${literal}::vector)
      ON CONFLICT (memory_id, model_id)
      DO UPDATE SET embedding = EXCLUDED.embedding, created_at = now()
    `.execute(tx);
  }

  async search(query: {
    vector: number[];
    filter: MemoryFilter;
    limit: number;
  }): Promise<{ memoryId: string; score: number }[]> {
    const { filter } = query;
    const literal = `[${query.vector.join(',')}]`;
    const tiers = filter.tiers?.length ? filter.tiers : null;

    // 1 - cosine distance, so a higher score is a closer match and the engine's ranking
    // maths reads the same whatever index is behind this port.
    const rows = await sql<{ memory_id: string; score: number }>`
      SELECT e.memory_id, 1 - (e.embedding <=> ${literal}::vector) AS score
        FROM memory_embeddings e
        JOIN memory_records m ON m.id = e.memory_id
       WHERE m.org_id = ${filter.orgId}
         AND m.namespace_id = ${filter.namespaceId}
         AND (m.tenant_ref = ${filter.tenantRef}
              OR (${filter.includeShared ?? false} = true AND m.shared = true))
         AND m.superseded_by IS NULL
         AND (${tiers}::text[] IS NULL OR m.tier::text = ANY(${tiers}::text[]))
         AND (${filter.trustedOnly ?? false} = false OR m.trusted = true)
       ORDER BY e.embedding <=> ${literal}::vector
       LIMIT ${query.limit}
    `.execute(this.db);

    return rows.rows.map((r) => ({ memoryId: r.memory_id, score: Number(r.score) }));
  }

  async remove(memoryId: string): Promise<void> {
    await this.db.deleteFrom('memory_embeddings').where('memory_id', '=', memoryId).execute();
  }
}
