import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './fixtures.js';

const API = 'http://localhost:3000';
const H = {
  'content-type': 'application/json',
  'x-caller-subject': 'svc:demo-client',
  'x-namespace': 'demo',
  'x-tenant-ref': 'merchant-1',
};

let f: Fixture;
const threads: string[] = [];

const post = (p: string, b?: unknown, h = H) =>
  fetch(API + p, { method: 'POST', headers: h, body: b === undefined ? '{}' : JSON.stringify(b) });
const get = (p: string, h = H) => fetch(API + p, { headers: h });

async function settle(runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const run = (await (await get(`/v1/runs/${runId}`)).json()) as Record<string, unknown>;
    if (['completed', 'failed'].includes(run['status'] as string)) return run;
    if (Date.now() > deadline) throw new Error('stuck');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Memory is written AFTER the run's terminal transaction, deliberately: a memory write
 * must never roll back a completed run. That makes it eventually consistent with respect
 * to run status, so a test that reads immediately on `completed` races it -- and so would
 * a caller. Worth knowing rather than papering over.
 */
async function memoryFor(threadId: string, atLeast = 1, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const rows = await f.db
      .selectFrom('memory_records')
      .select(['tier', 'provenance', 'delivered', 'content'])
      .where('scope_thread_id', '=', threadId)
      .execute();
    if (rows.length >= atLeast || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const newThread = async (): Promise<string> => {
  const t = (await (await post('/v1/threads', {})).json()) as { id: string };
  threads.push(t.id);
  return t.id;
};

const turn = async (threadId: string, input: string, memory: unknown) => {
  const created = (await (
    await post(`/v1/threads/${threadId}/runs`, {
      agent: { model: { ref: 'internal/echo' }, memory },
      input,
    })
  ).json()) as { runId: string };
  return settle(created.runId);
};

beforeAll(async () => {
  f = await fixture();
  if (!(await fetch(`${API}/healthz`).catch(() => null))?.ok) {
    throw new Error('api and worker must be running');
  }
});

afterAll(async () => {
  if (threads.length > 0) {
    await f.db.deleteFrom('memory_records').where('scope_thread_id', 'in', threads).execute();
  }
  await f.close();
});

describe('memory through a run (§6, §0.5)', () => {
  it('writes nothing when the agent has memory disabled', async () => {
    const threadId = await newThread();
    // §0.5: a compensating mechanism is opt-in and individually disableable. Default-on
    // memory would make its benefit impossible to measure.
    await turn(threadId, 'no memory please', { enabled: false });
    // Settle time for a write that would have happened, so this asserts absence rather
    // than merely arriving first.
    await new Promise((r) => setTimeout(r, 1_000));

    const rows = await memoryFor(threadId, 1, 0);
    expect(rows).toHaveLength(0);
  });

  it('records the turn once the run completes', async () => {
    const threadId = await newThread();
    await turn(threadId, 'remember this turn', {
      enabled: true, tiers: ['conversational', 'episodic'],
    });

    const rows = await memoryFor(threadId, 3);

    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.some((r) => r.provenance === 'user_input')).toBe(true);
    expect(rows.some((r) => r.tier === 'episodic')).toBe(true);
    // §6.3: everything written here was actually delivered to the user.
    expect(rows.every((r) => r.delivered === true)).toBe(true);
  });

  it('writes nothing for a run that failed', async () => {
    const threadId = await newThread();
    const created = (await (
      await post(`/v1/threads/${threadId}/runs`, {
        // Two steps wanted, one allowed: the model call fits, the tool call does not.
        // `maxSteps: 1` alone no longer fails a one-step run -- it used to, through an
        // off-by-one that made every ceiling one lower than it read.
        agent: {
          model: { ref: 'internal/echo' },
          tools: ['demo.echo'],
          memory: { enabled: true, tiers: ['conversational', 'episodic'] },
          execution: { limits: { maxSteps: 1 } },
        },
        input: 'this run will fail',
      })
    ).json()) as { runId: string };
    const run = await settle(created.runId);
    expect(run['status']).toBe('failed');

    await new Promise((r) => setTimeout(r, 1_000));
    // §6.3 as a write rule: the user received nothing, so the agent must not later
    // reference this as something it said.
    const rows = await memoryFor(threadId, 1, 0);
    expect(rows).toHaveLength(0);
  });

  it('surfaces recall to the framework adapter on the next turn', async () => {
    const threadId = await newThread();
    const memory = { enabled: true, tiers: ['conversational', 'episodic'], recallLimit: 5 };

    await turn(threadId, 'the deployment window is on Thursday', memory);
    await memoryFor(threadId, 3);
    const second = await turn(threadId, 'when is the deployment window', memory);

    const output = second['output'] as { recalled?: { tier: string; content: string }[] };
    // Passed to the ADAPTER rather than prepended to the prompt by the platform: what to
    // do with recalled context is the framework's decision (§2.1).
    expect(output.recalled).toBeDefined();
    expect(output.recalled!.length).toBeGreaterThan(0);
  });

  it('keeps one thread\'s memory out of another\'s recall', async () => {
    const memory = { enabled: true, tiers: ['conversational'], recallLimit: 5 };
    const a = await newThread();
    const b = await newThread();

    await turn(a, 'the passphrase is bluebird', memory);
    await memoryFor(a, 2);
    const onB = await turn(b, 'what is the passphrase', memory);

    const recalled = (onB['output'] as { recalled?: { content: string }[] }).recalled ?? [];
    expect(recalled.some((r) => (r.content ?? '').includes('bluebird'))).toBe(false);
  });

  it('does not fail a run when recall breaks', async () => {
    const threadId = await newThread();
    // A scope reference that cannot resolve. Memory is a compensating mechanism, not a
    // dependency: degraded recall must not take down a run that would otherwise succeed.
    const run = await turn(threadId, 'recall may fail here', {
      enabled: true, tiers: ['semantic'], recallLimit: 5,
    });
    expect(run['status']).toBe('completed');
  });
});
