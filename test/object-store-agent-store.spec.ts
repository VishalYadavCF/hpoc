import { randomUUID } from 'node:crypto';

// Matches docker-compose.yml's `minio` service -- same credentials as
// test/minio-object-store.spec.ts, a separate bucket so the two suites' listings never mix.
process.env['MINIO_ENDPOINT'] = 'localhost';
process.env['MINIO_PORT'] = '9000';
process.env['MINIO_USE_SSL'] = 'false';
process.env['MINIO_ACCESS_KEY'] = 'hpoc';
process.env['MINIO_SECRET_KEY'] = 'hpoc12345';
process.env['MINIO_BUCKET'] = 'hpoc-agent-store-test';

const { MinioObjectStore } = await import('../src/adapters/storage/minio.object-store.js');
const { ObjectStoreAgentStore } = await import(
  '../src/adapters/framework/deep-agents/object-store-agent-store.js'
);

describe('ObjectStoreAgentStore against a real MinIO (docker-compose up -d minio)', () => {
  let store: InstanceType<typeof ObjectStoreAgentStore>;
  const orgId = `org-${randomUUID()}`;

  beforeAll(async () => {
    store = new ObjectStoreAgentStore(new MinioObjectStore());
    await store.put([orgId, 'healthcheck'], 'ok', { ok: true }).catch((err: Error) => {
      throw new Error(
        `MinIO unreachable at ${process.env['MINIO_ENDPOINT']}:${process.env['MINIO_PORT']} -- ` +
          `run \`npm run minio:up\` first. Original error: ${err.message}`,
      );
    });
  });

  it('round-trips a value through the public put/get API, which routes through batch()', async () => {
    const namespace = [orgId, 'workspace', randomUUID()];

    await store.put(namespace, '/notes.md', { content: '# hello from a real run' });
    const item = await store.get(namespace, '/notes.md');

    expect(item?.value).toEqual({ content: '# hello from a real run' });
    expect(item?.namespace).toEqual(namespace);
    expect(item?.key).toBe('/notes.md');
  });

  it('lists items under a namespace via the public search API', async () => {
    const namespace = [orgId, 'workspace', randomUUID()];
    await store.put(namespace, '/a.txt', { content: 'a' });
    await store.put(namespace, '/nested/b.txt', { content: 'b' });

    const found = await store.search(namespace);

    expect(new Set(found.map((i) => i.key))).toEqual(new Set(['/a.txt', '/nested/b.txt']));
  });

  it('deletes through the public delete API', async () => {
    const namespace = [orgId, 'workspace', randomUUID()];
    await store.put(namespace, '/gone.txt', { content: 'temporary' });

    await store.delete(namespace, '/gone.txt');

    expect(await store.get(namespace, '/gone.txt')).toBeNull();
  });

  it('keeps two namespaces (simulating two different threads) from seeing each other', async () => {
    const threadA = [orgId, 'workspace', 'thread-a'];
    const threadB = [orgId, 'workspace', 'thread-b'];
    await store.put(threadA, '/secret.txt', { content: 'thread A only' });

    expect(await store.get(threadB, '/secret.txt')).toBeNull();
    expect((await store.search(threadB)).map((i) => i.key)).not.toContain('/secret.txt');
  });
});
