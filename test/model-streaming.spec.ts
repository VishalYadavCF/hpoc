import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ModelGateway } from '../src/domain/model-gateway/model-gateway.service.js';
import { EchoProvider } from '../src/adapters/providers/echo.provider.js';
import { OpenAiCompatibleProvider } from '../src/adapters/providers/langchain.provider.js';
import { CredentialBroker } from '../src/domain/identity/credential-broker.service.js';
import { InMemoryResponseCache } from '../src/adapters/cache/in-memory.response-cache.js';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { EnvSecretStore } from '../src/adapters/secrets/env.secret-store.js';
import { PlatformError } from '../src/domain/errors/platform.errors.js';
import type { ModelProvider, ModelRequest, ModelResponse, ModelStreamChunk } from '../src/domain/ports/model-provider.port.js';
import { fixture, makeRun, type Fixture } from './fixtures.js';

let f: Fixture;
let gateway: ModelGateway;
let uow: UnitOfWork;
let runId: string;
let stepId: string;
let sse: Server;
let ssePort = 0;

const SUFFIX = Math.random().toString(36).slice(2, 8);
/** What the fake SSE endpoint will emit, so each test can shape the stream it needs. */
let sseScript: { frames: string[]; status: number } = { frames: [], status: 200 };

const drain = async (chunks: AsyncIterable<ModelStreamChunk>): Promise<string> => {
  let text = '';
  for await (const c of chunks) text += c.textDelta ?? '';
  return text;
};

/** A provider with no `stream()` at all — the shim's whole reason to exist. */
class WholeResponseOnly implements ModelProvider {
  readonly id = 'whole-only';
  calls = 0;
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    return { text: `whole:${request.prompt}`, inputTokens: 7, outputTokens: 11 };
  }
}

/** Fails on the first token, to exercise the before-first-chunk fallback rule. */
class FailsImmediately implements ModelProvider {
  readonly id = 'fails-immediately';
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<ModelStreamChunk> {
    throw new PlatformError('upstream_failure', 'provider exploded');
  }
  async complete(): Promise<ModelResponse> {
    throw new PlatformError('upstream_failure', 'provider exploded');
  }
}

/** Emits one chunk, THEN fails — the case where falling back would repeat the sentence. */
class FailsMidStream implements ModelProvider {
  readonly id = 'fails-mid';
  async *stream(): AsyncIterable<ModelStreamChunk> {
    yield { textDelta: 'the first half ' };
    throw new PlatformError('upstream_failure', 'died mid-sentence');
  }
  async complete(): Promise<ModelResponse> {
    throw new PlatformError('upstream_failure', 'died mid-sentence');
  }
}

const streamArgs = (over: Record<string, unknown> = {}) => ({
  modelId: f.modelId,
  agentDataClass: 'internal' as const,
  request: { prompt: `hello ${SUFFIX}` },
  orgId: f.orgId,
  runId,
  stepId,
  workloadIdentityId: f.principalId,
  onBehalfOfPrincipalId: null,
  tenantRef: f.tenantRef,
  ...over,
});

beforeAll(async () => {
  f = await fixture();
  uow = new UnitOfWork(f.db);
  gateway = new ModelGateway(f.db, new CredentialBroker(new EnvSecretStore()), new InMemoryResponseCache());
  gateway.register(new EchoProvider());

  const made = await makeRun(f);
  runId = made.runId;
  const step = await f.db
    .insertInto('steps')
    .values({
      run_id: runId, seq: 1, kind: 'model_call', status: 'running',
      org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef,
    })
    .returning('id').executeTakeFirstOrThrow();
  stepId = step.id;

  sse = createServer((req, res) => {
    if (sseScript.status !== 200) {
      res.writeHead(sseScript.status);
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const frame of sseScript.frames) res.write(frame);
    res.end();
  });
  await new Promise<void>((r) => sse.listen(0, '127.0.0.1', r));
  ssePort = (sse.address() as { port: number }).port;
});

afterAll(async () => {
  if (!f) return;
  await new Promise<void>((r) => sse.close(() => r()));
  await f.db.deleteFrom('steps').where('run_id', '=', runId).execute();
  await f.db.deleteFrom('runs').where('id', '=', runId).execute();
  await f.close();
});

describe('model token streaming (§12.3 prerequisite)', () => {
  it('streams incrementally rather than in one lump', async () => {
    // The property clause-boundary chunking depends on: output arrives in pieces, so a
    // consumer can dispatch the first clause before generation finishes.
    const { chunks, settled } = await uow.run((tx) => gateway.stream({ ...streamArgs(), tx }));
    const pieces: string[] = [];
    for await (const c of chunks) if (c.textDelta) pieces.push(c.textDelta);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toContain(`hello ${SUFFIX}`);
    const result = await settled;
    expect(result.partial).toBe(false);
    expect(result.outputTokens).toBeGreaterThan(0);
  });

  it('drives a provider with no stream() through the shim, matching complete()', async () => {
    // Adding streaming to the platform must not make a non-streaming provider second-class.
    const whole = new WholeResponseOnly();
    gateway.register(whole);
    await f.db.updateTable('models').set({ provider: whole.id }).where('id', '=', f.modelId).execute();
    try {
      const { chunks, settled } = await uow.run((tx) => gateway.stream({ ...streamArgs(), tx }));
      expect(await drain(chunks)).toBe(`whole:hello ${SUFFIX}`);
      expect((await settled).partial).toBe(false);
      expect(whole.calls).toBe(1);
    } finally {
      await f.db.updateTable('models').set({ provider: 'echo' }).where('id', '=', f.modelId).execute();
    }
  });

  it('falls back when the failure precedes the first chunk', async () => {
    const failing = new FailsImmediately();
    gateway.register(failing);
    const fallback = await f.db
      .insertInto('models')
      .values({
        org_id: f.orgId, ref: `fallback-${SUFFIX}`, provider: 'echo',
        provider_model_id: 'echo-1', residency: 'internal',
      })
      .returning('id').executeTakeFirstOrThrow();
    await f.db.updateTable('models')
      .set({ provider: failing.id, fallback_model_id: fallback.id })
      .where('id', '=', f.modelId).execute();

    try {
      const { chunks, settled } = await uow.run((tx) => gateway.stream({ ...streamArgs(), tx }));
      const text = await drain(chunks);
      expect(text).toContain(`hello ${SUFFIX}`);
      const result = await settled;
      // Diagnosable without reading logs (§9).
      expect(result.fellBackFromModelId).toBe(f.modelId);
      expect(result.partial).toBe(false);
    } finally {
      await f.db.updateTable('models')
        .set({ provider: 'echo', fallback_model_id: null })
        .where('id', '=', f.modelId).execute();
      await f.db.deleteFrom('models').where('id', '=', fallback.id).execute();
    }
  });

  it('does NOT fall back after the first chunk — it ends partial instead', async () => {
    // Restarting on the fallback would replay output the caller already has; for voice
    // that is the caller hearing the sentence twice.
    const mid = new FailsMidStream();
    gateway.register(mid);
    const fallback = await f.db
      .insertInto('models')
      .values({
        org_id: f.orgId, ref: `fallback2-${SUFFIX}`, provider: 'echo',
        provider_model_id: 'echo-1', residency: 'internal',
      })
      .returning('id').executeTakeFirstOrThrow();
    await f.db.updateTable('models')
      .set({ provider: mid.id, fallback_model_id: fallback.id })
      .where('id', '=', f.modelId).execute();

    try {
      const { chunks, settled } = await uow.run((tx) => gateway.stream({ ...streamArgs(), tx }));
      const text = await drain(chunks);
      expect(text).toBe('the first half ');
      const result = await settled;
      expect(result.partial).toBe(true);
      expect(result.fellBackFromModelId).toBeNull();
    } finally {
      await f.db.updateTable('models')
        .set({ provider: 'echo', fallback_model_id: null })
        .where('id', '=', f.modelId).execute();
      await f.db.deleteFrom('models').where('id', '=', fallback.id).execute();
    }
  });

  it('never caches a partial stream', async () => {
    // A truncated answer served to the NEXT caller for a full TTL is worse than paying
    // for the call again — and unlike most bugs here, it escapes the run.
    const mid = new FailsMidStream();
    gateway.register(mid);
    await f.db.updateTable('models').set({ provider: mid.id }).where('id', '=', f.modelId).execute();
    const cache = { modelResponses: true, ttlSeconds: 60 };
    try {
      const first = await uow.run((tx) => gateway.stream({ ...streamArgs(), cache, tx }));
      await drain(first.chunks);
      expect((await first.settled).partial).toBe(true);

      // Same request again on a healthy provider: if the truncation had been cached this
      // would return "the first half " instead of a complete answer.
      await f.db.updateTable('models').set({ provider: 'echo' }).where('id', '=', f.modelId).execute();
      const second = await uow.run((tx) => gateway.stream({ ...streamArgs(), cache, tx }));
      expect(await drain(second.chunks)).toContain(`hello ${SUFFIX}`);
      expect((await second.settled).cached).toBe(false);
    } finally {
      await f.db.updateTable('models').set({ provider: 'echo' }).where('id', '=', f.modelId).execute();
    }
  });

  it('serves a cache hit as one chunk, so history is identical either way (§10)', async () => {
    const cache = { modelResponses: true, ttlSeconds: 60 };
    const prompt = `cacheable ${SUFFIX}`;
    const first = await uow.run((tx) => gateway.stream({ ...streamArgs({ request: { prompt } }), cache, tx }));
    await drain(first.chunks);
    expect((await first.settled).cached).toBe(false);

    const second = await uow.run((tx) => gateway.stream({ ...streamArgs({ request: { prompt } }), cache, tx }));
    expect(await drain(second.chunks)).toContain(prompt);
    const hit = await second.settled;
    expect(hit.cached).toBe(true);
    // A cache hit costs nothing — billing for a call that never happened would be wrong
    // in the direction that matters.
    expect(hit.costMicros).toBe(0);
  });

  it('refuses a regulated agent an external model, on the streaming path too (§16.1)', async () => {
    // The residency gate is the reason the gateway exists; a second code path that skipped
    // it would make it decorative.
    // base_url + credential_ref are required alongside: `models_external_needs_endpoint_ck`
    // refuses an external model that would fail on first use.
    await f.db.updateTable('models')
      .set({ residency: 'external', base_url: 'https://vendor.example.com', credential_ref: 'vendor' })
      .where('id', '=', f.modelId).execute();
    try {
      await expect(
        uow.run((tx) => gateway.stream({ ...streamArgs({ agentDataClass: 'regulated' }), tx })),
      ).rejects.toThrow(/regulated/);
    } finally {
      await f.db.updateTable('models')
        .set({ residency: 'internal', base_url: null, credential_ref: null })
        .where('id', '=', f.modelId).execute();
    }
  });

  it('stops generating when the signal aborts, and settles PARTIAL rather than throwing', async () => {
    // Barge-in must stop the model, not merely stop listening — otherwise the tokens keep
    // being generated and billed. But an abort after output has been delivered is not an
    // error: the caller asked for it and still needs the accounting for what it received,
    // so the stream ends cleanly and `partial` is what marks it truncated.
    const controller = new AbortController();
    const { chunks, settled } = await uow.run((tx) =>
      gateway.stream({
        ...streamArgs({ request: { prompt: 'a b c d e f g h i j k l' } }),
        signal: controller.signal,
        tx,
      }),
    );

    const seen: string[] = [];
    for await (const c of chunks) {
      seen.push(c.textDelta ?? '');
      if (seen.length === 2) controller.abort();
    }

    const result = await settled;
    expect(result.partial).toBe(true);
    // Stopped early: the full echo of that prompt is far more than a handful of chunks.
    expect(seen.length).toBeLessThan(10);
    // And the accounting reflects what was actually produced, not what was asked for.
    expect(result.text).toBe(seen.join(''));
  });

  it('rejects when the abort lands before any output', async () => {
    // Nothing was delivered, so there is nothing to settle partially — this is a clean
    // failure rather than an empty success.
    const controller = new AbortController();
    controller.abort();
    const { chunks } = await uow.run((tx) =>
      gateway.stream({ ...streamArgs(), signal: controller.signal, tx }),
    );
    await expect(drain(chunks)).rejects.toThrow();
  });
});

describe('OpenAI-compatible SSE decoding', () => {
  const provider = new OpenAiCompatibleProvider();
  const creds = () => ({ apiKey: 'k', baseUrl: `http://127.0.0.1:${ssePort}` });
  const req = { providerModelId: 'gpt-x', prompt: 'hi' };

  it('reassembles frames split mid-line across reads', async () => {
    // A TCP read boundary can land anywhere; parsing per chunk instead of per line drops
    // exactly the frame that straddles it.
    sseScript = {
      status: 200,
      frames: [
        'data: {"choices":[{"delta":{"content":"Hel',
        'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: [DONE]\n\n',
      ],
    };
    let text = '';
    for await (const c of provider.stream(req, creds())) text += c.textDelta ?? '';
    expect(text).toBe('Hello world');
  });

  it('treats [DONE] as a sentinel rather than JSON', async () => {
    // Parsing it would throw at the end of every successful stream.
    sseScript = { status: 200, frames: ['data: {"choices":[{"delta":{"content":"x"}}]}\n\n', 'data: [DONE]\n\n'] };
    let text = '';
    for await (const c of provider.stream(req, creds())) text += c.textDelta ?? '';
    expect(text).toBe('x');
  });

  it('fails the generation on an unparseable frame rather than silently truncating', async () => {
    // BEHAVIOUR CHANGE, deliberate. The hand-written decoder skipped a malformed frame
    // and carried on, so a stream that lost content still arrived looking complete --
    // the caller could not tell a whole answer from a damaged one. The vendor SDK throws,
    // which is the honest reading: we do not know what was in that frame, and a truncated
    // answer presented as a finished one is the failure mode §4.5 exists to refuse.
    sseScript = {
      status: 200,
      frames: ['data: {not json}\n\n', 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'],
    };
    await expect(
      (async () => {
        for await (const _ of provider.stream(req, creds())) { /* consume */ }
      })(),
    ).rejects.toThrow();
  });

  it('propagates a non-200 honestly rather than yielding an empty completion', async () => {
    sseScript = { status: 500, frames: [] };
    await expect(
      (async () => {
        for await (const _ of provider.stream(req, creds())) { /* consume */ }
      })(),
    ).rejects.toThrow(/500/);
  });
});
