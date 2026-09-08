import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fixture, type Fixture } from './fixtures.js';

const API = 'http://localhost:3000';
const H = {
  'content-type': 'application/json',
  'x-caller-subject': 'svc:demo-client',
  'x-namespace': 'demo',
  'x-tenant-ref': 'merchant-1',
};

interface Delivery { idem: string | undefined; body: Record<string, unknown> }

let f: Fixture;
let sink: Server;
let sinkUrl = '';
const deliveries: Delivery[] = [];
const agentName = `trig-${Math.random().toString(36).slice(2, 8)}`;
const hookPath = `hook-${Math.random().toString(36).slice(2, 8)}`;

const post = (p: string, b?: unknown, h = H) =>
  fetch(API + p, { method: 'POST', headers: h, body: b === undefined ? '{}' : JSON.stringify(b) });
const get = (p: string) => fetch(API + p, { headers: H });

async function settle(runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const run = (await (await get(`/v1/runs/${runId}`)).json()) as Record<string, unknown>;
    if (['completed', 'failed'].includes(run['status'] as string)) return run;
    if (Date.now() > deadline) throw new Error('stuck');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  f = await fixture();
  sink = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      deliveries.push({
        idem: req.headers['idempotency-key'] as string | undefined,
        body: JSON.parse(raw || '{}') as Record<string, unknown>,
      });
      res.writeHead(200); res.end('{}');
    });
  });
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
  sinkUrl = `http://127.0.0.1:${(sink.address() as { port: number }).port}/cb`;

  await post('/v1/agents', {
    name: agentName, owner: 'platform-eng',
    agent: { model: { ref: 'internal/echo' } },
  });
});

afterAll(async () => {
  const agent = await f.db.selectFrom('agents').select('id')
    .where('namespace_id', '=', f.namespaceId).where('name', '=', agentName).executeTakeFirst();
  if (agent) await f.db.deleteFrom('triggers').where('agent_id', '=', agent.id).execute();
  await new Promise<void>((r) => sink.close(() => r()));
  await f.close();
});

describe('registered agents and triggers (§17.4, §18.2)', () => {
  it('accumulates immutable versions on publish', async () => {
    await post('/v1/agents', {
      name: agentName, owner: 'platform-eng',
      agent: { model: { ref: 'internal/echo' }, systemPrompt: 'v2' },
    });
    const agent = (await (await get(`/v1/agents/${agentName}`)).json()) as {
      versions: { version: number }[];
    };
    // A version is what a deployment, a trigger and a rollback point at, so two publishes
    // are two versions even when the spec is identical.
    expect(agent.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('fires a webhook trigger with no identity headers at all', async () => {
    await post(`/v1/agents/${agentName}/triggers`, {
      type: 'webhook', webhookPath: hookPath, delivery: { webhookUrl: sinkUrl },
    });

    // An external caller has no reason to know our headers; tenancy comes from the
    // trigger row instead.
    const fired = (await (
      await fetch(`${API}/v1/triggers/webhooks/${hookPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: 'ord-1' }),
      })
    ).json()) as { runId: string };

    const run = await settle(fired.runId);
    expect(run['status']).toBe('completed');
    expect(run['input']).toEqual({ orderId: 'ord-1' });

    const stored = await f.db.selectFrom('runs')
      .select(['initiator', 'trigger_id', 'tenant_ref', 'authorizing_human_id'])
      .where('id', '=', fired.runId).executeTakeFirstOrThrow();
    expect(stored.initiator).toBe('trigger');
    expect(stored.tenant_ref).toBe('merchant-1');
    // §0.1: recorded as null, not omitted. "Nobody at run time" is an answer.
    expect(stored.authorizing_human_id).toBeNull();
  });

  it('delivers the outcome through the outbox with an idempotency key', async () => {
    const fired = (await (
      await fetch(`${API}/v1/triggers/webhooks/${hookPath}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: 'ord-2' }),
      })
    ).json()) as { runId: string };
    await settle(fired.runId);

    // Wait for THIS run's delivery rather than a count: an earlier test's delivery can
    // land here, and asserting on length would make the test flaky for a reason that has
    // nothing to do with what it checks.
    const deadline = Date.now() + 25_000;
    let delivery: Delivery | undefined;
    while (!delivery && Date.now() < deadline) {
      delivery = deliveries.find((d) => d.body['runId'] === fired.runId);
      if (!delivery) await new Promise((r) => setTimeout(r, 200));
    }
    expect(delivery, 'no delivery arrived for this run').toBeDefined();
    // At-least-once delivery is honest only if the receiver can deduplicate.
    expect(delivery!.idem).toBe(`run:${fired.runId}:completed`);
    expect(delivery!.body['status']).toBe('completed');
  });

  it('writes the outbox row inside the terminal transaction', async () => {
    const fired = (await (
      await fetch(`${API}/v1/triggers/webhooks/${hookPath}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: 'ord-3' }),
      })
    ).json()) as { runId: string };
    await settle(fired.runId);

    // The row exists the moment the run is terminal -- a crash between "completed" and
    // "caller told" is what the outbox makes impossible.
    const row = await f.db.selectFrom('outbox').select(['destination', 'idempotency_key'])
      .where('run_id', '=', fired.runId).executeTakeFirstOrThrow();
    expect(row.destination).toBe(sinkUrl);
    expect(row.idempotency_key).toBe(`run:${fired.runId}:completed`);
  });

  it('404s an unknown or disabled webhook path', async () => {
    expect((await fetch(`${API}/v1/triggers/webhooks/no-such-hook`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status).toBe(404);
  });

  it('refuses a trigger whose shape does not match its type', async () => {
    const r = await post(`/v1/agents/${agentName}/triggers`, { type: 'schedule' });
    expect(r.status).toBe(422);
  });
});
