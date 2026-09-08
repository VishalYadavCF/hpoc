import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { KnowledgeService } from '../src/domain/knowledge/knowledge.service.js';
import { PgVectorKnowledgeIndex } from '../src/adapters/knowledge/pgvector.knowledge-index.js';
import { DeterministicEmbedder } from '../src/adapters/memory/deterministic.embedder.js';
import { chunk } from '../src/domain/knowledge/chunker.js';
import { fixture, type Fixture } from './fixtures.js';

let f: Fixture;
let knowledge: KnowledgeService;
let collectionId: string;

const NAME = `kb-test-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  f = await fixture();
  const embedder = new DeterministicEmbedder();
  knowledge = new KnowledgeService(
    f.db,
    new UnitOfWork(f.db),
    embedder,
    new PgVectorKnowledgeIndex(f.db, embedder),
  );
  const c = await knowledge.createCollection({
    orgId: f.orgId,
    namespaceId: f.namespaceId,
    name: NAME,
    createdBy: f.principalId,
  });
  collectionId = c.id;
});

afterAll(async () => {
  await f.db.deleteFrom('knowledge_collections').where('id', '=', collectionId).execute();
  await f.close();
});

describe('chunker', () => {
  it('is deterministic, which is what makes content_hash mean "already ingested"', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} about refunds.`).join('\n\n');
    expect(chunk(text)).toEqual(chunk(text));
  });

  it('overlaps chunks so a fact stated across a break belongs to both sides', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} of the manual.`).join('\n\n');
    const chunks = chunk(text, { maxChars: 300, overlapChars: 80 });
    expect(chunks.length).toBeGreaterThan(1);

    const tailOfFirst = chunks[0]!.content.slice(-40);
    // Not a substring check on the whole chunk: the overlap is snapped to a word
    // boundary, so it is a suffix of one and a prefix of the next, not an exact slice.
    const firstWordOfOverlap = tailOfFirst.trim().split(/\s+/)[0]!;
    expect(chunks[1]!.content).toContain(firstWordOfOverlap);
  });

  it('never emits a chunk larger than the budget', () => {
    const text = 'x'.repeat(5_000);
    for (const c of chunk(text, { maxChars: 400, overlapChars: 50 })) {
      expect(c.content.length).toBeLessThanOrEqual(400);
    }
  });
});

describe('knowledge ingestion', () => {
  it('indexes a document and retrieves it by meaning, not by substring', async () => {
    await knowledge.ingest({
      orgId: f.orgId,
      collectionId,
      title: 'Refund policy',
      body:
        'Refunds are issued to the original payment instrument within seven business days.\n\n' +
        'A refund cannot exceed the captured amount of the original transaction.',
    });

    const hits = await knowledge.search({ collectionIds: [collectionId], text: 'refund window' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain('Refunds');
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it('re-ingesting identical bytes is a no-op rather than a duplicated corpus', async () => {
    const body = 'Chargebacks are contested through the acquirer, never by issuing a refund.';
    const first = await knowledge.ingest({ orgId: f.orgId, collectionId, body });
    const second = await knowledge.ingest({ orgId: f.orgId, collectionId, body });

    expect(first.unchanged).toBe(false);
    expect(second.unchanged).toBe(true);
    expect(second.documentId).toBe(first.documentId);
  });

  it('re-chunking the same bytes is NOT unchanged, because the index differs', async () => {
    const body = Array.from({ length: 20 }, (_, i) => `Clause ${i} of the settlement terms.`).join('\n\n');
    const wide = await knowledge.ingest({ orgId: f.orgId, collectionId, body });
    const narrow = await knowledge.ingest({
      orgId: f.orgId,
      collectionId,
      body,
      chunking: { maxChars: 200, overlapChars: 20 },
    });
    expect(narrow.unchanged).toBe(false);
    expect(narrow.documentId).not.toBe(wide.documentId);
    expect(narrow.chunkCount).toBeGreaterThan(wide.chunkCount);
  });

  it('deleting a document removes its chunks, so a correction actually takes effect', async () => {
    const body = 'Settlement occurs on T+2 for domestic cards and T+5 for international cards.';
    const doc = await knowledge.ingest({ orgId: f.orgId, collectionId, body });

    const before = await f.db
      .selectFrom('knowledge_chunks')
      .select('id')
      .where('document_id', '=', doc.documentId)
      .execute();
    expect(before.length).toBeGreaterThan(0);

    await knowledge.deleteDocument(collectionId, doc.documentId);

    const after = await f.db
      .selectFrom('knowledge_chunks')
      .select('id')
      .where('document_id', '=', doc.documentId)
      .execute();
    expect(after).toHaveLength(0);
  });

  it('searching no collections returns nothing rather than everything', async () => {
    expect(await knowledge.search({ collectionIds: [], text: 'refund' })).toEqual([]);
  });

  it('a chunk cannot claim a collection its document does not belong to', async () => {
    const other = await knowledge.createCollection({
      orgId: f.orgId,
      namespaceId: f.namespaceId,
      name: `${NAME}-other`,
    });
    const doc = await knowledge.ingest({
      orgId: f.orgId,
      collectionId,
      body: 'Disputes older than 120 days are out of scope.',
    });

    // The composite FK is the control, not a service method someone can forget to call:
    // a corpus leaking across a boundary must be unwritable, not merely unwritten.
    await expect(
      f.db
        .updateTable('knowledge_chunks')
        .set({ collection_id: other.id })
        .where('document_id', '=', doc.documentId)
        .execute(),
    ).rejects.toThrow(/violates foreign key constraint/i);

    await f.db.deleteFrom('knowledge_collections').where('id', '=', other.id).execute();
  });
});
