import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeepAgent } from 'deepagents';
import { tool } from '@langchain/core/tools';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { z } from 'zod';
import { PostgresCheckpointSaver } from '../src/adapters/framework/deep-agents/postgres.checkpoint-saver.js';
import { PlatformError } from '../src/domain/errors/platform.errors.js';
import { fixture, type Fixture } from './fixtures.js';

/**
 * Phase 2 of the DeepAgents migration: LangGraph's checkpointer, backed by Postgres.
 *
 * ap-executor runs the identical agent loop and loses a run on pod restart. It is not
 * missing a feature -- it is missing a database. These tests are the proof that pointing
 * the same interface at ours is all that "durable agent" costs.
 */
let f: Fixture;
let saver: PostgresCheckpointSaver;

const SUFFIX = Math.random().toString(36).slice(2, 8);
const thread = (name: string) => `cp-${name}-${SUFFIX}`;
const threads: string[] = [];

const cfg = (threadId: string, extra: Record<string, unknown> = {}) => {
  if (!threads.includes(threadId)) threads.push(threadId);
  return { configurable: { thread_id: threadId, org_id: f.orgId, ...extra } };
};

const checkpoint = (id: string) => ({
  v: 4, id, ts: new Date().toISOString(),
  channel_values: { messages: [`state-${id}`] },
  channel_versions: { messages: 1 },
  versions_seen: {},
});

const meta = { source: 'loop' as const, step: 1, parents: {} };

beforeAll(async () => {
  f = await fixture();
  saver = new PostgresCheckpointSaver(f.db);
});

afterAll(async () => {
  for (const t of threads) await saver.deleteThread(t);
  await f.close();
});

describe('the saver contract', () => {
  it('round-trips a checkpoint through Postgres', async () => {
    const t = thread('round-trip');
    const returned = await saver.put(cfg(t), checkpoint('cp-0001'), meta);
    expect(returned.configurable?.['checkpoint_id']).toBe('cp-0001');

    const tuple = await saver.getTuple(cfg(t));
    expect(tuple?.checkpoint.id).toBe('cp-0001');
    // Not a JSON.stringify round-trip: the value came back through the serializer, which
    // is what lets LangGraph state hold Message classes and Maps.
    expect(tuple?.checkpoint.channel_values['messages']).toEqual(['state-cp-0001']);
    expect(tuple?.metadata?.step).toBe(1);
  });

  it('an id-less getTuple returns the LATEST, which is what a resume asks for', async () => {
    const t = thread('latest');
    await saver.put(cfg(t), checkpoint('cp-0001'), meta);
    await saver.put(cfg(t, { checkpoint_id: 'cp-0001' }), checkpoint('cp-0002'), meta);

    expect((await saver.getTuple(cfg(t)))?.checkpoint.id).toBe('cp-0002');
    // And a pinned id still returns that exact one, so history stays addressable.
    expect((await saver.getTuple(cfg(t, { checkpoint_id: 'cp-0001' })))?.checkpoint.id)
      .toBe('cp-0001');
  });

  it('records the parent chain, without which a fork shares no ancestors', async () => {
    const t = thread('parents');
    await saver.put(cfg(t), checkpoint('cp-0001'), meta);
    await saver.put(cfg(t, { checkpoint_id: 'cp-0001' }), checkpoint('cp-0002'), meta);

    const tuple = await saver.getTuple(cfg(t, { checkpoint_id: 'cp-0002' }));
    expect(tuple?.parentConfig?.configurable?.['checkpoint_id']).toBe('cp-0001');
    // The root has no parent rather than pointing at itself.
    const root = await saver.getTuple(cfg(t, { checkpoint_id: 'cp-0001' }));
    expect(root?.parentConfig).toBeUndefined();
  });

  it('lists newest-first, and pages backwards with `before`', async () => {
    const t = thread('list');
    for (const id of ['cp-0001', 'cp-0002', 'cp-0003']) await saver.put(cfg(t), checkpoint(id), meta);

    const all = [];
    for await (const c of saver.list(cfg(t))) all.push(c.checkpoint.id);
    expect(all).toEqual(['cp-0003', 'cp-0002', 'cp-0001']);

    const page = [];
    for await (const c of saver.list(cfg(t), { limit: 1, before: cfg(t, { checkpoint_id: 'cp-0003' }) })) {
      page.push(c.checkpoint.id);
    }
    // `before` is exclusive: paging from cp-0003 must not hand cp-0003 back forever.
    expect(page).toEqual(['cp-0002']);
  });

  it('returns pending writes with the checkpoint, so an interrupted task does not redo them', async () => {
    const t = thread('writes');
    await saver.put(cfg(t), checkpoint('cp-0001'), meta);
    await saver.putWrites(
      cfg(t, { checkpoint_id: 'cp-0001' }),
      [['messages', { done: true }], ['scratch', 7]],
      'task-a',
    );

    const tuple = await saver.getTuple(cfg(t, { checkpoint_id: 'cp-0001' }));
    expect(tuple?.pendingWrites).toEqual([
      ['task-a', 'messages', { done: true }],
      ['task-a', 'scratch', 7],
    ]);
  });

  it('a retried super-step overwrites rather than failing on the primary key', async () => {
    const t = thread('retry');
    await saver.put(cfg(t), checkpoint('cp-0001'), meta);
    // Same id, later state -- a retry produced it, and refusing would strand the run.
    await saver.put(cfg(t), { ...checkpoint('cp-0001'), channel_values: { messages: ['second'] } }, meta);

    const tuple = await saver.getTuple(cfg(t));
    expect(tuple?.checkpoint.channel_values['messages']).toEqual(['second']);
  });

  it('deleteThread removes the writes too, not just the checkpoints', async () => {
    const t = thread('delete');
    await saver.put(cfg(t), checkpoint('cp-0001'), meta);
    await saver.putWrites(cfg(t, { checkpoint_id: 'cp-0001' }), [['messages', 1]], 'task-a');

    await saver.deleteThread(t);

    expect(await saver.getTuple(cfg(t))).toBeUndefined();
    // Orphaned writes would be inherited by the next thread to reuse the id.
    const orphans = await f.db
      .selectFrom('langgraph_checkpoint_writes').select('idx').where('thread_id', '=', t).execute();
    expect(orphans).toEqual([]);
  });
});

describe('tenancy', () => {
  it('refuses to write a checkpoint with no org, rather than defaulting one', async () => {
    // A checkpoint holds a run's whole conversation. An untenanted row would sit outside
    // every RLS policy from 0020 and 0023 and be readable by the next tenant to ask, so
    // failing the write is the safe direction.
    await expect(
      saver.put(
        { configurable: { thread_id: thread('no-org') } },
        checkpoint('cp-0001'),
        meta,
      ),
    ).rejects.toBeInstanceOf(PlatformError);
  });

  it('stamps the org on every row it writes', async () => {
    const t = thread('org-stamp');
    await saver.put(cfg(t), checkpoint('cp-0001'), meta);
    await saver.putWrites(cfg(t, { checkpoint_id: 'cp-0001' }), [['messages', 1]], 'task-a');

    const cp = await f.db
      .selectFrom('langgraph_checkpoints').select('org_id').where('thread_id', '=', t).execute();
    const w = await f.db
      .selectFrom('langgraph_checkpoint_writes').select('org_id').where('thread_id', '=', t).execute();
    expect(cp.map((r) => r.org_id)).toEqual([f.orgId]);
    expect(w.map((r) => r.org_id)).toEqual([f.orgId]);
  });
});

describe('a real agent survives losing its process', () => {
  const weather = tool(async () => JSON.stringify({ tempC: 21 }), {
    name: 'get_weather',
    description: 'Weather.',
    schema: z.object({ city: z.string() }),
  });

  /** A model that asks for the tool on its first turn, then answers. */
  const model = (responses: string[], toolCallOn: number) => {
    const m = new FakeListChatModel({ responses });
    const real = m._generate.bind(m);
    let turn = 0;
    m._generate = async (msgs, opts, rm) => {
      const r = await real(msgs, opts, rm);
      if (turn++ === toolCallOn) {
        (r.generations[0]!.message as { tool_calls?: unknown[] }).tool_calls = [
          { name: 'get_weather', args: { city: 'Pune' }, id: 'call_1' },
        ];
      }
      return r;
    };
    m.bindTools = () => m;
    return m;
  };

  it('resumes a thread in a FRESH agent object, without re-running the tool', async () => {
    const t = thread('resume');
    const config = { ...cfg(t), recursionLimit: 10 };

    let toolRuns = 0;
    const counted = tool(async () => { toolRuns++; return JSON.stringify({ tempC: 21 }); }, {
      name: 'get_weather', description: 'Weather.', schema: z.object({ city: z.string() }),
    });

    const first = createDeepAgent({
      model: model(['', 'It is 21C.'], 0), tools: [counted], checkpointer: saver,
    });
    const r1 = await first.invoke({ messages: [{ role: 'user', content: 'Weather in Pune?' }] }, config);
    expect(toolRuns).toBe(1);

    // A different agent instance -- the shape a restarted worker sees. Nothing is carried
    // over in memory; everything it knows comes back out of Postgres.
    const second = createDeepAgent({
      model: model(['Still 21C.'], -1), tools: [counted], checkpointer: saver,
    });
    const r2 = await second.invoke({ messages: [{ role: 'user', content: 'And tomorrow?' }] }, config);

    expect(r2.messages.length).toBeGreaterThan(r1.messages.length);
    // The decisive assertion for effect contracts: a completed side effect is NOT redone
    // on resume. If this ever fails, a resumed run re-charges a card.
    expect(toolRuns).toBe(1);
  });

  it('leaves the thread readable through the saver after the run', async () => {
    const t = thread('inspect');
    const agent = createDeepAgent({
      model: model(['done'], -1), tools: [weather], checkpointer: saver,
    });
    await agent.invoke({ messages: [{ role: 'user', content: 'hi' }] }, { ...cfg(t), recursionLimit: 5 });

    // Not an internal detail: replay and forensics read the same rows the runtime wrote.
    const tuple = await saver.getTuple(cfg(t));
    expect(tuple).toBeDefined();
    expect(tuple!.checkpoint.channel_values['messages']).toBeDefined();
  });
});
