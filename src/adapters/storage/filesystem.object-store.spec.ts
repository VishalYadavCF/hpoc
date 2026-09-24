import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;

const freshStore = async () => {
  root = await mkdtemp(join(tmpdir(), 'hpoc-fs-object-store-'));
  process.env['ARTIFACT_ROOT'] = root;
  vi.resetModules();
  const { FilesystemObjectStore } = await import('./filesystem.object-store.js');
  return new FilesystemObjectStore();
};

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FilesystemObjectStore.list', () => {
  it('returns every key under a prefix, usable directly against get/delete', async () => {
    const store = await freshStore();
    const a = await store.put('org/workspace/a.txt', Buffer.from('a'), 'text/plain');
    const b = await store.put('org/workspace/nested/b.txt', Buffer.from('b'), 'text/plain');

    const found = await store.list('org/workspace');

    expect(new Set(found.map((f) => f.key))).toEqual(
      new Set(['org/workspace/a.txt', 'org/workspace/nested/b.txt']),
    );
    const byKey = new Map(found.map((f) => [f.key, f.uri]));
    expect(byKey.get('org/workspace/a.txt')).toBe(a.uri);
    expect(byKey.get('org/workspace/nested/b.txt')).toBe(b.uri);
  });

  it('returns an empty list for a prefix that was never written to', async () => {
    const store = await freshStore();

    expect(await store.list('never/used')).toEqual([]);
  });

  it('does not include keys outside the prefix', async () => {
    const store = await freshStore();
    await store.put('org/workspace/a.txt', Buffer.from('a'), 'text/plain');
    await store.put('org/other/b.txt', Buffer.from('b'), 'text/plain');

    const found = await store.list('org/workspace');

    expect(found.map((f) => f.key)).toEqual(['org/workspace/a.txt']);
  });

  /**
   * Pins the port's contract to raw string-prefix matching (S3 `listObjectsV2` semantics),
   * not directory listing -- the two disagree exactly on a prefix that is a partial path
   * segment. `MinioObjectStore.list` already behaves this way because it hands `prefix`
   * straight to the SDK; this store must match it, or the port's promise that a filesystem
   * and an S3 adapter are interchangeable (object-store.port.ts) is false for anyone who
   * calls `list` with a non-`/`-terminated prefix -- exactly what a single-key existence
   * check via `list(exactKey)` does.
   */
  it('matches a partial path segment, the same way an S3 prefix listing would', async () => {
    const store = await freshStore();
    await store.put('org/workspace/a.txt', Buffer.from('a'), 'text/plain');

    const found = await store.list('org/works');

    expect(found.map((f) => f.key)).toEqual(['org/workspace/a.txt']);
  });
});
