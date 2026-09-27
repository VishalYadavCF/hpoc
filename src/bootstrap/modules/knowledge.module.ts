import { Module } from '@nestjs/common';
import { KnowledgeService } from '../../domain/knowledge/knowledge.service.js';
import { MemoryAdaptersModule } from '../../adapters/memory-adapters.module.js';

/**
 * Collection ingestion and retrieval. Takes the memory adapters for the embedder, which must
 * be the same binding memory uses.
 */
@Module({
  imports: [MemoryAdaptersModule],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
