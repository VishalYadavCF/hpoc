import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, type Fixture } from './fixtures.js';

const API = 'http://localhost:3000';
const H = {
  'content-type': 'application/json',
  'x-caller-subject': 'svc:demo-client',
  'x-namespace': 'demo',
  'x-tenant-ref': 'merchant-1',
};
const OTHER = { ...H, 'x-tenant-ref': 'merchant-2' };

let f: Fixture;
let threadId: string;
let toolRunId: string;
let plainRunId: string;

const post = (p: string, b?: unknown, h = H) =>
  fetch(API + p, { method: 'POST', headers: h, body: b === undefined ? '{}' : JSON.stringify(b) });
const get = (p: string, h = H) => fetch(API + p, { headers: h });

async function settle(runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const run = (await (await get(`/v1/runs/${runId}`)).json()) as Record<string, unknown>;
    if (['completed', 'failed'].includes(run['status'] as string)) return run;
    if (Date.now() > deadline) throw new Error('stuck');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const turn = async (input: string, agent: Record<string, unknown>) => {
  const created = (await (
    await post(`/v1/threads/${threadId}/runs`, { agent, input })
  ).json()) as { runId: string };
  await settle(created.runId);
  return created.runId;
};

beforeAll(async () => {
  f = await fixture();
  if (!(await fetch(`${API}/healthz`).catch(() => null))?.ok) {
    throw new Error('api and worker must be running');
  }
  await f.db.insertInto('tenants')
    .values({ org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: 'merchant-2' })
    .onConflict((oc) => oc.columns(['namespace_id', 'tenant_ref']).doNothing()).execute();

  threadId = ((await (await post('/v1/threads', { title: 'obs' })).json()) as { id: string }).id;
  plainRunId = await turn('plain turn', { model: { ref: 'internal/echo' } });
  toolRunId = await turn('tool turn', { model: { ref: 'internal/echo' }, tools: ['demo.echo'] });
});

afterAll(async () => {
  await f.db.deleteFrom('feedback').where('thread_id', '=', threadId).execute();
  await f.db.deleteFrom('memory_records').where('scope_thread_id', '=', threadId).execute();
  await f.close();
});

describe('trace assembly (§15.2)', () => {
  it('reconstructs the steps of a run in order', async () => {
    const trace = (await (await get(`/v1/runs/${toolRunId}/trace`)).json()) as {
      status: string; steps: { seq: number; kind: string; status: string; detail: Record<string, unknown> }[];
    };
    expect(trace.status).toBe('completed');
    expect(trace.steps.map((s) => s.kind)).toEqual(['model_call', 'tool_call']);
    expect(trace.steps.map((s) => s.seq)).toEqual([1, 2]);
    expect(trace.steps[1]!.detail['tool']).toBe('demo.echo');
  });

  it('attributes latency rather than lumping it into one number', async () => {
    const trace = (await (await get(`/v1/runs/${toolRunId}/trace`)).json()) as {
      wallMs: number;
      latency: { queueWaitMs: number; modelMs: number; toolMs: number; humanWaitMs: number; unaccountedMs: number };
    };
    const l = trace.latency;
    // Every component is non-negative. A negative duration means two clocks are being
    // differenced -- the bug that wiring NOTIFY exposed.
    for (const [name, value] of Object.entries(l)) {
      expect(value, `${name} should not be negative`).toBeGreaterThanOrEqual(0);
    }
    expect(l.modelMs).toBeGreaterThan(0);
    expect(l.toolMs).toBeGreaterThan(0);
    // Queue wait is separate from work time: "the agent is slow" and "the queue is deep"
    // are different problems with different fixes (§15.4).
    expect(l).toHaveProperty('queueWaitMs');
    expect(l.modelMs + l.toolMs).toBeLessThanOrEqual(trace.wallMs + l.unaccountedMs + 1);
  });

  it('renders a whole conversation turn by turn', async () => {
    const trace = (await (await get(`/v1/threads/${threadId}/trace`)).json()) as {
      turns: { runId: string; status: string }[];
    };
    expect(trace.turns.length).toBeGreaterThanOrEqual(2);
    expect(trace.turns.map((t) => t.runId)).toContain(plainRunId);
  });

  it('will not trace another tenant\'s run', async () => {
    expect((await get(`/v1/runs/${toolRunId}/trace`, OTHER)).status).toBe(404);
  });
});

describe('feedback (§15.5)', () => {
  it('binds feedback to the version that produced the run', async () => {
    const run = await f.db.selectFrom('runs').select('agent_version_id')
      .where('id', '=', plainRunId).executeTakeFirstOrThrow();

    const body = (await (
      await post('/v1/feedback', { runId: plainRunId, rating: 1, label: 'task_success' })
    ).json()) as { agentVersionId: string };

    // Resolved from the run, not supplied by the caller: a caller-supplied version could
    // attribute a complaint to the wrong release, which is the number a promotion turns on.
    expect(body.agentVersionId).toBe(run.agent_version_id);
  });

  it('accepts a correction, which is the highest-signal feedback there is', async () => {
    await post('/v1/feedback', {
      runId: toolRunId, rating: -1, label: 'wrong_answer',
      correction: { expected: '48 hours' },
    });
    const listed = (await (await get(`/v1/feedback?runId=${toolRunId}`)).json()) as {
      feedback: { correction: unknown; rating: number }[];
    };
    expect(listed.feedback[0]!.correction).toEqual({ expected: '48 hours' });
    expect(listed.feedback[0]!.rating).toBe(-1);
  });

  it('requires a run or a thread', async () => {
    expect((await post('/v1/feedback', { rating: 1 })).status).toBe(422);
  });

  it('refuses feedback on another tenant\'s run', async () => {
    // Otherwise an orphan row would silently skew a version comparison the caller cannot
    // even see.
    expect((await post('/v1/feedback', { runId: plainRunId, rating: 1 }, OTHER)).status).toBe(404);
  });

  it('rolls up by version', async () => {
    const summary = (await (await get('/v1/feedback/summary')).json()) as {
      summary: { agentVersionId: string; total: number; negative: number; corrections: number }[];
    };
    expect(summary.summary.length).toBeGreaterThan(0);
    expect(summary.summary.some((s) => s.corrections > 0)).toBe(true);
  });
});

describe('analytics (§15.5)', () => {
  it('reports outcome, latency and cost per agent version', async () => {
    const body = (await (await get('/v1/analytics/versions?hours=24')).json()) as {
      versions: { runs: number; successRate: number | null; latencyMs: { p50: number | null } }[];
    };
    expect(body.versions.length).toBeGreaterThan(0);
    const withRuns = body.versions.find((v) => v.runs > 0)!;
    expect(withRuns.successRate).not.toBeNull();
    expect(withRuns.latencyMs).toHaveProperty('p50');
  });

  it('separates queue wait from step time', async () => {
    const body = (await (await get('/v1/analytics/latency?hours=24')).json()) as {
      steps: { kind: string; calls: number }[];
      queueWaitMs: { p50: number | null; p95: number | null };
    };
    expect(body.steps.some((s) => s.kind === 'model_call')).toBe(true);
    expect(body.queueWaitMs).toHaveProperty('p95');
  });

  it('reports tool volume and failure rate', async () => {
    const body = (await (await get('/v1/analytics/tools?hours=24')).json()) as {
      tools: { tool: string; calls: number; failureRate: number }[];
    };
    const echo = body.tools.find((t) => t.tool === 'demo.echo');
    expect(echo).toBeDefined();
    expect(echo!.calls).toBeGreaterThan(0);
    expect(echo!.failureRate).toBeGreaterThanOrEqual(0);
  });

  it('states plainly that memory effectiveness is observational', async () => {
    const body = (await (await get('/v1/analytics/memory?hours=24')).json()) as {
      caveat: string; cohorts: { memoryEnabled: boolean; runs: number }[];
    };
    // §0.5 wants each mechanism to demonstrate benefit. An observational cohort split can
    // notice a mechanism is NOT helping; it cannot establish that it is, and the response
    // has to say so or someone will quote it as if it could.
    expect(body.caveat).toMatch(/observational|randomis/i);
    expect(body.cohorts.length).toBeGreaterThan(0);
  });
});
