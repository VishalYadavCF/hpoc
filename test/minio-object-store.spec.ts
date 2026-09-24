import { createHash, randomUUID } from 'node:crypto';

// Matches docker-compose.yml's `minio` service. Set before importing the module under
// test, since MinioObjectStore reads its client config from process.env at field-init
// time -- there is no setter, by design (§11.2: config is fixed at process start).
process.env['MINIO_ENDPOINT'] = 'localhost';
process.env['MINIO_PORT'] = '9000';
process.env['MINIO_USE_SSL'] = 'false';
process.env['MINIO_ACCESS_KEY'] = 'hpoc';
process.env['MINIO_SECRET_KEY'] = 'hpoc12345';
process.env['MINIO_BUCKET'] = 'hpoc-artifacts-test';

const { MinioObjectStore } =
  await import('../src/adapters/storage/minio.object-store.js');

const streamToBuffer = async (
  stream: NodeJS.ReadableStream,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

describe('MinioObjectStore against a real MinIO (docker-compose up -d minio)', () => {
  let store: InstanceType<typeof MinioObjectStore>;
  const written: string[] = [];

  beforeAll(async () => {
    store = new MinioObjectStore();
    await store
      .put('healthcheck', Buffer.from('ok'), 'text/plain')
      .catch((err: Error) => {
        throw new Error(
          `MinIO unreachable at ${process.env['MINIO_ENDPOINT']}:${process.env['MINIO_PORT']} -- ` +
            `run \`npm run minio:up\` first. Original error: ${err.message}`,
        );
      });
  });

  afterAll(async () => {
    await Promise.all(
      written.map((key) => store.delete(`s3://hpoc-artifacts-test/${key}`)),
    );
  });

  const put = async (body: Buffer, mediaType = 'application/octet-stream') => {
    const key = `it/${randomUUID()}`;
    written.push(key);
    return { key, result: await store.put(key, body, mediaType) };
  };

  it('round-trips exact bytes through put and get', async () => {
    const body = Buffer.from('line one\nline two\néè', 'utf8');
    const { key } = await put(body);

    const fetched = await store.get(`s3://hpoc-artifacts-test/${key}`);

    expect(fetched).toEqual(body);
  });

  it('round-trips binary content unmodified', async () => {
    const body = Buffer.from([0, 1, 2, 255, 254, 253, 128]);
    const { key } = await put(body);

    expect(await store.get(`s3://hpoc-artifacts-test/${key}`)).toEqual(body);
  });

  it('returns a uri and content hash matching the stored bytes', async () => {
    const body = Buffer.from(`hash me ${Math.random()}`);
    const { key, result } = await put(body);

    expect(result.uri).toBe(`s3://hpoc-artifacts-test/${key}`);
    expect(result.sizeBytes).toBe(body.byteLength);
    expect(result.contentHash).toBe(
      createHash('sha256').update(body).digest('hex'),
    );
  });

  it('streams the same bytes get() would buffer', async () => {
    const body = Buffer.from('streamed content '.repeat(1000));
    const { key } = await put(body);

    const stream = await store.stream(`s3://hpoc-artifacts-test/${key}`);

    expect(await streamToBuffer(stream)).toEqual(body);
  });

  it('reports existence correctly before and after a write', async () => {
    const key = `it/${randomUUID()}`;
    const uri = `s3://hpoc-artifacts-test/${key}`;
    expect(await store.exists(uri)).toBe(false);

    written.push(key);
    await store.put(key, Buffer.from('present'), 'text/plain');

    expect(await store.exists(uri)).toBe(true);
  });

  it('lists every key under a prefix, usable directly against get/delete', async () => {
    const prefix = `it/list-${randomUUID()}/`;
    const bodies = new Map([
      [`${prefix}a.txt`, Buffer.from('a')],
      [`${prefix}nested/b.txt`, Buffer.from('b')],
    ]);
    for (const [key, body] of bodies) {
      written.push(key);
      await store.put(key, body, 'text/plain');
    }

    const found = await store.list(prefix);

    expect(new Set(found.map((f) => f.key))).toEqual(new Set(bodies.keys()));
    for (const item of found) {
      expect(await store.get(item.uri)).toEqual(bodies.get(item.key));
    }
  });

  it('returns an empty list for a prefix nothing was ever written under', async () => {
    expect(await store.list(`it/never-used-${randomUUID()}/`)).toEqual([]);
  });

  it('deletes an object so it no longer exists nor can be read', async () => {
    const { key } = await put(Buffer.from('temporary'));
    const uri = `s3://hpoc-artifacts-test/${key}`;

    await store.delete(uri);

    expect(await store.exists(uri)).toBe(false);
    await expect(store.get(uri)).rejects.toThrow();
  });
});
