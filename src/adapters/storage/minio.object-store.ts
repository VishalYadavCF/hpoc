import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Client } from 'minio';
import type {
  ObjectStore,
  StoredObject,
} from '../../domain/ports/object-store.port.js';

async function bufferOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * MinIO / S3-compatible object store.
 *
 * Same port as {@link FilesystemObjectStore}; the URI scheme (`s3://bucket/key`) is the
 * one `object-store.port.ts` already documents for this class of backend. `key` is trusted
 * as-is -- unlike a filesystem path, an object key cannot escape its bucket, so there is no
 * traversal guard here. The only trust boundary worth checking is that a `uri` passed back
 * in actually names *this* adapter's configured bucket.
 */
@Injectable()
export class MinioObjectStore implements ObjectStore {
  readonly id = 'minio';
  private readonly log = new Logger(MinioObjectStore.name);
  private readonly bucket = process.env['MINIO_BUCKET'] ?? 'hpoc-artifacts';
  private readonly client = new Client({
    endPoint: process.env['MINIO_ENDPOINT'] ?? 'localhost',
    port: Number(process.env['MINIO_PORT'] ?? 9000),
    useSSL: process.env['MINIO_USE_SSL'] === 'true',
    accessKey: process.env['MINIO_ACCESS_KEY'] ?? 'minioadmin',
    secretKey: process.env['MINIO_SECRET_KEY'] ?? 'minioadmin',
  });
  private bucketReady: Promise<void> | undefined;

  static isConfigured(): boolean {
    return Boolean(process.env['MINIO_ENDPOINT']);
  }

  async put(
    key: string,
    body: Buffer,
    mediaType: string,
  ): Promise<StoredObject> {
    await this.ensureBucket();
    await this.client.putObject(this.bucket, key, body, body.byteLength, {
      'Content-Type': mediaType,
    });
    return {
      uri: this.uriFor(key),
      sizeBytes: body.byteLength,
      contentHash: createHash('sha256').update(body).digest('hex'),
    };
  }

  async get(uri: string): Promise<Buffer> {
    return bufferOf(
      await this.client.getObject(this.bucket, this.keyFrom(uri)),
    );
  }

  async stream(uri: string): Promise<Readable> {
    return this.client.getObject(this.bucket, this.keyFrom(uri));
  }

  async delete(uri: string): Promise<void> {
    await this.client.removeObject(this.bucket, this.keyFrom(uri));
  }

  async list(prefix: string): Promise<{ key: string; uri: string }[]> {
    await this.ensureBucket();
    return new Promise((resolve, reject) => {
      const found: { key: string; uri: string }[] = [];
      const stream = this.client.listObjectsV2(this.bucket, prefix, true);
      stream.on('data', (obj: { name?: string }) => {
        if (obj.name) found.push({ key: obj.name, uri: this.uriFor(obj.name) });
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(found));
    });
  }

  async exists(uri: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucket, this.keyFrom(uri));
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'NotFound') return false;
      throw err;
    }
  }

  /** Lazy and memoized, so an idle adapter never dials MinIO at DI-instantiation time. */
  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      if (!(await this.client.bucketExists(this.bucket))) {
        this.log.log(`Creating bucket ${this.bucket}`);
        await this.client.makeBucket(this.bucket);
      }
    })();
    return this.bucketReady;
  }

  private uriFor(key: string): string {
    return `s3://${this.bucket}/${key}`;
  }

  private keyFrom(uri: string): string {
    const prefix = `s3://${this.bucket}/`;
    if (!uri.startsWith(prefix)) {
      throw new Error(
        `Refusing uri naming a different bucket than ${this.bucket}: ${uri}`,
      );
    }
    return uri.slice(prefix.length);
  }
}
