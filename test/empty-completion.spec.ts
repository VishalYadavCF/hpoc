import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelGateway } from '../src/domain/model-gateway/model-gateway.service.js';
import { EchoProvider } from '../src/adapters/providers/echo.provider.js';
import { CredentialBroker } from '../src/domain/identity/credential-broker.service.js';
import { InMemoryResponseCache } from '../src/adapters/cache/in-memory.response-cache.js';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { EnvSecretStore } from '../src/adapters/secrets/env.secret-store.js';
import { PlatformError } from '../src/domain/errors/platform.errors.js';
import type { ModelProvider, ModelResponse } from '../src/domain/ports/model-provider.port.js';
import { fixture, makeRun, type Fixture } from './fixtures.js';

/**
 * An empty completion -- no text, no tool call -- is a provider failure, not an answer.
 *
 * Gemini returns one intermittently (0 output tokens, finishReason MALFORMED_FUNCTION_CALL). It
 * used to reach the framework, which read "no tool call" as "done": the run completed with an
 * empty answer and an A2A caller was told a create request had succeeded when nothing ran.
 */
let f: Fixture;
let gateway: ModelGateway;
let uow: UnitOfWork;
let runId: string;
let stepId: string;
const SUFFIX = Math.random().toString(36).slice(2, 8);

/** Returns `empties` empty completions, then a real one. */
class EmptyThenAnswers implements ModelProvider {
  calls = 0;
  constructor(readonly id: string, private readonly empties: number) {}
  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls <= this.empties) {
      return { text: '', inputTokens: 7481, outputTokens: 0, finishReason: 'MALFORMED_FUNCTION_CALL' };
    }
    return { text: 'a real answer', inputTokens: 10, outputTokens: 3 };
  }
}

const args = () => ({
  modelId: f.modelId,
  agentDataClass: 'internal' as const,
  request: { prompt: `hello ${SUFFIX}` },
  orgId: f.orgId,
  runId,
  stepId,
  workloadIdentityId: f.principalId,
  onBehalfOfPrincipalId: null,
  tenantRef: f.tenantRef,
});

const withProvider = async <T>(p: ModelProvider, fn: () => Promise<T>): Promise<T> => {
  gateway.register(p);
  await f.db.updateTable('models').set({ provider: p.id }).where('id', '=', f.modelId).execute();
  try {
    return await fn();
  } finally {
    await f.db.updateTable('models').set({ provider: 'echo' }).where('id', '=', f.modelId).execute();
  }
};

beforeAll(async () => {
  f = await fixture();
  uow = new UnitOfWork(f.db);
  gateway = new ModelGateway(f.db, new CredentialBroker(new EnvSecretStore()), new InMemoryResponseCache());
  gateway.register(new EchoProvider());
  runId = (await makeRun(f)).runId;
  stepId = (
    await f.db
      .insertInto('steps')
      .values({
        run_id: runId, seq: 1, kind: 'model_call', status: 'running',
        org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef,
      })
      .returning('id').executeTakeFirstOrThrow()
  ).id;
});

afterAll(async () => {
  if (!f) return;
  await f.db.deleteFrom('steps').where('run_id', '=', runId).execute();
  await f.db.deleteFrom('runs').where('id', '=', runId).execute();
  await f.close();
});

describe('empty model completions', () => {
  it('retries once and returns the second, real answer', async () => {
    const p = new EmptyThenAnswers(`empty-once-${SUFFIX}`, 1);
    const result = await withProvider(p, () => uow.run((tx) => gateway.complete({ ...args(), tx })));
    expect(p.calls).toBe(2);
    expect(result.text).toBe('a real answer');
  });

  it('fails the call rather than passing on an empty answer', async () => {
    const p = new EmptyThenAnswers(`empty-always-${SUFFIX}`, 99);
    const error = await withProvider(p, () =>
      uow.run((tx) => gateway.complete({ ...args(), tx })).catch((e: unknown) => e),
    );
    expect(p.calls).toBe(2);
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe('upstream_failure');
    expect((error as Error).message).toContain('MALFORMED_FUNCTION_CALL');
  });
});
