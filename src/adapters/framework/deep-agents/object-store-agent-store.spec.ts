import type { ObjectStore, StoredObject } from '../../../domain/ports/object-store.port.js';
import type { GetOperation, ListNamespacesOperation, PutOperation, SearchOperation } from '@langchain/langgraph-checkpoint';

/**
 * A real, deterministic ObjectStore rather than a call-by-call mock -- what this class
 * does is translate BaseStore operations into ObjectStore calls, so the thing worth
 * asserting on is round-trip behaviour, not which methods got called in which order.
 */
class FakeObjectStore implements ObjectStore {
  readonly id = 'fake';
  private readonly bytes = new Map<string, Buffer>();

  async put(key: string, body: Buffer): Promise<StoredObject> {
    this.bytes.set(key, body);
    return { uri: `fake://${key}`, sizeBytes: body.byteLength, contentHash: 'n/a' };
  }

  async get(uri: string): Promise<Buffer> {
    const body = this.bytes.get(this.keyOf(uri));
    if (!body) throw new Error(`not found: ${uri}`);
    return body;
  }

  async stream(): Promise<never> {
    throw new Error('not used by ObjectStoreAgentStore');
  }

  async delete(uri: string): Promise<void> {
    this.bytes.delete(this.keyOf(uri));
  }

  async exists(uri: string): Promise<boolean> {
    return this.bytes.has(this.keyOf(uri));
  }

  async list(prefix: string): Promise<{ key: string; uri: string }[]> {
    return [...this.bytes.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key, uri: `fake://${key}` }));
  }

  private keyOf(uri: string): string {
    return uri.replace(/^fake:\/\//, '');
  }
}

const { ObjectStoreAgentStore } = await import('./object-store-agent-store.js');

describe('ObjectStoreAgentStore', () => {
  let objectStore: FakeObjectStore;
  let store: InstanceType<typeof ObjectStoreAgentStore>;

  beforeEach(() => {
    objectStore = new FakeObjectStore();
    store = new ObjectStoreAgentStore(objectStore);
  });

  const get = (namespace: string[], key: string): GetOperation => ({ namespace, key });
  const put = (namespace: string[], key: string, value: Record<string, unknown> | null): PutOperation => ({
    namespace,
    key,
    value,
  });
  const search = (namespacePrefix: string[], opts: Partial<SearchOperation> = {}): SearchOperation => ({
    namespacePrefix,
    ...opts,
  });

  describe('get', () => {
    it('returns null for a key that was never put', async () => {
      const [result] = await store.batch([get(['org-1', 'workspace'], '/a.txt')]);
      expect(result).toBeNull();
    });

    it('round-trips a value through put and get', async () => {
      await store.batch([put(['org-1', 'workspace'], '/a.txt', { content: 'hello' })]);

      const [item] = await store.batch([get(['org-1', 'workspace'], '/a.txt')]);

      expect(item).toMatchObject({
        value: { content: 'hello' },
        key: '/a.txt',
        namespace: ['org-1', 'workspace'],
      });
      expect(item!.createdAt).toBeInstanceOf(Date);
      expect(item!.updatedAt).toBeInstanceOf(Date);
    });

    it('keeps a key with a literal slash distinguishable from a deeper namespace', async () => {
      await store.batch([
        put(['org-1', 'workspace'], 'a/b.txt', { content: 'one' }),
        put(['org-1', 'workspace', 'a'], 'b.txt', { content: 'two' }),
      ]);

      const [flat, nested] = await store.batch([
        get(['org-1', 'workspace'], 'a/b.txt'),
        get(['org-1', 'workspace', 'a'], 'b.txt'),
      ]);

      expect(flat!.value).toEqual({ content: 'one' });
      expect(nested!.value).toEqual({ content: 'two' });
    });
  });

  describe('put', () => {
    it('deletes the item when value is null', async () => {
      await store.batch([put(['org-1', 'workspace'], '/a.txt', { content: 'x' })]);

      await store.batch([put(['org-1', 'workspace'], '/a.txt', null)]);

      const [result] = await store.batch([get(['org-1', 'workspace'], '/a.txt')]);
      expect(result).toBeNull();
    });

    it('deleting a key that was never put is a harmless no-op', async () => {
      await expect(
        store.batch([put(['org-1', 'workspace'], '/never.txt', null)]),
      ).resolves.toBeDefined();
    });

    it('preserves createdAt across an update while advancing updatedAt', async () => {
      await store.batch([put(['org-1', 'workspace'], '/a.txt', { content: 'v1' })]);
      const [first] = await store.batch([get(['org-1', 'workspace'], '/a.txt')]);

      await new Promise((r) => setTimeout(r, 5));
      await store.batch([put(['org-1', 'workspace'], '/a.txt', { content: 'v2' })]);
      const [second] = await store.batch([get(['org-1', 'workspace'], '/a.txt')]);

      expect(second!.value).toEqual({ content: 'v2' });
      expect(second!.createdAt.getTime()).toBe(first!.createdAt.getTime());
      expect(second!.updatedAt.getTime()).toBeGreaterThan(first!.updatedAt.getTime());
    });
  });

  describe('tenancy guard', () => {
    it('refuses a get whose namespace has an empty tenant segment', async () => {
      await expect(store.batch([get(['', 'workspace'], '/a.txt')])).rejects.toThrow(/tenant/i);
    });

    it('refuses a put whose namespace has an empty tenant segment', async () => {
      await expect(
        store.batch([put(['', 'workspace'], '/a.txt', { content: 'x' })]),
      ).rejects.toThrow(/tenant/i);
    });

    it('refuses a search whose namespacePrefix has an empty tenant segment', async () => {
      await expect(store.batch([search([''])])).rejects.toThrow(/tenant/i);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await store.batch([
        put(['org-1', 'workspace'], '/a.txt', { content: 'a' }),
        put(['org-1', 'workspace'], '/b.txt', { content: 'b' }),
        put(['org-1', 'other'], '/c.txt', { content: 'c' }),
      ]);
    });

    it('returns only items under the namespace prefix', async () => {
      const [items] = await store.batch([search(['org-1', 'workspace'])]);

      expect(items).toHaveLength(2);
      expect(new Set(items!.map((i) => i.key))).toEqual(new Set(['/a.txt', '/b.txt']));
      for (const item of items!) expect(item.namespace).toEqual(['org-1', 'workspace']);
    });

    it('respects limit and offset', async () => {
      const [page1] = await store.batch([search(['org-1', 'workspace'], { limit: 1, offset: 0 })]);
      const [page2] = await store.batch([search(['org-1', 'workspace'], { limit: 1, offset: 1 })]);

      expect(page1).toHaveLength(1);
      expect(page2).toHaveLength(1);
      expect(page1![0]!.key).not.toBe(page2![0]!.key);
    });

    it('does not leak another namespace into the results', async () => {
      const [items] = await store.batch([search(['org-1', 'workspace'])]);
      expect(items!.some((i) => i.key === '/c.txt')).toBe(false);
    });

    /**
     * A real collision, not a hypothetical one: SkillService's raw skill upload and
     * ObjectStoreAgentStore's own JSON-record namespace shared a prefix until this was
     * caught by an actual test crashing on it. A foreign object under a scanned prefix
     * must not take down search() for entries that ARE its own; it should be skipped.
     */
    it('skips a foreign, non-JSON entry under the same prefix rather than failing the whole search', async () => {
      await objectStore.put('org-1/workspace/not-ours.bin', Buffer.from('---\nnot json'));

      const [items] = await store.batch([search(['org-1', 'workspace'])]);

      expect(new Set(items!.map((i) => i.key))).toEqual(new Set(['/a.txt', '/b.txt']));
    });
  });

  describe('listNamespaces', () => {
    it('refuses an unscoped listing rather than walking every tenant', async () => {
      const op: ListNamespacesOperation = { limit: 10, offset: 0 };
      await expect(store.batch([op])).rejects.toThrow(/prefix/i);
    });

    it('lists namespaces under an explicit prefix condition', async () => {
      await store.batch([
        put(['org-1', 'workspace'], '/a.txt', { content: 'a' }),
        put(['org-1', 'skills'], '/refund/SKILL.md', { content: 's' }),
      ]);

      const op: ListNamespacesOperation = {
        matchConditions: [{ matchType: 'prefix', path: ['org-1'] }],
        limit: 10,
        offset: 0,
      };
      const [namespaces] = await store.batch([op]);

      expect(namespaces).toEqual(
        expect.arrayContaining([['org-1', 'workspace'], ['org-1', 'skills']]),
      );
    });
  });

  describe('batch', () => {
    it('runs heterogeneous operations and returns results in the same order', async () => {
      const [putResult, getResult, searchResult] = await store.batch([
        put(['org-1', 'workspace'], '/a.txt', { content: 'a' }),
        get(['org-1', 'workspace'], '/a.txt'),
        search(['org-1', 'workspace']),
      ]);

      expect(putResult).toBeUndefined();
      expect((getResult as { value: unknown } | null)?.value).toEqual({ content: 'a' });
      expect(Array.isArray(searchResult)).toBe(true);
    });
  });
});
