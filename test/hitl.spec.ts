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

let f: Fixture;
let target: Server;
let originalUrl: string | null = null;
let calls = 0;

const post = (p: string, b?: unknown) =>
  fetch(API + p, { method: 'POST', headers: H, body: b === undefined ? '{}' : JSON.stringify(b) });
const get = (p: string) => fetch(API + p, { headers: H });

async function wait(runId: string, want: string[], ms = 20_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const run = (await (await get(`/v1/runs/${runId}`)).json()) as Record<string, unknown>;
    if (want.includes(run['status'] as string)) return run;
    if (Date.now() > deadline) throw new Error(`stuck in ${String(run['status'])}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const pendingFor = async (runId: string) => {
  const body = (await (await get('/v1/interactions?status=pending')).json()) as {
    interactions: { id: string; run_id: string; kind: string }[];
  };
  return body.interactions.filter((i) => i.run_id === runId);
};

beforeAll(async () => {
  f = await fixture();
  target = createServer((req, res) => {
    calls += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ executed: true }));
    });
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const port = (target.address() as { port: number }).port;

  const tool = await f.db
    .selectFrom('tools').select(['id', 'endpoint_url'])
    .where('org_id', '=', f.orgId).where('ref', '=', 'demo.gated').executeTakeFirstOrThrow();
  originalUrl = tool.endpoint_url;
  await f.db.updateTable('tools')
    .set({ endpoint_url: `http://127.0.0.1:${port}/gated` })
    .where('id', '=', tool.id).execute();
});

afterAll(async () => {
  if (originalUrl !== null) {
    await f.db.updateTable('tools').set({ endpoint_url: originalUrl })
      .where('org_id', '=', f.orgId).where('ref', '=', 'demo.gated').execute();
  }
  await new Promise<void>((r) => target.close(() => r()));
  await f.close();
});

const gatedRun = async (input: string) =>
  (await (
    await post('/v1/runs', {
      agent: { model: { ref: 'internal/echo' }, tools: ['demo.gated'] },
      input,
    })
  ).json()) as { runId: string };

describe('human-in-the-loop (§14)', () => {
  it('suspends into waiting and creates an Interaction before executing', async () => {
    const before = calls;
    const run = await gatedRun('gate me');
    const state = await wait(run.runId, ['waiting', 'completed', 'failed']);

    expect(state['status']).toBe('waiting');
    // The gate is BEFORE execution -- an approval sought after the side effect is theatre.
    expect(calls).toBe(before);

    const pending = await pendingFor(run.runId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe('approval');
  });

  it('resumes and executes the approved action rather than skipping it', async () => {
    const before = calls;
    const run = await gatedRun('approve me');
    await wait(run.runId, ['waiting']);
    const [interaction] = await pendingFor(run.runId);

    const responded = (await (
      await post(`/v1/interactions/${interaction!.id}/respond`, { approved: true })
    ).json()) as { resumed: boolean };
    expect(responded.resumed).toBe(true);

    const state = await wait(run.runId, ['completed', 'failed']);
    expect(state['status']).toBe('completed');
    // The adapter's state had already advanced past this call; without the pendingAction
    // on the checkpoint the run would complete having silently skipped it.
    expect(calls).toBe(before + 1);

    const steps = (await (await get(`/v1/runs/${run.runId}/steps`)).json()) as {
      steps: { kind: string; status: string }[];
    };
    expect(steps.steps.find((s) => s.kind === 'tool_call')?.status).toBe('succeeded');
  });

  it('never executes a denied action, and the run still finishes', async () => {
    const before = calls;
    const run = await gatedRun('deny me');
    await wait(run.runId, ['waiting']);
    const [interaction] = await pendingFor(run.runId);

    await post(`/v1/interactions/${interaction!.id}/respond`, { approved: false });
    const state = await wait(run.runId, ['completed', 'failed']);

    expect(calls).toBe(before);
    // A denied approval is a normal outcome fed back to the agent, not a crash.
    expect(state['status']).toBe('completed');

    const steps = (await (await get(`/v1/runs/${run.runId}/steps`)).json()) as {
      steps: { kind: string; status: string }[];
    };
    expect(steps.steps.find((s) => s.kind === 'tool_call')?.status).toBe('cancelled');
  });

  it('records the whole lifecycle in the event log', async () => {
    const run = await gatedRun('audit me');
    await wait(run.runId, ['waiting']);
    const [interaction] = await pendingFor(run.runId);
    await post(`/v1/interactions/${interaction!.id}/respond`, { approved: true });
    await wait(run.runId, ['completed', 'failed']);

    const { events } = (await (await get(`/v1/runs/${run.runId}/events/history`)).json()) as {
      events: { type: string }[];
    };
    const types = events.map((e) => e.type);
    expect(types).toContain('interaction.created');
    expect(types).toContain('interaction.resolved');
    expect(types).toContain('run.resumed');
    expect(types.indexOf('interaction.resolved')).toBeLessThan(types.indexOf('run.resumed'));
  });

  it('refuses a second answer rather than re-enqueueing the run', async () => {
    const run = await gatedRun('answer once');
    await wait(run.runId, ['waiting']);
    const [interaction] = await pendingFor(run.runId);
    await post(`/v1/interactions/${interaction!.id}/respond`, { approved: true });
    await wait(run.runId, ['completed', 'failed']);

    const second = await post(`/v1/interactions/${interaction!.id}/respond`, { approved: true });
    expect(second.status).toBe(409);
  });

  it('carries the tool\'s declared contract onto the binding', async () => {
    const run = await gatedRun('contract');
    await wait(run.runId, ['waiting']);

    const version = await f.db
      .selectFrom('runs').select('agent_version_id').where('id', '=', run.runId)
      .executeTakeFirstOrThrow();
    const binding = await f.db
      .selectFrom('agent_version_tools as avt')
      .innerJoin('tools as t', 't.id', 'avt.tool_id')
      .select((eb) => [
        'avt.idempotency_key_tpl',
        eb.ref('t.ref').as('ref'),
      ])
      .where('avt.agent_version_id', '=', version.agent_version_id)
      .where('t.ref', '=', 'demo.gated')
      .executeTakeFirstOrThrow();

    // §4.5: an idempotent tool is retried WITH a key, or it is not idempotent. The binding
    // must satisfy the obligation the effect declares.
    expect(binding.idempotency_key_tpl).toBeTruthy();
  });
});
