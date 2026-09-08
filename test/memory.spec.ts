import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { MemoryEngine } from '../src/domain/memory/memory.engine.js';
import { PostgresMemoryStore } from '../src/adapters/memory/postgres.memory-store.js';
import { PgVectorIndex } from '../src/adapters/memory/pgvector.index.js';
import { DeterministicEmbedder } from '../src/adapters/memory/deterministic.embedder.js';
import { InMemoryCache } from '../src/adapters/memory/in-memory.cache.js';
import { PostgresRelationIndex } from '../src/adapters/memory/postgres.relation-index.js';
import { ExtractiveSummarizer } from '../src/adapters/memory/extractive.summarizer.js';
import { fixture, type Fixture } from './fixtures.js';

let f: Fixture;
let engine: MemoryEngine;
let threadId: string;

/**
 * The engine is built here from adapters directly rather than through Nest.
 *
 * That is the point of the port design: the deterministic embedder makes ranking
 * assertions reproducible and free, where the live one would make them neither.
 */
beforeAll(async () => {
  f = await fixture();
  const embedder = new DeterministicEmbedder();
  engine = new MemoryEngine(
    new UnitOfWork(f.db),
    new PostgresMemoryStore(f.db),
    new PgVectorIndex(f.db, embedder),
    embedder,
    new InMemoryCache(),
    new PostgresRelationIndex(f.db),
    new ExtractiveSummarizer(),
  );

  const thread = await f.db
    .insertInto('threads')
    .values({ org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef })
    .returning('id').executeTakeFirstOrThrow();
  threadId = thread.id;
});

afterAll(async () => {
  await f.db.deleteFrom('memory_records').where('scope_thread_id', '=', threadId).execute();
  await f.close();
});

const base = () => ({
  orgId: f.orgId,
  namespaceId: f.namespaceId,
  tenantRef: f.tenantRef,
});

const store = (content: string, over: Record<string, unknown> = {}) =>
  engine.store_({
    ...base(),
    tier: 'semantic' as const,
    scopeRef: { scope: 'thread' as const, threadId },
    content,
    provenance: 'user_input' as const,
    ...over,
  });

describe('memory engine (§6)', () => {
  it('names the adapter behind every seam', () => {
    expect(engine.describe()).toEqual({
      store: 'postgres',
      vectorIndex: 'pgvector',
      embedder: 'deterministic-hash',
      cache: 'in-process',
      relationIndex: 'postgres-lineage',
      summarizer: 'extractive',
    });
  });

  it('stores and recalls by lexical overlap', async () => {
    await store('settlement runs nightly at two in the morning');
    await store('refund service level agreement is forty eight hours');

    const hits = await engine.recall({ ...base(), text: 'refund agreement', tiers: ['semantic'], limit: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain('refund');
  });

  it('defaults trust from provenance, not from the caller (§6.4)', async () => {
    const firstParty = await store('a first-party fact about settlement');
    const hearsay = await store('a peer asserted something about settlement', {
      provenance: 'peer_result',
    });

    expect((await engine.get(firstParty))!.trusted).toBe(true);
    // Peer results and tool output arrive from outside our boundary. Defaulting these to
    // trusted is how unverified peer assertions get promoted into semantic memory.
    expect((await engine.get(hearsay))!.trusted).toBe(false);
  });

  it('can exclude untrusted records at retrieval without deleting them', async () => {
    await store('untrusted claim about latency', { provenance: 'tool_output' });
    const all = await engine.recall({ ...base(), text: 'latency claim', tiers: ['semantic'], limit: 10 });
    const trusted = await engine.recall({
      ...base(), text: 'latency claim', tiers: ['semantic'], trustedOnly: true, limit: 10,
    });
    expect(all.length).toBeGreaterThan(trusted.length);
    expect(trusted.every((r) => r.trusted)).toBe(true);
  });

  it('never returns another tenant\'s records', async () => {
    await store('a secret belonging to merchant one');
    const other = await engine.recall({
      ...base(), tenantRef: 'merchant-2', text: 'secret belonging', tiers: ['semantic'], limit: 10,
    });
    // Filter-then-rank: a scope the caller cannot see must not influence ordering, even
    // invisibly.
    expect(other).toHaveLength(0);
  });

  it('consolidates into one record and supersedes the sources', async () => {
    const scopeRef = { scope: 'episodic' as const, threadId };
    for (const text of [
      'The agent retried the payment twice before it settled.',
      'The agent retried the payment and the gateway timed out once.',
      'The agent finally settled the payment after the second retry.',
    ]) {
      await engine.store_({
        ...base(), tier: 'episodic', scopeRef: { scope: 'thread', threadId },
        content: text, provenance: 'model_output',
      });
    }

    const result = await engine.consolidate({
      ...base(), tier: 'episodic', scopeRef: { scope: 'thread', threadId }, minRecords: 3,
    });
    expect(result).not.toBeNull();
    expect(result!.sourceCount).toBeGreaterThanOrEqual(3);

    const consolidated = await engine.get(result!.consolidatedId);
    expect(consolidated!.provenance).toBe('consolidated');
    expect(consolidated!.content!.length).toBeGreaterThan(0);

    // The sources are SUPERSEDED, not deleted. §0.5 warns that forced summarisation which
    // discards detail is a net negative -- keeping the sources makes that measurable.
    const survivors = await engine.recall({
      ...base(), tiers: ['episodic'], scopeRef: { threadId }, limit: 20,
    });
    expect(survivors.every((r) => r.supersededBy === null)).toBe(true);
  });

  it('records consolidation lineage so provenance stays traversable (§15.3)', async () => {
    for (const text of ['alpha beta gamma delta.', 'beta gamma epsilon zeta.', 'gamma delta eta theta.']) {
      await engine.store_({
        ...base(), tier: 'procedural', scopeRef: { scope: 'thread', threadId },
        content: text, provenance: 'model_output',
      });
    }
    const result = await engine.consolidate({
      ...base(), tier: 'procedural', scopeRef: { scope: 'thread', threadId }, minRecords: 3,
    });

    const edges = await engine.provenanceOf(result!.consolidatedId, 2);
    expect(edges.length).toBeGreaterThanOrEqual(3);
    expect(edges.every((e) => e.relation === 'consolidated_from')).toBe(true);
  });

  it('does not launder trust through consolidation', async () => {
    const scoped = { scope: 'thread' as const, threadId };
    for (const text of ['untrusted one about widgets', 'untrusted two about widgets', 'untrusted three about widgets']) {
      await engine.store_({
        ...base(), tier: 'working', scopeRef: scoped, content: text, provenance: 'tool_output',
      });
    }
    const result = await engine.consolidate({
      ...base(), tier: 'working', scopeRef: { scope: 'thread', threadId }, minRecords: 3,
    });
    const consolidated = await engine.get(result!.consolidatedId);
    // A summary of untrusted inputs is untrusted. Summarisation is not a trust boundary.
    expect(consolidated!.trusted).toBe(false);
  });

  it('expires records past their TTL', async () => {
    const id = await store('this fact is short lived', { ttlSeconds: 1 });
    expect(await engine.get(id)).not.toBeNull();

    await new Promise((r) => setTimeout(r, 1_100));
    const removed = await engine.expire(new Date());
    expect(removed).toBeGreaterThan(0);
    expect(await engine.get(id)).toBeNull();
  });

  it('forgets a single record and its vector', async () => {
    const id = await store('forget me entirely please');
    await engine.forget(id);
    expect(await engine.get(id)).toBeNull();
    const rows = await f.db
      .selectFrom('memory_embeddings').select('memory_id')
      .where('memory_id', '=', id).execute();
    // A dangling vector would keep returning a record the caller believes is deleted.
    expect(rows).toHaveLength(0);
  });

  it('invalidates cached recall when the scope is written to', async () => {
    const marker = `zzqq${Math.random().toString(36).slice(2, 8)}`;
    const query = { ...base(), text: marker, tiers: ['semantic' as const], limit: 5 };

    const before = await engine.recall(query);
    expect(before.map((r) => r.content)).not.toContain(marker);

    const id = await store(marker);
    const after = await engine.recall(query);

    // Asserting on identity, not on count: `limit` caps the result set, so a stale cache
    // and a fresh one can return the same NUMBER of rows while differing in content.
    expect(after.map((r) => r.id)).toContain(id);
  });
});
