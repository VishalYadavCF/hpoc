import type { BaseStore, Item, Operation, OperationResults } from '@langchain/langgraph-checkpoint';

class FakeInnerStore {
  readonly items = new Map<string, Item>();
  readonly batchCalls: Operation[][] = [];

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    this.batchCalls.push(operations);
    const results: unknown[] = [];
    for (const op of operations) {
      const ns = (op as { namespace?: string[] }).namespace ?? [];
      const k = [...ns, (op as { key?: string }).key].join('/');
      if ('value' in op) {
        results.push(undefined);
      } else if ('key' in op) {
        results.push(this.items.get(k) ?? null);
      } else {
        results.push([]);
      }
    }
    return results as OperationResults<Op>;
  }
}

const { ReadOnlyStore } = await import('./read-only.store.js');

describe('ReadOnlyStore', () => {
  let inner: FakeInnerStore;
  let store: InstanceType<typeof ReadOnlyStore>;

  beforeEach(() => {
    inner = new FakeInnerStore();
    inner.items.set('org-1/skills//refund/SKILL.md', {
      value: { content: 'STEP ONE' },
      key: '/refund/SKILL.md',
      namespace: ['org-1', 'skills'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    store = new ReadOnlyStore(inner as unknown as BaseStore);
  });

  it('still allows a get to pass through', async () => {
    const item = await store.get(['org-1', 'skills'], '/refund/SKILL.md');
    expect(item?.value['content']).toBe('STEP ONE');
  });

  it('still allows a search to pass through', async () => {
    await expect(store.search(['org-1', 'skills'])).resolves.toBeDefined();
  });

  it('refuses a put, rather than silently succeeding or silently doing nothing', async () => {
    await expect(
      store.put(['org-1', 'skills'], '/refund/SKILL.md', { content: 'REWRITTEN' }),
    ).rejects.toThrow(/read-only/i);
  });

  it('refuses a delete', async () => {
    await expect(store.delete(['org-1', 'skills'], '/refund/SKILL.md')).rejects.toThrow(/read-only/i);
  });

  it('never reaches the inner store for a refused write', async () => {
    await store.put(['org-1', 'skills'], '/refund/SKILL.md', { content: 'x' }).catch(() => {});
    expect(inner.batchCalls).toHaveLength(0);
  });

  it('refuses a batch that MIXES a legitimate read with a write, rather than applying the read', async () => {
    await expect(
      store.batch([
        { namespace: ['org-1', 'skills'], key: '/refund/SKILL.md' },
        { namespace: ['org-1', 'skills'], key: '/refund/SKILL.md', value: { content: 'x' } },
      ]),
    ).rejects.toThrow(/read-only/i);
  });
});
