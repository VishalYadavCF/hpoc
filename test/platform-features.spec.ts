import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './fixtures.js';
import { ContextEngine } from '../src/domain/context/context.engine.js';
import { InMemoryResponseCache } from '../src/adapters/cache/in-memory.response-cache.js';
import type { RecalledMemory } from '../src/domain/ports/framework-adapter.port.js';

const API = 'http://localhost:3000';
const H = { 'content-type': 'application/json', 'x-caller-subject': 'svc:demo-client',
            'x-namespace': 'demo', 'x-tenant-ref': 'merchant-1' };
const post = (p: string, b?: unknown, extra: Record<string, string> = {}) =>
  fetch(API + p, { method: 'POST', headers: { ...H, ...extra }, body: JSON.stringify(b ?? {}) });
const get = (p: string) => fetch(API + p, { headers: H });

let f: Fixture;
beforeAll(async () => {
  f = await fixture();
  if (!(await fetch(`${API}/healthz`).catch(() => null))?.ok) throw new Error('api must be running');
});
afterAll(async () => f.close());

const mem = (content: string, score: number, trusted = true): RecalledMemory =>
  ({ tier: 'semantic', content, provenance: 'user_input', trusted, score });

describe('context engine (§7)', () => {
  const engine = new ContextEngine(null as never);

  it('passes context through untouched when it fits', async () => {
    const out = await engine.assemble([mem('short', 0.9)], { maxChars: 1_000, reserveForAnswer: 100 });
    expect(out.droppedCount).toBe(0);
    expect(out.compacted).toBe(false);
  });

  it('evicts the least relevant before compacting anything', async () => {
    // Losing the worst item completely beats blurring every item.
    const out = await engine.assemble(
      [mem('a'.repeat(200), 0.9), mem('b'.repeat(200), 0.1)],
      { maxChars: 260, reserveForAnswer: 0 },
    );
    expect(out.droppedCount).toBe(1);
    expect(out.compacted).toBe(false);
    expect(out.recalled[0]!.content).toMatch(/^a+$/);
  });

  it('prefers evicting hearsay over first-party at equal relevance (§6.4)', async () => {
    const out = await engine.assemble(
      [mem('untrusted'.repeat(30), 0.5, false), mem('trusted'.repeat(30), 0.5, true)],
      { maxChars: 220, reserveForAnswer: 0 },
    );
    expect(out.recalled).toHaveLength(1);
    expect(out.recalled[0]!.trusted).toBe(true);
  });

  it('reports what it dropped instead of shrinking silently', async () => {
    // §0.5: the harm of over-eager compaction is invisible without measurement.
    const out = await engine.assemble(
      [mem('x'.repeat(500), 0.9), mem('y'.repeat(500), 0.8)],
      { maxChars: 100, reserveForAnswer: 0 },
    );
    expect(out.droppedCount + (out.compacted ? 1 : 0)).toBeGreaterThan(0);
  });

  it('honours per-agent disabling of both mechanisms (§0.5)', async () => {
    const out = await engine.assemble(
      [mem('z'.repeat(500), 0.9)], { maxChars: 50, reserveForAnswer: 0 },
      { compaction: false, eviction: false },
    );
    // Nothing removed, nothing truncated: the agent said not to.
    expect(out.droppedCount).toBe(0);
    expect(out.compacted).toBe(false);
    expect(out.recalled[0]!.content).toHaveLength(500);
  });
});

describe('response cache (§10)', () => {
  it('serves a hit and counts it', async () => {
    const cache = new InMemoryResponseCache();
    await cache.set('k', { text: 'hi', inputTokens: 1, outputTokens: 2 }, 60);
    expect(await cache.get('k')).toEqual({ text: 'hi', inputTokens: 1, outputTokens: 2 });
    expect(await cache.get('missing')).toBeUndefined();
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('expires entries', async () => {
    const cache = new InMemoryResponseCache();
    await cache.set('k', { text: 'x', inputTokens: 0, outputTokens: 0 }, 0.001);
    await new Promise((r) => setTimeout(r, 20));
    expect(await cache.get('k')).toBeUndefined();
  });

  it('is off unless the agent declares determinism acceptable', async () => {
    // Two identical runs with caching OFF must each cost tokens; inferring cacheability
    // would silently make a conversational agent repeat itself.
    const body = { agent: { model: { ref: 'internal/echo' } }, input: 'cache probe A' };
    const a = (await (await post('/v1/runs', body)).json()) as { runId: string };
    const b = (await (await post('/v1/runs', body)).json()) as { runId: string };
    expect(b.runId).not.toBe(a.runId);
  });
});

describe('idempotency interceptor (§4.5)', () => {
  it('stands aside where the database already guarantees it', async () => {
    // Run creation is idempotent via a unique index, which survives restarts and works
    // across processes. Caching in front of it would replay the FIRST response including
    // its `reused: false`, hiding the accurate answer behind a weaker mechanism.
    const key = `idem-${Math.random().toString(36).slice(2)}`;
    const body = { agent: { model: { ref: 'internal/echo' } }, input: 'once' };
    const a = (await (await post('/v1/runs', body, { 'idempotency-key': key })).json()) as
      { runId: string; reused: boolean };
    const b = (await (await post('/v1/runs', body, { 'idempotency-key': key })).json()) as
      { runId: string; reused: boolean };

    expect(b.runId).toBe(a.runId);
    expect(a.reused).toBe(false);
    expect(b.reused).toBe(true);
  });

  it('replays a cached response for a handler with no durable guarantee', async () => {
    const key = `feedback-${Math.random().toString(36).slice(2)}`;
    const created = (await (
      await post('/v1/runs', { agent: { model: { ref: 'internal/echo' } }, input: 'fb' })
    ).json()) as { runId: string };

    const body = { runId: created.runId, rating: 1, label: 'task_success' };
    const a = (await (await post('/v1/feedback', body, { 'idempotency-key': key })).json()) as { id: string };
    const b = (await (await post('/v1/feedback', body, { 'idempotency-key': key })).json()) as { id: string };
    // Same key, same response -- without it a retried submission would double-count.
    expect(b.id).toBe(a.id);
  });

  it('keys the cache by tenant as well as by the key itself', async () => {
    const key = `shared-${Math.random().toString(36).slice(2)}`;
    const run = (await (
      await post('/v1/runs', { agent: { model: { ref: 'internal/echo' } }, input: 'scoped' })
    ).json()) as { runId: string };

    const mine = (await (
      await post('/v1/feedback', { runId: run.runId, rating: 1 }, { 'idempotency-key': key })
    ).json()) as { id: string };

    // Two tenants choosing the same idempotency key must not read each other's response.
    const theirs = await fetch(`${API}/v1/feedback`, {
      method: 'POST',
      headers: { ...H, 'x-tenant-ref': 'merchant-2', 'idempotency-key': key },
      body: JSON.stringify({ runId: run.runId, rating: 1 }),
    });
    expect(theirs.status).toBe(404);
    expect(mine.id).toBeTruthy();
  });
});

describe('ops surface (§0.8, §15.4)', () => {
  it('exposes queue depth, leases, and stalled-reclaimer signals by pool', async () => {
    const body = (await (await get('/v1/ops/queue')).json()) as {
      maxAttempts: number;
      queues: {
        pool: string;
        depth: number;
        delayed: number;
        leased: number;
        oldestUnclaimedAt: string | null;
        expiredLeases: number;
        exhausted: number;
      }[];
    };
    expect(body.maxAttempts).toBeGreaterThan(0);
    expect(Array.isArray(body.queues)).toBe(true);
    for (const queue of body.queues) {
      expect(queue.depth).toBeGreaterThanOrEqual(0);
      expect(queue.leased).toBeGreaterThanOrEqual(0);
      expect(queue.expiredLeases).toBeGreaterThanOrEqual(0);
    }
  });

  it('exposes dead letters with their failure history', async () => {
    const body = (await (await get('/v1/ops/dead-letters')).json()) as {
      deadLetters: { run_id: string; reason: string; attempts: number }[];
    };
    expect(Array.isArray(body.deadLetters)).toBe(true);
  });

  it('serves Prometheus histograms with bounded label cardinality', async () => {
    // Generate the traffic first: a route only appears once it has been hit, so asserting
    // on a label without producing it tests the test order, not the labelling.
    const created = (await (
      await post('/v1/runs', { agent: { model: { ref: 'internal/echo' } }, input: 'label probe' })
    ).json()) as { runId: string };
    await get(`/v1/runs/${created.runId}`);

    const text = await (await fetch(`${API}/metrics`)).text();
    expect(text).toMatch(/# TYPE http_request_duration_ms histogram/);
    expect(text).toMatch(/http_request_duration_ms_bucket\{[^}]*le="\+Inf"\}/);
    // The route TEMPLATE, never a concrete id: per-id labels are unbounded cardinality
    // and the fastest way to take a Prometheus server down.
    expect(text).toMatch(/route="\/v1\/runs\/:id"/);
    expect(text).not.toMatch(/route="\/v1\/runs\/[0-9a-f]{8}-/);
  });

  it('serves the self-hosted console', async () => {
    const res = await fetch(`${API}/ui`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });
});
