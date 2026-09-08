import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './fixtures.js';

const API = 'http://localhost:3000';
const H = {
  'content-type': 'application/json',
  'x-caller-subject': 'svc:demo-client',
  'x-namespace': 'demo',
  'x-tenant-ref': 'merchant-1',
};
const OTHER_TENANT = { ...H, 'x-tenant-ref': 'merchant-2' };

let f: Fixture;
const post = (p: string, b?: unknown, h = H) =>
  fetch(API + p, { method: 'POST', headers: h, body: b === undefined ? '{}' : JSON.stringify(b) });
const get = (p: string, h = H) => fetch(API + p, { headers: h });

async function settle(runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const run = (await (await get(`/v1/runs/${runId}`)).json()) as Record<string, unknown>;
    if (['completed', 'failed'].includes(run['status'] as string)) return run;
    if (Date.now() > deadline) throw new Error('stuck');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const turn = async (threadId: string, input: string) => {
  const created = (await (
    await post(`/v1/threads/${threadId}/runs`, {
      agent: { model: { ref: 'internal/echo' } },
      input,
    })
  ).json()) as { runId: string };
  return settle(created.runId);
};

beforeAll(async () => {
  f = await fixture();
  // A second tenant, so isolation can be tested rather than assumed.
  await f.db
    .insertInto('tenants')
    .values({ org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: 'merchant-2' })
    .onConflict((oc) => oc.columns(['namespace_id', 'tenant_ref']).doNothing())
    .execute();
});
afterAll(async () => f.close());

describe('threads (§3)', () => {
  it('spans many runs on one thread', async () => {
    const thread = (await (await post('/v1/threads', { title: 'build a workflow' })).json()) as { id: string };

    await turn(thread.id, 'first turn');
    await turn(thread.id, 'second turn');
    await turn(thread.id, 'third turn');

    const { runs } = (await (await get(`/v1/threads/${thread.id}/runs`)).json()) as {
      runs: { id: string; status: string }[];
    };
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.status === 'completed')).toBe(true);
  });

  it('gives each turn its own run rather than extending the last', async () => {
    // §3: execution state, retries and checkpoints live on the run; continuity lives on
    // the thread. A turn that reused the previous run would lose per-turn resumability.
    const thread = (await (await post('/v1/threads', {})).json()) as { id: string };
    const a = await turn(thread.id, 'one');
    const b = await turn(thread.id, 'two');
    expect(a['id']).not.toBe(b['id']);
    expect(a['threadId']).toBe(b['threadId']);
  });

  it('projects a transcript of what the user received', async () => {
    const thread = (await (await post('/v1/threads', {})).json()) as { id: string };
    await turn(thread.id, 'hello there');

    const { messages } = (await (await get(`/v1/threads/${thread.id}/messages`)).json()) as {
      messages: { role: string; content: unknown }[];
    };
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]!.content).toBe('hello there');
    expect(String(messages[1]!.content)).toContain('hello there');
  });

  it('omits a failed run from the transcript (§6.3)', async () => {
    const thread = (await (await post('/v1/threads', {})).json()) as { id: string };
    await turn(thread.id, 'good turn');

    // A run that failed produced no output the user received, so it must not appear as
    // something the agent said.
    const created = (await (
      await post(`/v1/threads/${thread.id}/runs`, {
        agent: { model: { ref: 'internal/echo' }, execution: { limits: { maxSteps: 1 } } },
        input: 'doomed turn',
      })
    ).json()) as { runId: string };
    const failed = await settle(created.runId);
    expect(failed['status']).toBe('failed');

    const { messages } = (await (await get(`/v1/threads/${thread.id}/messages`)).json()) as {
      messages: { role: string; content: unknown }[];
    };
    const assistantTurns = messages.filter((m) => m.role === 'assistant');
    expect(assistantTurns).toHaveLength(1);
    expect(messages.some((m) => m.role === 'user' && m.content === 'doomed turn')).toBe(true);
  });

  it('hides another tenant\'s thread entirely', async () => {
    const thread = (await (await post('/v1/threads', { title: 'private' })).json()) as { id: string };
    // Not an empty list, not a 403 on the field -- a 404, indistinguishable from a thread
    // that does not exist (§5.2).
    expect((await get(`/v1/threads/${thread.id}`, OTHER_TENANT)).status).toBe(404);
    expect((await get(`/v1/threads/${thread.id}/runs`, OTHER_TENANT)).status).toBe(404);
  });

  it('refuses a turn on a thread the caller cannot see', async () => {
    const thread = (await (await post('/v1/threads', {})).json()) as { id: string };
    const response = await post(
      `/v1/threads/${thread.id}/runs`,
      { agent: { model: { ref: 'internal/echo' } }, input: 'x' },
      OTHER_TENANT,
    );
    expect(response.status).toBe(404);
  });

  it('archives without destroying its runs', async () => {
    const thread = (await (await post('/v1/threads', {})).json()) as { id: string };
    await turn(thread.id, 'keep me');
    await post(`/v1/threads/${thread.id}/archive`);

    const state = (await (await get(`/v1/threads/${thread.id}`)).json()) as { status: string };
    expect(state.status).toBe('archived');
    const { runs } = (await (await get(`/v1/threads/${thread.id}/runs`)).json()) as { runs: unknown[] };
    expect(runs).toHaveLength(1);
  });
});
