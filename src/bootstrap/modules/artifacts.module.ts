import { Module } from '@nestjs/common';
import { ArtifactService } from '../../domain/artifact/artifact.service.js';
import { StorageAdaptersModule } from '../../adapters/storage-adapters.module.js';
import { MemoryAdaptersModule } from '../../adapters/memory-adapters.module.js';

/** Artifact bytes in the object store, metadata and lineage in Postgres (§11.2). */
@Module({
  imports: [StorageAdaptersModule, MemoryAdaptersModule],
  providers: [ArtifactService],
  exports: [ArtifactService],
})
export class ArtifactsModule {}
