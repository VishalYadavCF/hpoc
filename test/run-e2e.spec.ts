import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { sql } from 'kysely';
import { fixture, type Fixture } from './fixtures.js';

const API = 'http://localhost:3000';
const HEADERS = {
  'content-type': 'application/json',
  'x-caller-subject': 'svc:demo-client',
  'x-namespace': 'demo',
  'x-tenant-ref': 'merchant-1',
};

let f: Fixture;
let toolTarget: Server;
let toolCalls = 0;
let originalToolUrl: string | null = null;

const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
  fetch(API + path, { method: 'POST', headers: { ...HEADERS, ...extra }, body: JSON.stringify(body) });
const get = (path: string, extra: Record<string, string> = {}) =>
  fetch(API + path, { headers: { ...HEADERS, ...extra } });

async function settle(runId: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = (await (await get(`/v1/runs/${runId}`)).json()) as Record<string, unknown>;
    if (['completed', 'failed', 'cancelled'].includes(run['status'] as string)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} stuck in ${String(run['status'])}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  f = await fixture();
  // The tool endpoint is a fixture, not a service: the run must reach a real socket for
  // the sandbox, the credential broker and the effect contract to be exercised at all.
  // Port 0: never collide with a tool target the developer already has running.
  toolTarget = createServer((req, res) => {
    toolCalls += 1;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ seenAuth: Boolean(req.headers.authorization), body }));
    });
  });
  await new Promise<void>((r) => toolTarget.listen(0, '127.0.0.1', r));
  const port = (toolTarget.address() as { port: number }).port;

  // Point the seeded tool at this fixture for the duration of the file. The binding is
  // read per run, so no restart is needed -- and it is restored in afterAll.
  const tool = await f.db
    .selectFrom('tools').select(['id', 'endpoint_url'])
    .where('org_id', '=', f.orgId).where('ref', '=', 'demo.echo')
    .executeTakeFirstOrThrow();
  originalToolUrl = tool.endpoint_url;
  await f.db
    .updateTable('tools')
    .set({ endpoint_url: `http://127.0.0.1:${port}/echo` })
    .where('id', '=', tool.id)
    .execute();

  const health = await fetch(`${API}/healthz`).catch(() => null);
  if (!health?.ok) throw new Error('api and worker must be running: npm run start:api / start:worker');
});

afterAll(async () => {
  if (originalToolUrl !== null) {
    await f.db
      .updateTable('tools').set({ endpoint_url: originalToolUrl })
      .where('org_id', '=', f.orgId).where('ref', '=', 'demo.echo').execute();
  }
  await new Promise<void>((r) => toolTarget.close(() => r()));
  await f.close();
});

describe('durable run, end to end', () => {
  it('executes a model-only run and records ordered events', async () => {
    const created = (await (
      await post('/v1/runs', { agent: { model: { ref: 'internal/echo' } }, input: 'hi' })
    ).json()) as { runId: string };

    const run = await settle(created.runId);
    expect(run['status']).toBe('completed');
    expect(run['stepCount']).toBe(1);

    const { events } = (await (await get(`/v1/runs/${created.runId}/events/history`)).json()) as {
      events: { seq: number; type: string }[];
    };
    expect(events.map((e) => e.type)).toEqual([
      'run.created', 'run.started', 'model.completed', 'run.completed',
    ]);
    // §4.5 promises total ordering per run, and the sequence is also the SSE cursor.
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('executes a tool call through the sandbox with a broker-minted credential', async () => {
    const before = toolCalls;
    // Unique input, because `demo.echo` is `cacheable`: an identical call from another
    // spec file would be served from the worker's tool-result cache and never reach the
    // fixture. That is correct behaviour (§10) and would make this assert the cache
    // rather than the sandbox.
    const created = (await (
      await post('/v1/runs', {
        agent: { model: { ref: 'internal/echo' }, tools: ['demo.echo'] },
        input: `use the tool ${Math.random().toString(36).slice(2)}`,
      })
    ).json()) as { runId: string };

    const run = await settle(created.runId);
    expect(run['status']).toBe('completed');
    expect(toolCalls).toBe(before + 1);

    const invocation = await f.db
      .selectFrom('tool_invocations')
      .select((eb) => [
        'status', 'credential_grant_id', 'sandbox_profile',
        sql<string[]>`effects::text[]`.as('effects'),
      ])
      .where('run_id', '=', created.runId)
      .executeTakeFirstOrThrow();
    expect(invocation.status).toBe('succeeded');
    // Array, not string. Without the ::text[] cast pg returns the literal '{read_only}',
    // on which toContain passes for the wrong reason -- which is exactly how the
    // effect-array bug survived the first version of this test.
    expect(Array.isArray(invocation.effects)).toBe(true);
    expect(invocation.effects).toContain('read_only');

    // §16.3: the mint is audited, and the audit stores the jti -- never the token.
    const grant = await f.db
      .selectFrom('credential_grants')
      .select(['audience', 'scopes', 'token_id'])
      .where('run_id', '=', created.runId)
      .executeTakeFirstOrThrow();
    expect(grant.scopes).toContain('tool:demo.echo');
  });

  it('writes a checkpoint at every step boundary at the strict tier (§4.3)', async () => {
    const created = (await (
      await post('/v1/runs', {
        agent: { model: { ref: 'internal/echo' }, tools: ['demo.echo'] },
        input: 'checkpoint me',
      })
    ).json()) as { runId: string };
    await settle(created.runId);

    const checkpoints = await f.db
      .selectFrom('checkpoints').select(['step_seq', 'schema_version'])
      .where('run_id', '=', created.runId).orderBy('step_seq').execute();
    expect(checkpoints.map((c) => c.step_seq)).toEqual([1, 2]);
    // §0.2 -- a resumed run must be readable by a newer binary than the one that wrote it.
    expect(checkpoints.every((c) => c.schema_version >= 1)).toBe(true);
  });

  it('attributes cost to org, namespace and tenant (§9)', async () => {
    const created = (await (
      await post('/v1/runs', { agent: { model: { ref: 'internal/echo' } }, input: 'bill me' })
    ).json()) as { runId: string };
    await settle(created.runId);

    const usage = await f.db
      .selectFrom('usage_ledger')
      .select(['tenant_ref', 'kind', 'input_tokens', 'output_tokens', 'cost_micros'])
      .where('run_id', '=', created.runId)
      .executeTakeFirstOrThrow();
    expect(usage.tenant_ref).toBe('merchant-1');
    expect(usage.kind).toBe('model_tokens');
    expect(Number(usage.output_tokens)).toBeGreaterThan(0);
  });

  it('treats a repeated Idempotency-Key as the same run (§4.5)', async () => {
    const key = `test-${Math.random().toString(36).slice(2)}`;
    const body = { agent: { model: { ref: 'internal/echo' } }, input: 'once only' };
    const a = (await (await post('/v1/runs', body, { 'idempotency-key': key })).json()) as Record<string, unknown>;
    const b = (await (await post('/v1/runs', body, { 'idempotency-key': key })).json()) as Record<string, unknown>;

    expect(b['runId']).toBe(a['runId']);
    expect(b['reused']).toBe(true);
  });

  it('rejects an ungranted spec with every reason, and creates no run', async () => {
    const before = await f.db
      .selectFrom('runs').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();

    const response = await post('/v1/runs', {
      agent: { model: { ref: 'ghost/model' }, tools: ['ghost.tool'] },
      input: 'x',
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { code: string; rejections: string[] };
    expect(body.code).toBe('admission_rejected');
    expect(body.rejections.join('\n')).toContain('ghost/model');
    expect(body.rejections.join('\n')).toContain('ghost.tool');

    const after = await f.db
      .selectFrom('runs').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));
  });

  it('refuses a tenant the caller holds no grant for, rather than returning nothing', async () => {
    // §16.2: silent narrowing is how a service returns records it was never entitled to.
    const response = await post(
      '/v1/runs',
      { agent: { model: { ref: 'internal/echo' } }, input: 'x' },
      { 'x-tenant-ref': 'merchant-does-not-exist' },
    );
    expect(response.status).toBe(403);
  });

  it('resumes an SSE stream from Last-Event-ID without replaying what was seen', async () => {
    const created = (await (
      await post('/v1/runs', { agent: { model: { ref: 'internal/echo' } }, input: 'stream' })
    ).json()) as { runId: string };
    await settle(created.runId);

    const text = await (await get(`/v1/runs/${created.runId}/events`, { 'last-event-id': '2' })).text();
    expect(text).toContain('stream.connected');
    expect(text).toContain('id: 3');
    expect(text).not.toContain('id: 1');
    expect(text).not.toContain('id: 2\n');
  });
});
