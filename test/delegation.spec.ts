import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './fixtures.js';

const API = 'http://localhost:3000';
const H = {
  'content-type': 'application/json',
  'x-caller-subject': 'svc:demo-client',
  'x-namespace': 'demo',
  'x-tenant-ref': 'merchant-1',
};

const STAGES = ['stage-a', 'stage-b', 'stage-c'];
let f: Fixture;

const post = (p: string, b?: unknown) =>
  fetch(API + p, { method: 'POST', headers: H, body: b === undefined ? '{}' : JSON.stringify(b) });
const get = (p: string) => fetch(API + p, { headers: H });

async function settle(runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const run = (await (await get(`/v1/runs/${runId}`)).json()) as Record<string, unknown>;
    if (['completed', 'failed', 'cancelled'].includes(run['status'] as string)) return run;
    if (Date.now() > deadline) throw new Error(`stuck in ${String(run['status'])}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const runPipeline = async (subAgents: string[], input = 'go') => {
  const created = (await (
    await post('/v1/runs', {
      agent: { framework: 'pipeline', model: { ref: 'internal/echo' }, subAgents },
      input,
    })
  ).json()) as { runId: string };
  return { runId: created.runId, run: await settle(created.runId) };
};

beforeAll(async () => {
  f = await fixture();
  if (!(await fetch(`${API}/healthz`).catch(() => null))?.ok) {
    throw new Error('api and worker must be running');
  }
  for (const name of STAGES) {
    await post('/v1/agents', {
      name, owner: 'test',
      agent: { model: { ref: 'internal/echo' }, systemPrompt: `stage ${name}` },
    });
  }
});
afterAll(async () => f.close());

describe('sub-agent delegation (§13.3, §4.6)', () => {
  it('spawns one child run per stage, each with its own lifecycle', async () => {
    const { runId, run } = await runPipeline(STAGES);
    expect(run['status']).toBe('completed');

    const children = await f.db
      .selectFrom('runs')
      .select(['id', 'status', 'initiator', 'delegation_depth', 'root_run_id'])
      .where('parent_run_id', '=', runId)
      .execute();

    expect(children).toHaveLength(STAGES.length);
    // A separate run, not a tool call: own lease, own checkpoints, own retries (§13.3).
    expect(children.every((c) => c.initiator === 'sub_agent')).toBe(true);
    expect(children.every((c) => c.status === 'completed')).toBe(true);
    expect(children.every((c) => c.delegation_depth === 1)).toBe(true);
    expect(children.every((c) => c.root_run_id === runId)).toBe(true);
  });

  it('runs stages in the order the spec declared, not the order the planner returns', async () => {
    // The binding table has no ordinal. Ordering by the join alone silently reorders a
    // pipeline, which for consumer 02 means running `correction` before `intent`.
    const { run } = await runPipeline(STAGES);
    const output = run['output'] as { text: string };
    expect(output.text).toBe(STAGES.map((s) => `${s}:ok`).join(' -> '));
  });

  it('suspends the parent into waiting and releases its queue slot', async () => {
    const created = (await (
      await post('/v1/runs', {
        agent: { framework: 'pipeline', model: { ref: 'internal/echo' }, subAgents: STAGES },
        input: 'slow',
      })
    ).json()) as { runId: string };

    // The parent must not hold a worker while a child runs -- a delegation taking an hour
    // would otherwise occupy a slot for an hour.
    const events = await settle(created.runId).then(async () => {
      const { events } = (await (await get(`/v1/runs/${created.runId}/events/history`)).json()) as {
        events: { type: string; payload: Record<string, unknown> }[];
      };
      return events;
    });
    const waits = events.filter((e) => e.type === 'run.waiting');
    expect(waits.length).toBe(STAGES.length);
    expect(waits[0]!.payload['reason']).toBe('delegation');
    expect(events.filter((e) => e.type === 'run.resumed').length).toBeGreaterThanOrEqual(1);
  });

  it('carries the delegation chain into every child (§0.1)', async () => {
    const { runId } = await runPipeline(STAGES);
    const child = await f.db
      .selectFrom('runs').select(['delegation_chain', 'caller_principal_id', 'trace_id'])
      .where('parent_run_id', '=', runId).executeTakeFirstOrThrow();
    const parent = await f.db
      .selectFrom('runs').select(['caller_principal_id', 'trace_id'])
      .where('id', '=', runId).executeTakeFirstOrThrow();

    const chain = child.delegation_chain as { runId: string }[];
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0]!.runId).toBe(runId);
    // Identity and trace survive the hop, or the audit cannot answer who authorised the
    // side effect a child performed.
    expect(child.caller_principal_id).toBe(parent.caller_principal_id);
    expect(child.trace_id).toBe(parent.trace_id);
  });

  it('shows the whole graph in one trace (§15.2)', async () => {
    const { runId } = await runPipeline(STAGES);
    const trace = (await (await get(`/v1/runs/${runId}/trace`)).json()) as {
      children: { runId: string; status: string }[]; steps: { kind: string }[];
    };
    expect(trace.children).toHaveLength(STAGES.length);
    expect(trace.steps.every((s) => s.kind === 'delegation')).toBe(true);
  });

  it('refuses a sub-agent from another namespace at admission (§13.3)', async () => {
    const response = await post('/v1/runs', {
      agent: {
        framework: 'pipeline', model: { ref: 'internal/echo' },
        subAgents: ['no-such-agent-anywhere'],
      },
      input: 'x',
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { rejections: string[] };
    expect(body.rejections.join(' ')).toMatch(/A2A/);
  });

  it('contains a failed stage rather than losing the run (§13.5)', async () => {
    // A stage that cannot succeed: maxSteps 1 makes the child fail immediately.
    await post('/v1/agents', {
      name: 'stage-doomed', owner: 'test',
      agent: { model: { ref: 'internal/echo' }, execution: { limits: { maxSteps: 1 } } },
    });

    const { run } = await runPipeline(['stage-a', 'stage-doomed', 'stage-c']);
    // Failure is CONTAINED: reported to the parent's reasoning loop, not silently
    // discarded and not automatically fatal.
    expect(run['status']).toBe('completed');
    const output = run['output'] as { halted: boolean; stages: { alias: string; failed: boolean }[] };
    expect(output.halted).toBe(true);
    expect(output.stages.find((s) => s.alias === 'stage-doomed')?.failed).toBe(true);
    // The pipeline stopped rather than feeding stage-c input its predecessor never made.
    expect(output.stages.some((s) => s.alias === 'stage-c')).toBe(false);
  });
});
