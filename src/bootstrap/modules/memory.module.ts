import { Module } from '@nestjs/common';
import { MemoryEngine } from '../../domain/memory/memory.engine.js';
import { ContextEngine } from '../../domain/context/context.engine.js';
import { MemoryAdaptersModule } from '../../adapters/memory-adapters.module.js';

/** Memory tiers, recall and lifecycle (§6), and fitting recalled context into a budget (§7). */
@Module({
  imports: [MemoryAdaptersModule],
  providers: [MemoryEngine, ContextEngine],
  exports: [MemoryEngine, ContextEngine],
})
export class MemoryModule {}
