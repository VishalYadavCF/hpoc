import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';
import type { ObjectStore, StoredObject } from '../../domain/ports/object-store.port.js';

/**
 * Filesystem object store.
 *
 * Correct for single-node development and for a deployment with a shared volume; an S3
 * adapter is one class implementing the same port and one line in `adapters.module.ts`.
 * Deliberately not shipped untested -- an S3 adapter written without an S3 to run it
 * against is worse than none, because it looks finished.
 */
@Injectable()
export class FilesystemObjectStore implements ObjectStore {
  readonly id = 'filesystem';
  private readonly log = new Logger(FilesystemObjectStore.name);
  private readonly root = resolve(process.env['ARTIFACT_ROOT'] ?? './.artifacts');

  async put(key: string, body: Buffer, _mediaType: string): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return {
      uri: pathToFileURL(path).href,
      sizeBytes: body.byteLength,
      contentHash: createHash('sha256').update(body).digest('hex'),
    };
  }

  async get(uri: string): Promise<Buffer> {
    return readFile(this.fromUri(uri));
  }

  async stream(uri: string): Promise<Readable> {
    return createReadStream(this.fromUri(uri));
  }

  async delete(uri: string): Promise<void> {
    await rm(this.fromUri(uri), { force: true });
  }

  async exists(uri: string): Promise<boolean> {
    try {
      await stat(this.fromUri(uri));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Keys are built from tenant ids and content hashes, but they still cross a filesystem
   * boundary -- so `..` is rejected rather than trusted. A traversal here reads or deletes
   * another tenant's bytes.
   */
  private pathFor(key: string): string {
    const path = resolve(this.root, key);
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`Refusing key that escapes the artifact root: ${key}`);
    }
    return path;
  }

  private fromUri(uri: string): string {
    const path = uri.startsWith('file://') ? fileURLToPath(uri) : uri;
    const resolved = resolve(path);
    if (resolved !== this.root && !resolved.startsWith(this.root + sep)) {
      throw new Error('Refusing to read outside the artifact root');
    }
    return resolved;
  }
}
