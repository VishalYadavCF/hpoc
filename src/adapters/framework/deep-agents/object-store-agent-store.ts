import { Inject, Injectable, Logger } from '@nestjs/common';
import { BaseStore } from '@langchain/langgraph-checkpoint';
import type {
  GetOperation,
  Item,
  ListNamespacesOperation,
  Operation,
  OperationResults,
  PutOperation,
  SearchItem,
  SearchOperation,
} from '@langchain/langgraph-checkpoint';
import { OBJECT_STORE, type ObjectStore } from '../../../domain/ports/object-store.port.js';
import { PlatformError } from '../../../domain/errors/platform.errors.js';

interface StoredRecord {
  value: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * LangGraph's `BaseStore`, backed by the platform's `ObjectStore` port (MinIO in any real
 * deployment, the filesystem adapter locally) rather than a second, parallel object-storage
 * client. `deepagents`' own `StoreBackend` sits on top of this and is what actually
 * implements the agent's virtual filesystem; this class only answers get/put/search/
 * listNamespaces.
 *
 * ## Why `batch()` is the only method implemented
 *
 * `BaseStore.get`/`search`/`put`/`delete`/`listNamespaces` are concrete on the base class
 * and route through `batch()` already -- the same shape as `PostgresCheckpointSaver`
 * implementing exactly the five methods LangGraph's checkpoint contract needs and no more.
 *
 * ## Tenancy
 *
 * Unlike the checkpointer, there is no ambient context to fall back to: `Operation` carries only
 * `namespace`/`key`/`value`, nothing graph-reachable a framework could tamper with, because
 * the namespace is fixed once at construction by `DeepAgentsAdapter` and never touched again.
 * What IS enforced here is cheaper but still load-bearing: `namespace[0]` (or
 * `namespacePrefix[0]`) must be non-empty, so a caller that ever assembles a namespace array
 * wrong fails loudly instead of writing into an untenanted prefix every org's keys would
 * then share.
 *
 * ## Key scheme
 *
 * `namespace` segments and `key` are each `encodeURIComponent`-ed before being joined with
 * `/`. That is what makes a literal `/` inside a key (or a namespace segment) impossible to
 * confuse with a namespace boundary when a prefix listing is later split back apart --
 * `MinioObjectStore.keyFrom`'s bucket-boundary guard is the same idea one level up.
 */
@Injectable()
export class ObjectStoreAgentStore extends BaseStore {
  private readonly log = new Logger(ObjectStoreAgentStore.name);

  constructor(@Inject(OBJECT_STORE) private readonly objectStore: ObjectStore) {
    super();
  }

  /**
   * Sequential, in array order -- not `Promise.all`. A batch mixing a put and a get on the
   * same key is a normal thing for a caller to send (write a file, then confirm it), and
   * running them concurrently would make which one lands first a race. There is no
   * documented ordering contract on `BaseStore.batch`; the reference `InMemoryStore` (this
   * package's own) resolves the race in its own way -- gets against the state before the
   * batch, puts applied after -- but that is an artifact of its embedding-batch strategy,
   * not an invariant callers rely on. Read-your-writes within one call is the more useful,
   * race-free answer for a caller that has no such strategy to optimise around.
   */
  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results: unknown[] = [];
    for (const op of operations) results.push(await this.execute(op));
    return results as OperationResults<Op>;
  }

  private execute(
    op: Operation,
  ): Promise<Item | null | void | SearchItem[] | string[][]> {
    if ('namespacePrefix' in op) return this.searchItems(op);
    if ('value' in op) return this.putOne(op);
    if ('key' in op) return this.getOne(op);
    return this.listNamespacesUnder(op);
  }

  private async getOne(op: GetOperation): Promise<Item | null> {
    requireTenantSegment(op.namespace);
    const objectKey = keyFor(op.namespace, op.key);
    const hit = (await this.objectStore.list(objectKey)).find((m) => m.key === objectKey);
    if (!hit) return null;
    const record = await this.readRecord(hit.uri);
    return itemFrom(op.namespace, op.key, record);
  }

  private async putOne(op: PutOperation): Promise<void> {
    requireTenantSegment(op.namespace);
    const objectKey = keyFor(op.namespace, op.key);

    if (op.value === null) {
      const hit = (await this.objectStore.list(objectKey)).find((m) => m.key === objectKey);
      if (hit) await this.objectStore.delete(hit.uri);
      return;
    }

    // Preserves createdAt across an update: StoreBackend surfaces both timestamps to the
    // agent as a file's created/modified time, and an edit is not a new file.
    const existing = await this.getOne({ namespace: op.namespace, key: op.key });
    const now = new Date().toISOString();
    const record: StoredRecord = {
      value: op.value,
      createdAt: existing?.createdAt.toISOString() ?? now,
      updatedAt: now,
    };
    await this.objectStore.put(objectKey, Buffer.from(JSON.stringify(record)), 'application/json');
  }

  /**
   * Filters before it paginates, not after: `list()`'s prefix match is a raw string
   * comparison, so anything else sharing this prefix -- another writer's key that happens
   * to start the same way -- shows up in `hits` too. A foreign, non-JSON entry there is
   * skipped rather than allowed to fail the whole page; slicing first would also make
   * `limit` return fewer real items than exist whenever a skipped entry lands inside the
   * requested window.
   */
  private async searchItems(op: SearchOperation): Promise<SearchItem[]> {
    requireTenantSegment(op.namespacePrefix);
    // A trailing empty segment keys the object-store prefix on the namespace boundary
    // itself, not merely a string that happens to start the same way.
    const prefix = keyFor(op.namespacePrefix, '');
    const hits = await this.objectStore.list(prefix);
    const offset = op.offset ?? 0;
    const limit = op.limit ?? 10;

    const items = await Promise.all(
      hits.map(async (hit) => {
        const { namespace, key } = parseKey(hit.key);
        try {
          return itemFrom(namespace, key, await this.readRecord(hit.uri));
        } catch (err) {
          this.log.warn(`skipping ${hit.key}: not one of this store's own records (${(err as Error).message})`);
          return null;
        }
      }),
    );
    return items.filter((item): item is SearchItem => item !== null).slice(offset, offset + limit);
  }

  /**
   * Best-effort and deliberately narrow: an unscoped listing would have to walk every
   * tenant's keys to answer, which is a cross-tenant existence leak this class refuses to
   * become a way to perform. A caller that knows which namespace it wants supplies a
   * `prefix` match condition; one that does not gets a refusal, not a slow, leaky scan.
   */
  private async listNamespacesUnder(op: ListNamespacesOperation): Promise<string[][]> {
    const prefixCondition = op.matchConditions?.find((c) => c.matchType === 'prefix');
    if (!prefixCondition) {
      throw new PlatformError(
        'internal',
        'ObjectStoreAgentStore.listNamespaces requires a prefix matchCondition; an unscoped ' +
          'listing would have to walk every tenant to answer',
      );
    }
    requireTenantSegment(prefixCondition.path as string[]);
    const prefix = keyFor(prefixCondition.path as string[], '');
    const hits = await this.objectStore.list(prefix);

    const namespaces = new Set<string>();
    for (const hit of hits) {
      let { namespace } = parseKey(hit.key);
      if (op.maxDepth) namespace = namespace.slice(0, op.maxDepth);
      namespaces.add(JSON.stringify(namespace));
    }
    const offset = op.offset ?? 0;
    return [...namespaces]
      .map((n) => JSON.parse(n) as string[])
      .slice(offset, offset + op.limit);
  }

  private async readRecord(uri: string): Promise<StoredRecord> {
    return JSON.parse((await this.objectStore.get(uri)).toString('utf8')) as StoredRecord;
  }
}

function itemFrom(namespace: string[], key: string, record: StoredRecord): Item {
  return {
    value: record.value,
    key,
    namespace,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function keyFor(namespace: string[], key: string): string {
  return [...namespace, key].map(encodeURIComponent).join('/');
}

function parseKey(objectKey: string): { namespace: string[]; key: string } {
  const parts = objectKey.split('/').map(decodeURIComponent);
  return { namespace: parts.slice(0, -1), key: parts[parts.length - 1]! };
}

function requireTenantSegment(namespace: string[]): void {
  if (!namespace[0]) {
    throw new PlatformError(
      'internal',
      'ObjectStoreAgentStore requires a non-empty tenant segment as namespace[0]; an ' +
        'untenanted key would collide across orgs',
    );
  }
}
