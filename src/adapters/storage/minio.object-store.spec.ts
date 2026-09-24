import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const bucketExists = vi.fn();
const makeBucket = vi.fn();
const putObject = vi.fn();
const getObject = vi.fn();
const removeObject = vi.fn();
const statObject = vi.fn();
const listObjectsV2 = vi.fn();

vi.mock('minio', () => ({
  Client: vi.fn().mockImplementation(function (this: object) {
    return Object.assign(this, {
      bucketExists,
      makeBucket,
      putObject,
      getObject,
      removeObject,
      statObject,
      listObjectsV2,
    });
  }),
}));

const { MinioObjectStore } = await import('./minio.object-store.js');

const streamOf = (bytes: Buffer): Readable => Readable.from([bytes]);

describe('MinioObjectStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['MINIO_BUCKET'] = 'test-bucket';
  });

  describe('put', () => {
    it('uploads the bytes and returns an s3 uri with a matching content hash', async () => {
      bucketExists.mockResolvedValue(true);
      const store = new MinioObjectStore();
      const body = Buffer.from('hello minio');

      const result = await store.put('org/key-1', body, 'text/plain');

      expect(putObject).toHaveBeenCalledWith(
        'test-bucket',
        'org/key-1',
        body,
        body.byteLength,
        { 'Content-Type': 'text/plain' },
      );
      expect(result.uri).toBe('s3://test-bucket/org/key-1');
      expect(result.sizeBytes).toBe(body.byteLength);
      expect(result.contentHash).toBe(
        createHash('sha256').update(body).digest('hex'),
      );
    });

    it('creates the bucket when it does not exist yet', async () => {
      bucketExists.mockResolvedValue(false);
      const store = new MinioObjectStore();

      await store.put('k', Buffer.from('x'), 'text/plain');

      expect(makeBucket).toHaveBeenCalledWith('test-bucket');
    });

    it('does not recreate a bucket that already exists', async () => {
      bucketExists.mockResolvedValue(true);
      const store = new MinioObjectStore();

      await store.put('k', Buffer.from('x'), 'text/plain');

      expect(makeBucket).not.toHaveBeenCalled();
    });

    it('checks bucket existence only once across multiple puts', async () => {
      bucketExists.mockResolvedValue(true);
      const store = new MinioObjectStore();

      await store.put('k1', Buffer.from('x'), 'text/plain');
      await store.put('k2', Buffer.from('y'), 'text/plain');

      expect(bucketExists).toHaveBeenCalledTimes(1);
    });
  });

  describe('get', () => {
    it('buffers the object stream into the exact original bytes', async () => {
      const body = Buffer.from('round trip me');
      getObject.mockResolvedValue(streamOf(body));
      const store = new MinioObjectStore();

      const result = await store.get('s3://test-bucket/org/key-1');

      expect(getObject).toHaveBeenCalledWith('test-bucket', 'org/key-1');
      expect(result).toEqual(body);
    });

    it('refuses a uri naming a different bucket', async () => {
      const store = new MinioObjectStore();

      await expect(store.get('s3://someone-elses-bucket/k')).rejects.toThrow(
        /bucket/i,
      );
      expect(getObject).not.toHaveBeenCalled();
    });
  });

  describe('stream', () => {
    it('returns the raw object stream without buffering', async () => {
      const raw = streamOf(Buffer.from('streamed'));
      getObject.mockResolvedValue(raw);
      const store = new MinioObjectStore();

      const result = await store.stream('s3://test-bucket/k');

      expect(result).toBe(raw);
    });
  });

  describe('delete', () => {
    it('removes the object at the given key', async () => {
      const store = new MinioObjectStore();

      await store.delete('s3://test-bucket/org/key-1');

      expect(removeObject).toHaveBeenCalledWith('test-bucket', 'org/key-1');
    });
  });

  describe('list', () => {
    it('returns every key under the prefix with a usable uri', async () => {
      listObjectsV2.mockReturnValue(
        Readable.from([{ name: 'workspace/a.txt' }, { name: 'workspace/b/c.txt' }], {
          objectMode: true,
        }),
      );
      const store = new MinioObjectStore();

      const result = await store.list('workspace/');

      expect(listObjectsV2).toHaveBeenCalledWith('test-bucket', 'workspace/', true);
      expect(result).toEqual([
        { key: 'workspace/a.txt', uri: 's3://test-bucket/workspace/a.txt' },
        { key: 'workspace/b/c.txt', uri: 's3://test-bucket/workspace/b/c.txt' },
      ]);
    });

    it('returns an empty list for a prefix with nothing under it', async () => {
      listObjectsV2.mockReturnValue(Readable.from([], { objectMode: true }));
      const store = new MinioObjectStore();

      expect(await store.list('nothing-here/')).toEqual([]);
    });

    it('propagates a stream error rather than resolving with partial results', async () => {
      bucketExists.mockResolvedValue(true);
      const stream = new Readable({ objectMode: true, read() {} });
      listObjectsV2.mockReturnValue(stream);
      const store = new MinioObjectStore();

      const pending = store.list('workspace/');
      // `ensureBucket()` awaits a mocked promise first, so the listener attaches on a
      // later microtask than this call -- emitting synchronously would race it.
      await new Promise((r) => setImmediate(r));
      stream.emit('error', new Error('connection reset'));

      await expect(pending).rejects.toThrow('connection reset');
    });
  });

  describe('exists', () => {
    it('returns true when statObject resolves', async () => {
      statObject.mockResolvedValue({ size: 3 });
      const store = new MinioObjectStore();

      expect(await store.exists('s3://test-bucket/k')).toBe(true);
    });

    it('returns false when statObject reports NotFound', async () => {
      statObject.mockRejectedValue(
        Object.assign(new Error('not found'), { code: 'NotFound' }),
      );
      const store = new MinioObjectStore();

      expect(await store.exists('s3://test-bucket/k')).toBe(false);
    });

    it('rethrows an error that is not a NotFound', async () => {
      statObject.mockRejectedValue(
        Object.assign(new Error('access denied'), { code: 'AccessDenied' }),
      );
      const store = new MinioObjectStore();

      await expect(store.exists('s3://test-bucket/k')).rejects.toThrow(
        'access denied',
      );
    });
  });
});
