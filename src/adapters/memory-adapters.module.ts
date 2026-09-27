import { Module } from '@nestjs/common';
import { PostgresMemoryStore } from './memory/postgres.memory-store.js';
import { PgVectorIndex } from './memory/pgvector.index.js';
import { PgVectorKnowledgeIndex } from './knowledge/pgvector.knowledge-index.js';
import { DeterministicEmbedder } from './memory/deterministic.embedder.js';
import { GeminiEmbedder } from './memory/gemini.embedder.js';
import { InMemoryCache } from './memory/in-memory.cache.js';
import { PostgresRelationIndex } from './memory/postgres.relation-index.js';
import { ExtractiveSummarizer } from './memory/extractive.summarizer.js';
import { KNOWLEDGE_INDEX } from '../domain/ports/knowledge.port.js';
import {
  EMBEDDER, MEMORY_CACHE, MEMORY_STORE, RELATION_INDEX, SUMMARIZER, VECTOR_INDEX,
} from '../domain/ports/memory.port.js';

/**
 * The memory seams (§6), plus the knowledge index and the relation index.
 *
 * One module because they share the embedder: memory and knowledge vectors must come from the
 * same model, and two bindings of EMBEDDER would let them drift apart. The relation index
 * is here for the same reason it is a memory port -- lineage is an edge between records --
 * and artifacts and traces import this module to read it.
 *
 * Swapping pgvector for a dedicated vector database, or Postgres for a document store,
 * changes this file and nothing in src/domain.
 */
@Module({
  providers: [
    PostgresMemoryStore,
    PgVectorIndex,
    PgVectorKnowledgeIndex,
    DeterministicEmbedder,
    GeminiEmbedder,
    InMemoryCache,
    PostgresRelationIndex,
    ExtractiveSummarizer,
    { provide: MEMORY_STORE, useExisting: PostgresMemoryStore },
    { provide: VECTOR_INDEX, useExisting: PgVectorIndex },
    { provide: KNOWLEDGE_INDEX, useExisting: PgVectorKnowledgeIndex },
    {
      // A real embedder when one is configured, a deterministic offline one otherwise.
      // Selected at boot rather than per call: switching embedders mid-corpus leaves the
      // index half in each vector space, which degrades silently.
      provide: EMBEDDER,
      inject: [DeterministicEmbedder, GeminiEmbedder],
      useFactory: (offline: DeterministicEmbedder, gemini: GeminiEmbedder) =>
        GeminiEmbedder.isConfigured() && process.env['EMBEDDER'] !== 'deterministic'
          ? gemini
          : offline,
    },
    { provide: MEMORY_CACHE, useExisting: InMemoryCache },
    { provide: RELATION_INDEX, useExisting: PostgresRelationIndex },
    { provide: SUMMARIZER, useExisting: ExtractiveSummarizer },
  ],
  exports: [
    MEMORY_STORE, VECTOR_INDEX, EMBEDDER, MEMORY_CACHE, RELATION_INDEX, SUMMARIZER,
    KNOWLEDGE_INDEX,
  ],
})
export class MemoryAdaptersModule {}
