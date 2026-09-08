import type { Readable } from 'node:stream';

export const OBJECT_STORE = Symbol('ObjectStore');

export interface StoredObject {
  /** Opaque to the domain: `file://…`, `s3://bucket/key`, `gs://…`. */
  uri: string;
  sizeBytes: number;
  contentHash: string;
}

/**
 * §11.2. Large content does not belong in Postgres.
 *
 * The port speaks bytes and URIs, never buckets or paths, so a filesystem, S3, GCS or
 * Azure adapter are interchangeable. `key` is supplied by the caller and is already
 * tenant-scoped -- the store neither knows nor enforces tenancy, which is the domain's
 * job and must not become a per-adapter reimplementation.
 */
export interface ObjectStore {
  readonly id: string;
  put(key: string, body: Buffer, mediaType: string): Promise<StoredObject>;
  get(uri: string): Promise<Buffer>;
  stream(uri: string): Promise<Readable>;
  delete(uri: string): Promise<void>;
  exists(uri: string): Promise<boolean>;
}
