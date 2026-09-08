import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReplayService } from '../src/domain/run-engine/replay.service.js';
import { EventLog } from '../src/domain/event-log/event-log.service.js';
import { EventType } from '../src/domain/event-log/taxonomy.js';
import { registerAllUpcasters } from '../src/domain/event-log/upcasters/index.js';
import { NotFound } from '../src/domain/errors/platform.errors.js';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { runInContext } from '../src/platform/context/platform-context.js';
import { fixture, makeRun, type Fixture } from './fixtures.js';

// The endpoint lifts historical payloads exactly as the read path does, so the same
// upcaster registry has to be loaded.
registerAllUpcasters();

let f: Fixture;
let replay: ReplayService;
let runId: string;
let threadId: string;
let agentVersionId: string;

const SUFFIX = Math.random().toString(36).slice(2, 8);

const ctx = <T>(fn: () => Promise<T>): Promise<T> =>
  runInContext(
    {
      orgId: f.orgId, namespaceId: f.namespaceId, tenantRef: f.tenantRef,
      callerPrincipalId: f.principalId, onBehalfOfPrincipalId: null,
      authorizingHumanId: null, delegationChain: [],
      traceId: `replay-${SUFFIX}`, correlationId: `replay-${SUFFIX}`,
    },
    fn,
  );

/** Writes a run whose event log tells a complete, ordinary story. */
beforeAll(async () => {
  f = await fixture();
  replay = new ReplayService(f.db);
  const uow = new UnitOfWork(f.db);
  const events = new EventLog();

  const made = await makeRun(f);
  runId = made.runId;
  threadId = made.threadId;
  agentVersionId = (
    await f.db.selectFrom('runs').select('agent_version_id').where('id', '=', runId).executeTakeFirstOrThrow()
  ).agent_version_id;

  const base = {
    runId, threadId, agentVersionId,
    orgId: f.orgId, namespaceId: f.namespaceId, tenantRef: f.tenantRef,
  };
  await uow.run(async (tx) => {
    await events.append(tx, { ...base, type: EventType.RunStarted, payload: {} });
    await events.append(tx, { ...base, type: EventType.StepStarted, payload: { seq: 1, kind: 'model_call' } });
    await events.append(tx, {
      ...base,
      type: EventType.ModelCompleted,
      payload: { seq: 1, inputTokens: 100, outputTokens: 20, costMicros: 300 },
    });
    await events.append(tx, { ...base, type: EventType.StepCompleted, payload: { seq: 1 } });
    await events.append(tx, { ...base, type: EventType.RunCompleted, payload: { output: { answer: 42 } } });
  });

  // The stored row, as the run loop would have left it. Replay compares against this.
  await f.db
    .updateTable('runs')
    .set({
      status: 'completed', step_count: 1, input_tokens: '100', output_tokens: '20',
      cost_micros: '300', output: JSON.stringify({ answer: 42 }), ended_at: new Date(),
    })
    .where('id', '=', runId)
    .execute();
});

afterAll(async () => {
  await f.db.deleteFrom('events').where('run_id', '=', runId).execute();
  await f.db.deleteFrom('runs').where('id', '=', runId).execute();
  await f.db.deleteFrom('threads').where('id', '=', threadId).execute();
  await f.close();
});

describe('POST /v1/replay — run reconstruction (§0.2)', () => {
  it('reconstructs the run from its event log alone', async () => {
    const result = await ctx(() => replay.replay(runId));

    expect(result.eventsReplayed).toBe(5);
    expect(result.projection.status).toBe('completed');
    expect(result.projection.stepCount).toBe(1);
    expect(result.projection.inputTokens).toBe(100);
    expect(result.projection.outputTokens).toBe(20);
    expect(result.projection.costMicros).toBe(300);
    expect(result.projection.output).toEqual({ answer: 42 });
    expect(result.projection.steps).toEqual([
      { seq: 1, kind: 'model_call', status: 'succeeded', costMicros: 300 },
    ]);
  });

  it('agrees with the stored row, and says so', async () => {
    const result = await ctx(() => replay.replay(runId));
    expect(result.divergences).toEqual([]);
    expect(result.consistent).toBe(true);
  });

  it('reports divergence when the log and the table tell different stories', async () => {
    // The corruption §0.2 exists to catch. No other surface here would show it: the run
    // reads as a healthy completed run everywhere else.
    await f.db.updateTable('runs').set({ step_count: 7 }).where('id', '=', runId).execute();
    try {
      const result = await ctx(() => replay.replay(runId));
      expect(result.consistent).toBe(false);
      expect(result.divergences).toContainEqual({ field: 'stepCount', replayed: 1, stored: 7 });
    } finally {
      await f.db.updateTable('runs').set({ step_count: 1 }).where('id', '=', runId).execute();
    }
  });

  it('replays only up to a cursor, for bisecting where a run went wrong', async () => {
    // Through the model call but before the step and run completed.
    const result = await ctx(() => replay.replay(runId, 3));
    expect(result.eventsReplayed).toBe(3);
    expect(result.throughSeq).toBe(3);
    // Mid-run: the run had started and the step had not yet been marked done.
    expect(result.projection.status).toBe('running');
    expect(result.projection.steps[0]!.status).toBe('running');
    // A partial replay legitimately disagrees with the final stored row, and the
    // divergence report must not present that as corruption to a reader who asked for it.
    expect(result.divergences.some((d) => d.field === 'status')).toBe(true);
  });

  it('reports which schema versions the log still contains', async () => {
    const result = await ctx(() => replay.replay(runId));
    expect(result.schemaVersionsSeen.length).toBeGreaterThan(0);
    // Every version present must have had an upcast path, or the projection would have
    // thrown rather than reaching here -- that is §0.2's gate, per run.
    expect(result.schemaVersionsSeen.every((v) => v >= 1)).toBe(true);
  });

  it('never re-executes: replaying twice is byte-identical and touches nothing', async () => {
    const first = await ctx(() => replay.replay(runId));
    const second = await ctx(() => replay.replay(runId));
    expect(second.projection).toEqual(first.projection);
    expect(second.eventsReplayed).toBe(first.eventsReplayed);

    // No new events, no new steps, no cost: a replay that called a model or a tool would
    // show up here immediately.
    const after = await f.db
      .selectFrom('runs').select(['cost_micros', 'step_count', 'last_event_seq'])
      .where('id', '=', runId).executeTakeFirstOrThrow();
    expect(after.cost_micros).toBe('300');
    expect(after.step_count).toBe(1);
    expect(Number(after.last_event_seq)).toBe(5);
  });

  it('refuses a run belonging to another tenant', async () => {
    const other = <T>(fn: () => Promise<T>): Promise<T> =>
      runInContext(
        {
          orgId: f.orgId, namespaceId: f.namespaceId, tenantRef: `not-${f.tenantRef}`,
          callerPrincipalId: f.principalId, onBehalfOfPrincipalId: null,
          authorizingHumanId: null, delegationChain: [],
          traceId: `replay-other-${SUFFIX}`, correlationId: `replay-other-${SUFFIX}`,
        },
        fn,
      );
    // A 404 rather than an empty projection: replaying another tenant's run would expose
    // its inputs, outputs and tool arguments wholesale.
    await expect(other(() => replay.replay(runId))).rejects.toBeInstanceOf(NotFound);
  });
});
