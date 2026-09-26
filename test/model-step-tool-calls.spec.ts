import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunLoop } from '../src/domain/run-engine/run-loop.service.js';
import { EventLog } from '../src/domain/event-log/event-log.service.js';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import type { Tx } from '../src/platform/persistence/database.js';
import type { ModelGateway } from '../src/domain/model-gateway/model-gateway.service.js';
import type { HostModelRequest, HostModelResult } from '../src/domain/ports/framework-adapter.port.js';
import { fixture, makeRun, type Fixture } from './fixtures.js';

/**
 * A model_call step records the tool calls the model asked for, not only its text.
 *
 * A turn that asks for tools usually has no text, so the step read `{"text":""}` -- and when
 * one of those calls then never became a tool_call step, nothing anywhere said it had been
 * asked for. The ids recorded are the ones handed to the framework, so a step can be matched
 * to the tool results that answer it.
 */
let f: Fixture;
let runId: string;
let versionId: string;

type RunModelStep = (
  tx: Tx, run: unknown, version: unknown, lease: unknown, stepSeq: number, request: HostModelRequest,
) => Promise<{ result: HostModelResult }>;

beforeAll(async () => {
  f = await fixture();
  ({ runId } = await makeRun(f));
  versionId = (await f.db.selectFrom('runs').select('agent_version_id').where('id', '=', runId)
    .executeTakeFirstOrThrow()).agent_version_id;
});

afterAll(async () => {
  if (!f) return;
  await f.db.deleteFrom('events').where('run_id', '=', runId).execute();
  await f.db.deleteFrom('runs').where('id', '=', runId).execute();
  await f.close();
});

describe('model_call steps (§15.1)', () => {
  it('records the requested tool calls, with the ids the framework was given', async () => {
    const gateway = {
      complete: async () => ({
        text: '',
        // One id from the provider, one it left out -- which the loop synthesises.
        toolCalls: [
          { id: 'fc-1', name: 'relay.apply', args: { dryRun: false, operations: [{ op: 'insert_node' }] } },
          { name: 'relay.validate', args: {} },
        ],
        modelId: f.modelId, fellBackFromModelId: null, provider: 'echo', cached: false,
        inputTokens: 3, outputTokens: 2, costMicros: 0,
      }),
      recordUsage: async () => undefined,
    } as unknown as ModelGateway;
    const metrics = { describe: () => undefined, observe: () => undefined };
    const unused = undefined as never;
    const loop = new RunLoop(
      f.db, unused, [], new UnitOfWork(f.db), unused, new EventLog(), unused, unused, gateway,
      unused, unused, unused, unused, unused, unused, unused, unused, metrics as never, unused,
    );

    const run = await f.db.selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
    const version = {
      id: versionId, modelId: f.modelId, dataClass: 'internal', systemPrompt: null, promptVersionId: null,
      workloadIdentityId: f.principalId, durability: 'relaxed', cache: { modelResponses: false, ttlSeconds: 0 },
    };
    const request: HostModelRequest = {
      messages: [{ role: 'user', content: 'apply it for real' }],
      systemPrompt: null,
      tools: [{ name: 'relay.apply', description: 'Apply', parameters: { type: 'object' } }],
    };

    const runModelStep = (loop as unknown as { runModelStep: RunModelStep }).runModelStep.bind(loop);
    const { result } = await new UnitOfWork(f.db).run((tx) => runModelStep(tx, run, version, null, 1, request));

    const expected = [
      { id: 'fc-1', name: 'relay.apply', args: { dryRun: false, operations: [{ op: 'insert_node' }] } },
      { id: 'call_1_1', name: 'relay.validate', args: {} },
    ];
    expect(result.toolCalls).toEqual(expected);

    const step = await f.db.selectFrom('steps').select(['kind', 'status', 'output'])
      .where('run_id', '=', runId).where('seq', '=', 1).executeTakeFirstOrThrow();
    expect(step).toMatchObject({ kind: 'model_call', status: 'succeeded' });
    expect(step.output).toEqual({ text: '', toolCalls: expected });
  });
});
