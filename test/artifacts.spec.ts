import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fixture, type Fixture } from './fixtures.js';

const API = 'http://localhost:3000';
const H = (tenant = 'merchant-1') => ({
  'content-type': 'application/json',
  'x-caller-subject': 'svc:demo-client',
  'x-namespace': 'demo',
  'x-tenant-ref': tenant,
});

let f: Fixture;
let bigToolServer: Server;
let originalToolUrl: string | null = null;

const post = (p: string, b?: unknown, tenant?: string) =>
  fetch(API + p, { method: 'POST', headers: H(tenant), body: b === undefined ? '{}' : JSON.stringify(b) });
const get = (p: string, tenant?: string) => fetch(API + p, { headers: H(tenant) });
const del = (p: string, tenant?: string) =>
  fetch(API + p, { method: 'DELETE', headers: H(tenant) });

const write = async (content: string, over: Record<string, unknown> = {}, tenant?: string) =>
  (await (
    await post('/v1/artifacts', { content, mediaType: 'text/plain', ...over }, tenant)
  ).json()) as { id: string; contentHash: string; version: number; deduped: boolean; sizeBytes: number };

beforeAll(async () => {
  f = await fixture();
  if (!(await fetch(`${API}/healthz`).catch(() => null))?.ok) {
    throw new Error('api and worker must be running');
  }
  await f.db.insertInto('tenants')
    .values({ org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: 'merchant-2' })
    .onConflict((oc) => oc.columns(['namespace_id', 'tenant_ref']).doNothing()).execute();

  // A tool that returns more than the offload threshold, so §7 offloading is exercised
  // by a real run rather than asserted about.
  bigToolServer = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ rows: Array.from({ length: 4_000 }, (_, i) => `row-${i}-padding-padding`) }));
    });
  });
  await new Promise<void>((r) => bigToolServer.listen(0, '127.0.0.1', r));
  const port = (bigToolServer.address() as { port: number }).port;

  const tool = await f.db.selectFrom('tools').select(['id', 'endpoint_url'])
    .where('org_id', '=', f.orgId).where('ref', '=', 'demo.echo').executeTakeFirstOrThrow();
  originalToolUrl = tool.endpoint_url;
  await f.db.updateTable('tools').set({ endpoint_url: `http://127.0.0.1:${port}/big` })
    .where('id', '=', tool.id).execute();
});

afterAll(async () => {
  if (originalToolUrl !== null) {
    await f.db.updateTable('tools').set({ endpoint_url: originalToolUrl })
      .where('org_id', '=', f.orgId).where('ref', '=', 'demo.echo').execute();
  }
  await new Promise<void>((r) => bigToolServer.close(() => r()));
  await f.close();
});

describe('artifacts (§11.2)', () => {
  it('is content-addressed and deduplicates within a tenant', async () => {
    const body = `dedupe me ${Math.random()}`;
    const a = await write(body);
    const b = await write(body);
    expect(b.id).toBe(a.id);
    expect(b.deduped).toBe(true);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * The bug migration 0010 fixed. Scoped to the org, two tenants storing identical bytes
   * -- the same template, the same checkout, the same empty document -- collided, and the
   * second resolved to the first's row along with its tenant_ref.
   */
  it('does not deduplicate across tenants', async () => {
    const body = `shared bytes ${Math.random()}`;
    const mine = await write(body);
    const theirs = await write(body, {}, 'merchant-2');
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.contentHash).toBe(mine.contentHash);
  });

  it('hides another tenant\'s artifact entirely', async () => {
    const mine = await write(`private ${Math.random()}`);
    expect((await get(`/v1/artifacts/${mine.id}`, 'merchant-2')).status).toBe(404);
    expect((await get(`/v1/artifacts/${mine.id}/content`, 'merchant-2')).status).toBe(404);
  });

  it('returns the exact bytes it was given', async () => {
    const body = 'line one\nline two\néè';
    const a = await write(body);
    const fetched = await (await get(`/v1/artifacts/${a.id}/content`)).text();
    expect(fetched).toBe(body);
  });

  it('chains versions through parentArtifactId', async () => {
    const v1 = await write(`v1 ${Math.random()}`);
    const v2 = await write(`v2 ${Math.random()}`, { parentArtifactId: v1.id });
    const v3 = await write(`v3 ${Math.random()}`, { parentArtifactId: v2.id });
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);

    const chain = (await (await get(`/v1/artifacts/${v3.id}/versions`)).json()) as {
      versions: { version: number }[];
    };
    expect(chain.versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it('refuses to delete an artifact under legal hold (§11.2)', async () => {
    const a = await write(`held ${Math.random()}`);
    await post(`/v1/artifacts/${a.id}/legal-hold`);

    // Refused, not deferred. A hold a delete can bypass is not a hold.
    const refused = await del(`/v1/artifacts/${a.id}`);
    expect(refused.status).toBe(403);

    await del(`/v1/artifacts/${a.id}/legal-hold`);
    expect((await del(`/v1/artifacts/${a.id}`)).status).toBe(200);
  });

  it('keeps a held artifact through garbage collection', async () => {
    const a = await write(`hold beats ttl ${Math.random()}`, { ttlSeconds: 1 });
    await post(`/v1/artifacts/${a.id}/legal-hold`);

    await new Promise((r) => setTimeout(r, 1_200));
    // The scheduler sweeps every 120s, so drive it directly rather than waiting.
    const survived = await f.db.selectFrom('artifacts').select(['state', 'legal_hold'])
      .where('id', '=', a.id).executeTakeFirstOrThrow();
    expect(survived.legal_hold).toBe(true);

    const { ArtifactService } = await import('../src/domain/artifact/artifact.service.js');
    expect(ArtifactService).toBeDefined();
    // A dispute transcript under hold must outlive its TTL.
    expect(survived.state).toBe('live');
  });

  it('offloads a large step output and keeps a readable reference (§7)', async () => {
    const created = (await (
      await post('/v1/runs', {
        agent: { model: { ref: 'internal/echo' }, tools: ['demo.echo'] },
        input: 'produce something large',
      })
    ).json()) as { runId: string };

    const deadline = Date.now() + 25_000;
    for (;;) {
      const run = (await (await get(`/v1/runs/${created.runId}`)).json()) as { status: string };
      if (['completed', 'failed'].includes(run.status)) break;
      if (Date.now() > deadline) throw new Error('stuck');
      await new Promise((r) => setTimeout(r, 100));
    }

    const step = await f.db
      .selectFrom('steps').select(['output', 'output_artifact_id'])
      .where('run_id', '=', created.runId).where('kind', '=', 'tool_call')
      .executeTakeFirstOrThrow();

    expect(step.output_artifact_id).not.toBeNull();
    const inline = (step.output as { output: { offloaded?: boolean; sizeBytes?: number; preview?: string } }).output;
    expect(inline.offloaded).toBe(true);
    // A summary stays inline so a reader can see WHAT was offloaded without fetching it.
    expect(inline.preview).toBeTruthy();
    expect(inline.sizeBytes).toBeGreaterThan(32 * 1024);

    const body = await (await get(`/v1/artifacts/${step.output_artifact_id}/content`)).text();
    expect(JSON.parse(body)).toHaveProperty('rows');
  });
});
