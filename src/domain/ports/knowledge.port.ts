import type { Tx } from '../../platform/persistence/database.js';

export const KNOWLEDGE_INDEX = Symbol('KnowledgeIndex');

export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  collectionId: string;
  ord: number;
  content: string;
  /** Cosine similarity, 1 = identical. Same scale as VectorIndex.search. */
  score: number;
}

/**
 * Search over an authored corpus.
 *
 * A separate seam from `VectorIndex` even though both are pgvector today, because the two
 * take genuinely different filters: `VectorIndex.search` narrows by tenant, tier and
 * scope, none of which a collection has. Forcing knowledge through it would have meant
 * passing a MemoryFilter full of values that are lies -- a `tenantRef` for rows that
 * belong to every tenant, a `tier` for rows that have none.
 *
 * The `Embedder` seam is deliberately SHARED with memory rather than duplicated. There is
 * one embedding contract in this system; two would mean two dimensions, two models, and
 * scores that cannot be compared in the one place they meet -- a single run that recalls
 * memory and searches knowledge in the same step.
 */
export interface KnowledgeIndex {
  readonly id: string;
  readonly dimensions: number;
  /** Replaces every chunk of a document. Re-ingestion is a replace, never a merge. */
  replaceChunks(
    tx: Tx,
    documentId: string,
    collectionId: string,
    chunks: { ord: number; content: string; vector: number[] }[],
  ): Promise<void>;
  search(query: {
    vector: number[];
    collectionIds: string[];
    limit: number;
  }): Promise<KnowledgeHit[]>;
}
