import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { RunReadService } from '../src/domain/run-engine/run-read.service.js';
import { RunRecoveryService } from '../src/domain/run-engine/run-recovery.service.js';
import { QueueService } from '../src/domain/queue/queue.service.js';
import { EventLog } from '../src/domain/event-log/event-log.service.js';
import { runInContext } from '../src/platform/context/platform-context.js';
import { NotFound, PlatformError } from '../src/domain/errors/platform.errors.js';
import { fixture, type Fixture } from './fixtures.js';

let f: Fixture;
let reads: RunReadService;
let recovery: RunRecoveryService;
let threadId: string;
let versionId: string;
const runIds: string[] = [];

const SUFFIX = Math.random().toString(36).slice(2, 8);

const ctx = <T>(fn: () => Promise<T>, tenantRef?: string): Promise<T> =>
  runInContext(
    {
      orgId: f.orgId,
      namespaceId: f.namespaceId,
      tenantRef: tenantRef ?? f.tenantRef,
      callerPrincipalId: f.principalId,
      onBehalfOfPrincipalId: null,
      authorizingHumanId: null,
      delegationChain: [],
      traceId: `reads-${SUFFIX}`,
      correlationId: `reads-${SUFFIX}`,
    },
    fn,
  );

beforeAll(async () => {
  f = await fixture();
  reads = new RunReadService(f.db);
  const uow = new UnitOfWork(f.db);
  recovery = new RunRecoveryService(f.db, uow, new QueueService(f.db), new EventLog());

  const thread = await f.db
    .insertInto('threads')
    .values({ org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef })
    .returning('id').executeTakeFirstOrThrow();
  threadId = thread.id;

  const version = await f.db
    .insertInto('agent_versions')
    .values({
      org_id: f.orgId, namespace_id: f.namespaceId, lifetime: 'ephemeral',
      spec: JSON.stringify({ framework: 'echo' }), spec_hash: `reads-${SUFFIX}`,
      workload_identity_id: f.principalId, model_id: f.modelId,
    })
    .returning('id').executeTakeFirstOrThrow();
  versionId = version.id;

  // Five runs, inserted in order, so pagination has something ordered to walk.
  for (let i = 0; i < 5; i++) {
    const run = await f.db
      .insertInto('runs')
      .values({
        thread_id: threadId, agent_version_id: versionId, org_id: f.orgId,
        namespace_id: f.namespaceId, tenant_ref: f.tenantRef, durability: 'strict',
        initiator: 'api', caller_principal_id: f.principalId,
        status: i === 4 ? 'failed' : 'completed',
        cost_micros: String(10 * (i + 1)),
        created_at: new Date(Date.now() + i * 1000),
        // `run_terminal_ck` requires a terminal run to have an end time. The constraint
        // exists so a "completed" run with no ended_at cannot be stored, and a fixture
        // that skipped it would be storing a state the platform never produces.
        ended_at: new Date(Date.now() + i * 1000 + 500),
      })
      .returning('id').executeTakeFirstOrThrow();
    runIds.push(run.id);
  }
});

afterAll(async () => {
  if (!f) return;
  await f.db.deleteFrom('runs').where('thread_id', '=', threadId).execute();
  await f.db.deleteFrom('agent_versions').where('id', '=', versionId).execute();
  await f.db.deleteFrom('threads').where('id', '=', threadId).execute();
  await f.close();
});

describe('run listing', () => {
  it('paginates by keyset without repeating or skipping rows', async () => {
    const first = await ctx(() => reads.list({ threadId, limit: 2 }));
    expect(first.runs).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const second = await ctx(() => reads.list({ threadId, limit: 2, cursor: first.nextCursor! }));
    const third = await ctx(() => reads.list({ threadId, limit: 2, cursor: second.nextCursor! }));

    const seen = [...first.runs, ...second.runs, ...third.runs].map((r) => r.id);
    // No duplicates and nothing missed — the property OFFSET loses the moment a row is
    // inserted between requests.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(5);
    expect(third.nextCursor).toBeNull();
  });

  it('does not report a next page when the last one is exactly full', async () => {
    // The extra-row trick: asking for limit+1 is how "there is more" is known without a
    // COUNT. An off-by-one here would promise a page that comes back empty.
    const exact = await ctx(() => reads.list({ threadId, limit: 5 }));
    expect(exact.runs).toHaveLength(5);
    expect(exact.nextCursor).toBeNull();
  });

  it('ignores a malformed cursor rather than throwing', async () => {
    // A client that stored a cursor across a deploy should get page one, not a 500.
    const page = await ctx(() => reads.list({ threadId, limit: 2, cursor: 'not-a-cursor' }));
    expect(page.runs).toHaveLength(2);
  });

  it('filters by status', async () => {
    const failed = await ctx(() => reads.list({ threadId, limit: 10, status: ['failed'] }));
    expect(failed.runs).toHaveLength(1);
    expect(failed.runs[0]!.status).toBe('failed');
  });

  it('scopes to the caller’s tenant', async () => {
    const other = await ctx(() => reads.list({ threadId, limit: 10 }), 'some-other-merchant');
    // A run in another tenant is invisible, not forbidden — see assertVisible.
    expect(other.runs).toHaveLength(0);
  });
});

describe('run subresources', () => {
  it('treats another tenant’s run as absent, not forbidden', async () => {
    const error = await ctx(() => reads.usage(runIds[0]!), 'some-other-merchant').catch((e: unknown) => e);
    // 404 rather than 403: distinguishing them lets a caller enumerate run ids that exist
    // but are not theirs.
    expect(error).toBeInstanceOf(NotFound);
  });

  it('sums cost across the whole delegation tree, not just the run’s own steps', async () => {
    const child = await f.db
      .insertInto('runs')
      .values({
        thread_id: threadId, agent_version_id: versionId, org_id: f.orgId,
        namespace_id: f.namespaceId, tenant_ref: f.tenantRef, durability: 'strict',
        initiator: 'sub_agent', caller_principal_id: f.principalId,
        // `run_root_ck`: a run with a parent must also carry a root and a non-zero depth.
        // The constraint is what stops an orphaned child claiming to be a root.
        parent_run_id: runIds[0]!, root_run_id: runIds[0]!, delegation_depth: 1,
        status: 'completed', cost_micros: '500', ended_at: new Date(),
      })
      .returning('id').executeTakeFirstOrThrow();

    const usage = await ctx(() => reads.usage(runIds[0]!));
    // §13.5 makes a child spend the originating tenant's ceiling, so a usage report that
    // stopped at the run's own steps would understate a delegating agent's real cost by
    // whatever its children used — the exact number anyone asking is after.
    expect(usage.treeCostMicros).toBeGreaterThanOrEqual(500);
    expect(usage.runsInTree).toBe(2);

    await f.db.deleteFrom('runs').where('id', '=', child.id).execute();
  });

  it('names a missing step rather than returning an empty object', async () => {
    const error = await ctx(() => reads.step(runIds[0]!, 999)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFound);
  });

  it('lists tool invocations with status, arguments and result, naming offloaded payloads', async () => {
    const tool = await f.db
      .selectFrom('tools').select('id')
      .where('org_id', '=', f.orgId).where('ref', '=', 'demo.echo')
      .executeTakeFirstOrThrow();
    const artifact = async (label: string) =>
      (await f.db.insertInto('artifacts').values({
        org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef,
        content_hash: `reads-${label}-${SUFFIX}`, storage_uri: `mem://reads-${label}-${SUFFIX}`,
        media_type: 'application/json', size_bytes: '1', encryption_key_ref: 'test',
      }).returning('id').executeTakeFirstOrThrow()).id;
    const offloadedRequest = await artifact('request');
    const offloadedResponse = await artifact('response');

    // Inserted out of order, to show the list is ordered by step, not by insertion.
    for (const [seq, over] of [
      [2, {
        status: 'failed', request_artifact_id: offloadedRequest,
        response_artifact_id: offloadedResponse,
        error: JSON.stringify({ code: 'mcp_tool_error', message: 'bad op' }),
      }],
      [1, {
        status: 'succeeded', request: JSON.stringify({ q: 'm-1' }),
        response: JSON.stringify({ found: true }),
      }],
    ] as const) {
      const step = await f.db
        .insertInto('steps')
        .values({
          run_id: runIds[3]!, seq, kind: 'tool_call', status: over.status,
          org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef,
        })
        .returning('id').executeTakeFirstOrThrow();
      await f.db.insertInto('tool_invocations').values({
        step_id: step.id, run_id: runIds[3]!, thread_id: threadId,
        org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef,
        tool_id: tool.id, origin: 'http', effects: ['read_only'],
        tool_version: 1, sandbox_profile: 'http-egress', ...over,
      }).execute();
    }

    const rows = await ctx(() => reads.toolInvocations(runIds[3]!));
    expect(rows.map((r) => r.step_seq)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({
      tool_ref: 'demo.echo', status: 'succeeded',
      request: { q: 'm-1' }, request_artifact_id: null,
      response: { found: true }, response_artifact_id: null, error: null,
    });
    // An offloaded payload is named by its artifact, not inlined.
    expect(rows[1]).toMatchObject({
      status: 'failed',
      request: null, request_artifact_id: offloadedRequest,
      response: null, response_artifact_id: offloadedResponse,
      error: { code: 'mcp_tool_error', message: 'bad op' },
    });

    await f.db.deleteFrom('artifacts').where('id', 'in', [offloadedRequest, offloadedResponse]).execute();
  });

  it('says so when there is no lineage, rather than implying a gap in the trace', async () => {
    const lineage = await ctx(() => reads.lineage(runIds[0]!));
    expect(lineage.edges).toEqual([]);
    expect(String(lineage.note)).toMatch(/not a gap/);
  });
});

describe('fork (§4.2)', () => {
  it('refuses to fork a run with no checkpoint', async () => {
    const error = await ctx(() => recovery.previewFork(runIds[0]!, {})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe('invalid_transition');
  });

  it('rounds the fork point DOWN to a real checkpoint', async () => {
    for (const seq of [1, 3]) {
      await f.db.insertInto('checkpoints').values({
        run_id: runIds[1]!, step_seq: seq, schema_version: 1,
        state: JSON.stringify({ adapterState: { phase: `at-${seq}` }, stepSeq: seq }),
        state_hash: `hash-${seq}-${SUFFIX}`, durability: 'strict',
      }).execute();
    }

    // Asking for step 2 must resume from 1, never 3: a run checkpoints at step
    // boundaries, so rounding UP would resume from state step 2 had not reached.
    const preview = await ctx(() => recovery.previewFork(runIds[1]!, { atStepSeq: 2 }));
    expect(preview.forkPoint.stepSeq).toBe(1);
  });

  it('refuses without acknowledgement when it would repeat an unreplayable effect', async () => {
    const step = await f.db
      .insertInto('steps')
      .values({
        run_id: runIds[1]!, seq: 2, kind: 'tool_call', status: 'succeeded',
        org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef,
      })
      .returning('id').executeTakeFirstOrThrow();
    const tool = await f.db
      .selectFrom('tools').select('id')
      .where('org_id', '=', f.orgId).where('ref', '=', 'demo.gated')
      .executeTakeFirstOrThrow();

    await f.db.insertInto('tool_invocations').values({
      step_id: step.id, run_id: runIds[1]!, thread_id: threadId,
      org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef,
      tool_id: tool.id, origin: 'http', effects: ['essential', 'idempotent'],
      tool_version: 1, sandbox_profile: 'http-egress',
    }).execute();

    const preview = await ctx(() => recovery.previewFork(runIds[1]!, { atStepSeq: 1 }));
    expect(preview.requiresAcknowledgement).toBe(true);
    expect(preview.duplicatedEffects[0]!.toolRef).toBe('demo.gated');

    const error = await ctx(() => recovery.fork({ runId: runIds[1]!, atStepSeq: 1 }))
      .catch((e: unknown) => e);
    // Nothing in a checkpoint records which side effects already fired, so the platform
    // cannot dedupe them. Refusing or making the caller say it out loud are the only
    // honest options.
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).message).toMatch(/unreplayable side effect/);
  });

  it('forks with acknowledgement, copying the checkpoint and its schema version', async () => {
    const forked = await ctx(() =>
      recovery.fork({ runId: runIds[1]!, atStepSeq: 1, acknowledgeDuplicateEffects: true }),
    );
    const newRunId = forked['runId'] as string;

    const copied = await f.db
      .selectFrom('checkpoints')
      .select(['step_seq', 'schema_version', 'parent_checkpoint_id'])
      .where('run_id', '=', newRunId)
      .executeTakeFirstOrThrow();
    expect(copied.step_seq).toBe(1);
    // §0.2: rewriting it to look current would destroy the record of what produced it.
    expect(copied.schema_version).toBe(1);
    expect(copied.parent_checkpoint_id).not.toBeNull();

    const run = await f.db
      .selectFrom('runs')
      .select(['parent_run_id', 'root_run_id', 'causation_id', 'agent_version_id'])
      .where('id', '=', newRunId)
      .executeTakeFirstOrThrow();
    // A fork is a SIBLING, not a child: as a child, wakeParent would try to resume the
    // original when the fork settled.
    expect(run.parent_run_id).toBeNull();
    expect(run.causation_id).toBe(runIds[1]);
    // Always the same version — forking onto a different one would conflate two
    // experiments and hand resumed adapter state to code that never produced it.
    expect(run.agent_version_id).toBe(versionId);

    await f.db.deleteFrom('runs').where('id', '=', newRunId).execute();
  });
});

describe('operator resume (§0.8)', () => {
  it('refuses a completed run and points at fork instead', async () => {
    const error = await ctx(() => recovery.resume(runIds[0]!, 'because I said so'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).detail['hint']).toMatch(/fork/i);
  });

  it('refuses to resume past an unresolved interaction', async () => {
    const waiting = await f.db
      .insertInto('runs')
      .values({
        thread_id: threadId, agent_version_id: versionId, org_id: f.orgId,
        namespace_id: f.namespaceId, tenant_ref: f.tenantRef, durability: 'strict',
        initiator: 'api', caller_principal_id: f.principalId, status: 'waiting',
      })
      .returning('id').executeTakeFirstOrThrow();
    await f.db.insertInto('interactions').values({
      run_id: waiting.id, thread_id: threadId, org_id: f.orgId,
      namespace_id: f.namespaceId, tenant_ref: f.tenantRef,
      kind: 'approval', prompt: JSON.stringify({ question: 'ok?' }),
      expires_at: new Date(Date.now() + 3_600_000),
    }).execute();

    const error = await ctx(() => recovery.resume(waiting.id, 'operator override attempt'))
      .catch((e: unknown) => e);
    // Resuming past a pending approval would execute the action the approval gates —
    // which is the §14 control the interaction exists to be.
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).message).toMatch(/unresolved interaction/);

    await f.db.deleteFrom('runs').where('id', '=', waiting.id).execute();
  });

  it('re-queues a dead-lettered run and marks the dead letter replayed', async () => {
    const dead = await f.db
      .insertInto('runs')
      .values({
        thread_id: threadId, agent_version_id: versionId, org_id: f.orgId,
        namespace_id: f.namespaceId, tenant_ref: f.tenantRef, durability: 'strict',
        initiator: 'api', caller_principal_id: f.principalId, status: 'dead_letter',
        error: JSON.stringify({ code: 'upstream_failure' }), ended_at: new Date(),
      })
      .returning('id').executeTakeFirstOrThrow();
    await f.db.insertInto('dead_letters').values({
      run_id: dead.id, reason: 'retries exhausted',
      error: JSON.stringify({ code: 'upstream_failure' }), attempts: 3,
    }).execute();

    const result = await ctx(() => recovery.resume(dead.id, 'upstream recovered, replaying'));
    expect(result['status']).toBe('queued');

    const letter = await f.db
      .selectFrom('dead_letters')
      .select(['acknowledged_at', 'replayed_run_id'])
      .where('run_id', '=', dead.id)
      .executeTakeFirstOrThrow();
    // Marked, not deleted: §0.8's dead letter queue is a ledger, and the record that this
    // run once failed terminally is what a post-incident review reads.
    expect(letter.acknowledged_at).not.toBeNull();
    expect(letter.replayed_run_id).toBe(dead.id);

    const queued = await f.db
      .selectFrom('run_queue').select('run_id').where('run_id', '=', dead.id).executeTakeFirst();
    expect(queued).toBeDefined();

    await f.db.deleteFrom('run_queue').where('run_id', '=', dead.id).execute();
    await f.db.deleteFrom('runs').where('id', '=', dead.id).execute();
  });
});
