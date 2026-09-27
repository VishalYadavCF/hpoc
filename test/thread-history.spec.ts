import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  boundHistory,
  dedupeRecalled,
  loadThreadHistory,
  projectThreadMessages,
  THREAD_HISTORY_MAX_MESSAGES,
  threadHistoryFor,
} from '../src/domain/thread/thread-history.js';
import { agentSpecSchema } from '../src/domain/registry/agent-spec.js';
import { stableHash } from '../src/platform/ids.js';
import { fixture, type Fixture } from './fixtures.js';

/**
 * §3 thread continuity: a new run on a thread is handed the thread's earlier DELIVERED
 * turns, whether or not the agent has memory enabled.
 */
let f: Fixture;
let versionId: string;
const threads: string[] = [];

beforeAll(async () => {
  f = await fixture();
  const version = await f.db
    .insertInto('agent_versions')
    .values({
      org_id: f.orgId, namespace_id: f.namespaceId, lifetime: 'ephemeral',
      spec: JSON.stringify({ framework: 'echo' }),
      spec_hash: `test-history-${Math.random().toString(36).slice(2)}`,
      workload_identity_id: f.principalId, model_id: f.modelId,
    })
    .returning('id').executeTakeFirstOrThrow();
  versionId = version.id;
});

afterAll(async () => {
  if (threads.length > 0) {
    // Children first: they reference their parent.
    await f.db.deleteFrom('runs').where('thread_id', 'in', threads).where('parent_run_id', 'is not', null).execute();
    await f.db.deleteFrom('runs').where('thread_id', 'in', threads).execute();
    await f.db.deleteFrom('threads').where('id', 'in', threads).execute();
  }
  await f.db.deleteFrom('agent_versions').where('id', '=', versionId).execute();
  await f.close();
});

const newThread = async () => {
  const t = await f.db
    .insertInto('threads')
    .values({ org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef })
    .returning('id').executeTakeFirstOrThrow();
  threads.push(t.id);
  return t.id;
};

let clock = Date.UTC(2026, 0, 1);
const addRun = async (
  threadId: string,
  over: { input?: unknown; output?: unknown; status?: string; parent?: string } = {},
) => {
  clock += 1_000;
  const row = await f.db
    .insertInto('runs')
    .values({
      thread_id: threadId, agent_version_id: versionId, org_id: f.orgId,
      namespace_id: f.namespaceId, tenant_ref: f.tenantRef, durability: 'strict',
      initiator: 'api', caller_principal_id: f.principalId,
      status: (over.status ?? 'queued') as never,
      input: JSON.stringify(over.input ?? null),
      output: over.output === undefined ? null : JSON.stringify(over.output),
      created_at: new Date(clock),
      ended_at: ['completed', 'failed'].includes(over.status ?? '') ? new Date(clock + 500) : null,
      ...(over.parent
        ? { parent_run_id: over.parent, root_run_id: over.parent, delegation_depth: 1 }
        : {}),
    })
    .returning(['id', 'thread_id', 'parent_run_id']).executeTakeFirstOrThrow();
  return row;
};

describe('loadThreadHistory', () => {
  it("hands a second run the first run's prompt and reply, in order", async () => {
    const t = await newThread();
    await addRun(t, {
      input: 'Create a new workflow called cart_recovery_002',
      output: { text: 'Created workflow 19940.' },
      status: 'completed',
    });
    const second = await addRun(t, { input: 'Add a prompt node before we call bolna' });

    const turns = await loadThreadHistory(f.db, second);

    expect(turns).toEqual([
      { role: 'user', content: 'Create a new workflow called cart_recovery_002' },
      { role: 'assistant', content: 'Created workflow 19940.' },
    ]);
  });

  it('is empty for the first run on a thread', async () => {
    const t = await newThread();
    const only = await addRun(t, { input: 'hello' });
    expect(await loadThreadHistory(f.db, only)).toEqual([]);
  });

  it('uses delivered content only: a failed run contributes its input, never an answer', async () => {
    const t = await newThread();
    await addRun(t, { input: 'try this', output: { text: 'half-generated' }, status: 'failed' });
    const current = await addRun(t, { input: 'again' });

    const turns = await loadThreadHistory(f.db, current);
    expect(turns).toEqual([{ role: 'user', content: 'try this' }]);
  });

  it('excludes the current run, later runs, and delegated children', async () => {
    const t = await newThread();
    const first = await addRun(t, { input: 'q1', output: { text: 'a1' }, status: 'completed' });
    await addRun(t, { input: 'child task', output: { text: 'child out' }, status: 'completed', parent: first.id });
    const current = await addRun(t, { input: 'q2' });
    await addRun(t, { input: 'q3 (later)' });

    const turns = await loadThreadHistory(f.db, current);
    expect(turns.map((m) => m.content)).toEqual(['q1', 'a1']);
    // A child run is not a turn of the conversation, and gets no history of its own.
    const child = await addRun(t, { input: 'another child', parent: first.id });
    expect(await loadThreadHistory(f.db, child)).toEqual([]);
  });

  it('is bounded to the last N messages', async () => {
    const t = await newThread();
    for (let i = 0; i < 15; i++) {
      await addRun(t, { input: `q${i}`, output: { text: `a${i}` }, status: 'completed' });
    }
    const current = await addRun(t, { input: 'now' });

    const turns = await loadThreadHistory(f.db, current);
    expect(turns).toHaveLength(THREAD_HISTORY_MAX_MESSAGES);
    expect(turns[0]).toEqual({ role: 'user', content: 'q5' });
    expect(turns[turns.length - 1]).toEqual({ role: 'assistant', content: 'a14' });

    const four = await loadThreadHistory(f.db, current, { maxMessages: 4, maxChars: 10_000, maxMessageChars: 1_000 });
    expect(four.map((m) => m.content)).toEqual(['q13', 'a13', 'q14', 'a14']);
    expect(await loadThreadHistory(f.db, current, { maxMessages: 0, maxChars: 1, maxMessageChars: 1 })).toEqual([]);
  });
});

describe('boundHistory', () => {
  const pairs = (n: number) =>
    Array.from({ length: n }, (_, i) => [
      { role: 'user' as const, content: `q${i}` },
      { role: 'assistant' as const, content: `a${i}` },
    ]).flat();

  it('keeps the newest turns within a character budget and never starts on a reply', () => {
    const kept = boundHistory(pairs(10), { maxMessages: 100, maxChars: 7, maxMessageChars: 100 });
    // Budget fits a4,q4... newest-first: a9,q9,a8 (6 chars) then q8 would be 8 > 7.
    // An orphaned leading reply is dropped.
    expect(kept).toEqual([{ role: 'user', content: 'q9' }, { role: 'assistant', content: 'a9' }]);
  });

  it('truncates one oversized turn instead of dropping the whole history', () => {
    const big = 'x'.repeat(50);
    const kept = boundHistory(
      [{ role: 'user', content: 'q' }, { role: 'assistant', content: big }],
      { maxMessages: 10, maxChars: 1_000, maxMessageChars: 10 },
    );
    expect(kept).toHaveLength(2);
    expect(kept[1]!.content.startsWith('x'.repeat(10))).toBe(true);
    expect(kept[1]!.content).toContain('truncated 40 chars');
  });

  it('renders structured content as JSON, as the messages endpoint projects it', () => {
    const projected = projectThreadMessages([
      { id: 'r', status: 'completed', input: { prompt: 'hi' }, output: { data: 1 }, created_at: new Date(), ended_at: null },
    ]);
    expect(boundHistory(projected)).toEqual([
      { role: 'user', content: '{"prompt":"hi"}' },
      { role: 'assistant', content: '{"data":1}' },
    ]);
  });
});

describe('dedupeRecalled', () => {
  const history = [
    { role: 'user' as const, content: 'the window is Thursday' },
    { role: 'assistant' as const, content: 'Noted.' },
  ];

  it('drops conversational recall that the transcript already carries', () => {
    const recalled = [
      { tier: 'conversational', content: 'the window is Thursday', provenance: 'user_input', trusted: true, score: 1 },
      { tier: 'conversational', content: 'an older turn', provenance: 'user_input', trusted: true, score: 0.5 },
      { tier: 'episodic', content: 'Noted.', provenance: 'model_output', trusted: true, score: 0.4 },
    ];
    expect(dedupeRecalled(recalled, history).map((r) => r.content)).toEqual(['an older turn', 'Noted.']);
  });

  it('leaves recall untouched when there is no history', () => {
    const recalled = [{ tier: 'conversational', content: 'x', provenance: 'user_input', trusted: true, score: 1 }];
    expect(dedupeRecalled(recalled, [])).toBe(recalled);
  });
});

describe('spec.thread.history is opt-in', () => {
  const seed = async () => {
    const t = await newThread();
    await addRun(t, { input: 'earlier question', output: { text: 'earlier answer' }, status: 'completed' });
    return addRun(t, { input: 'follow-up' });
  };

  it('injects nothing by default, or for none / memory -- the run is as before', async () => {
    const current = await seed();
    expect(await threadHistoryFor(f.db, current, undefined)).toEqual([]);
    expect(await threadHistoryFor(f.db, current, { history: 'none', maxMessages: 20, maxChars: 8_000 })).toEqual([]);
    expect(await threadHistoryFor(f.db, current, { history: 'memory', maxMessages: 20, maxChars: 8_000 })).toEqual([]);
  });

  it('injects the bounded transcript for transcript', async () => {
    const current = await seed();
    expect(await threadHistoryFor(f.db, current, { history: 'transcript', maxMessages: 20, maxChars: 8_000 }))
      .toEqual([
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ]);
    // maxMessages 1 keeps only the newest message, a reply -- which is dropped rather than
    // handed over without the question it answered.
    expect(await threadHistoryFor(f.db, current, { history: 'transcript', maxMessages: 1, maxChars: 8_000 }))
      .toEqual([]);
    // maxChars keeps the newest turns that fit.
    expect(await threadHistoryFor(f.db, current, { history: 'transcript', maxMessages: 20, maxChars: 14 }))
      .toEqual([]);
    expect(await threadHistoryFor(f.db, current, { history: 'transcript', maxMessages: 20, maxChars: 30 }))
      .toEqual([
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ]);
  });

  it('leaves a spec that does not mention it, and its hash, unchanged', () => {
    const base = { model: { ref: 'internal/echo' } };
    const parsed = agentSpecSchema.parse(base);
    expect('thread' in parsed).toBe(false);

    const optedIn = agentSpecSchema.parse({ ...base, thread: { history: 'transcript' } });
    expect(optedIn.thread).toEqual({ history: 'transcript', maxMessages: 20, maxChars: 8_000 });
    // In the content address: opting in is a different version.
    expect(stableHash(optedIn)).not.toBe(stableHash(parsed));
    expect(() => agentSpecSchema.parse({ ...base, thread: { history: 'everything' } })).toThrow();
  });
});
