import type { BaseStore, Item, Operation, OperationResults } from '@langchain/langgraph-checkpoint';
import type { RunHost } from '../../../domain/ports/framework-adapter.port.js';

type RecordArtifactInput = Parameters<RunHost['recordArtifact']>[0];

/** Minimal, deterministic BaseStore -- see object-store-agent-store.spec.ts for why. */
class FakeInnerStore {
  private readonly items = new Map<string, Item>();

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results: unknown[] = [];
    for (const op of operations) {
      const anyOp = op as { namespace?: string[]; namespacePrefix?: string[]; key?: string };
      const k = [...(anyOp.namespace ?? anyOp.namespacePrefix ?? []), anyOp.key].join('/');
      if ('value' in op) {
        if (op.value === null) this.items.delete(k);
        else this.items.set(k, { value: op.value, key: op.key, namespace: op.namespace, createdAt: new Date(), updatedAt: new Date() });
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

const { ArtifactRecordingStore } = await import('./artifact-recording.store.js');

describe('ArtifactRecordingStore', () => {
  let inner: FakeInnerStore;
  let writes: RecordArtifactInput[];
  let host: Pick<RunHost, 'recordArtifact'>;

  beforeEach(() => {
    inner = new FakeInnerStore();
    writes = [];
    host = {
      recordArtifact: async (input: RecordArtifactInput) => {
        writes.push(input);
      },
    };
  });

  const newStore = () => new ArtifactRecordingStore(inner as unknown as BaseStore, host);

  it('still performs the underlying write -- durability does not depend on the artifact succeeding', async () => {
    const store = newStore();

    await store.put(['org-1', 'workspace'], '/notes.md', {
      content: '# hello',
      created_at: '2026-01-01T00:00:00.000Z',
      modified_at: '2026-01-01T00:00:00.000Z',
    });

    const item = await store.get(['org-1', 'workspace'], '/notes.md');
    expect(item?.value['content']).toBe('# hello');
  });

  it('records a real write as an artifact, with the file body as bytes', async () => {
    const store = newStore();

    await store.put(['org-1', 'workspace'], '/notes.md', {
      content: '# hello',
      mimeType: 'text/markdown',
      created_at: '2026-01-01T00:00:00.000Z',
      modified_at: '2026-01-01T00:00:00.000Z',
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]!.body.toString('utf8')).toBe('# hello');
    expect(writes[0]!.mediaType).toBe('text/markdown');
  });

  it('tags the recorded artifact with the workspace path and namespace it came from', async () => {
    const store = newStore();

    await store.put(['org-1', 'workspace'], '/notes.md', {
      content: 'x',
      created_at: '2026-01-01T00:00:00.000Z',
      modified_at: '2026-01-01T00:00:00.000Z',
    });

    expect(writes[0]!.metadata).toMatchObject({
      workspacePath: '/notes.md',
      namespace: ['org-1', 'workspace'],
    });
  });

  it('joins array-of-lines content the same way the FileData v1 shape means it', async () => {
    const store = newStore();

    await store.put(['org-1', 'workspace'], '/lines.txt', {
      content: ['line one', 'line two'],
      created_at: '2026-01-01T00:00:00.000Z',
      modified_at: '2026-01-01T00:00:00.000Z',
    });

    expect(writes[0]!.body.toString('utf8')).toBe('line one\nline two');
  });

  it('does not record a delete as an artifact write', async () => {
    const store = newStore();
    await store.put(['org-1', 'workspace'], '/gone.txt', {
      content: 'x',
      created_at: '2026-01-01T00:00:00.000Z',
      modified_at: '2026-01-01T00:00:00.000Z',
    });
    writes.length = 0;

    await store.delete(['org-1', 'workspace'], '/gone.txt');

    expect(writes).toHaveLength(0);
  });

  it('does not record a get as an artifact write', async () => {
    const store = newStore();

    await store.get(['org-1', 'workspace'], '/never-written.txt');

    expect(writes).toHaveLength(0);
  });

  it('succeeds the underlying write even when artifact recording itself fails', async () => {
    host.recordArtifact = async () => {
      throw new Error('artifacts table unavailable');
    };
    const store = newStore();

    await expect(
      store.put(['org-1', 'workspace'], '/notes.md', {
        content: 'x',
        created_at: '2026-01-01T00:00:00.000Z',
        modified_at: '2026-01-01T00:00:00.000Z',
      }),
    ).resolves.toBeUndefined();
    const item = await store.get(['org-1', 'workspace'], '/notes.md');
    expect(item?.value['content']).toBe('x');
  });

  it('skips recording, without throwing, a value that is not file-shaped', async () => {
    const store = newStore();

    await store.put(['org-1', 'skills'], 'skill-version-id', { instructions: 'do the thing' });

    expect(writes).toHaveLength(0);
  });
});
