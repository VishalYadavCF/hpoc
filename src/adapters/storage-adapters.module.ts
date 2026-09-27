import { Module } from '@nestjs/common';
import { FilesystemObjectStore } from './storage/filesystem.object-store.js';
import { MinioObjectStore } from './storage/minio.object-store.js';
import { OBJECT_STORE } from '../domain/ports/object-store.port.js';

/**
 * The object store, shared by skills, artifacts and the deep-agents workspace.
 *
 * §11.2's carve-out from the Postgres-centric bet. MinIO/S3/GCS is one class on this port;
 * MINIO_ENDPOINT opts in the same way MODEL_CREDENTIAL_EMBEDDING opts in Gemini.
 */
@Module({
  providers: [
    FilesystemObjectStore,
    MinioObjectStore,
    {
      provide: OBJECT_STORE,
      inject: [FilesystemObjectStore, MinioObjectStore],
      useFactory: (filesystem: FilesystemObjectStore, minio: MinioObjectStore) =>
        MinioObjectStore.isConfigured() ? minio : filesystem,
    },
  ],
  exports: [OBJECT_STORE],
})
export class StorageAdaptersModule {}
