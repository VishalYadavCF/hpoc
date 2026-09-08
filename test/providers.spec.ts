import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { fixture, type Fixture } from './fixtures.js';

const API = 'http://localhost:3000';
const HEADERS = {
  'content-type': 'application/json',
  'x-caller-subject': 'svc:demo-client',
  'x-namespace': 'demo',
  'x-tenant-ref': 'merchant-1',
};

interface Captured {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

let f: Fixture;
const servers: Server[] = [];
const captured: Record<string, Captured> = {};

/** A server that speaks one vendor's real response shape. */
async function fakeVendor(
  name: string,
  respond: (body: Record<string, unknown>) => unknown,
): Promise<string> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      captured[name] = { path: req.url ?? '', headers: req.headers, body };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(respond(body)));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function seedModel(ref: string, provider: string, providerModelId: string, baseUrl: string) {
  const model = await f.db
    .insertInto('models')
    .values({
      org_id: f.orgId, ref, provider, provider_model_id: providerModelId,
      // `external` exercises the constraint that an external model must name both an
      // endpoint and a credential.
      residency: 'external', base_url: baseUrl, credential_ref: 'testvendor',
      input_cost_micros_per_1k: '1000', output_cost_micros_per_1k: '2000',
    })
    .onConflict((oc) => oc.columns(['org_id', 'ref']).doUpdateSet({ base_url: baseUrl, provider }))
    .returning('id')
    .executeTakeFirstOrThrow();

  const grant = await f.db
    .selectFrom('capability_grants').select('id')
    .where('org_id', '=', f.orgId).where('resource_kind', '=', 'model')
    .where('resource_id', '=', model.id).executeTakeFirst();
  if (!grant) {
    await f.db.insertInto('capability_grants').values({
      org_id: f.orgId, grant_source: 'service', namespace_id: f.namespaceId,
      resource_kind: 'model', resource_id: model.id, granted_by: f.principalId,
    }).execute();
  }
  return model.id;
}

async function runWith(modelRef: string): Promise<Record<string, unknown>> {
  const created = (await (
    await fetch(`${API}/v1/runs`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ agent: { model: { ref: modelRef }, systemPrompt: 'be brief' }, input: 'ping' }),
    })
  ).json()) as { runId: string };

  const deadline = Date.now() + 15_000;
  for (;;) {
    const run = (await (await fetch(`${API}/v1/runs/${created.runId}`, { headers: HEADERS })).json()) as Record<string, unknown>;
    if (['completed', 'failed'].includes(run['status'] as string)) return run;
    if (Date.now() > deadline) throw new Error(`stuck in ${String(run['status'])}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  f = await fixture();
  if (!(await fetch(`${API}/healthz`).catch(() => null))?.ok) {
    throw new Error('api and worker must be running');
  }

  await seedModel('test/openai', 'openai-compatible', 'gpt-4o-mini',
    await fakeVendor('openai', () => ({
      choices: [{ message: { content: 'pong from the openai shape' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    })));

  await seedModel('test/anthropic', 'anthropic', 'claude-sonnet-4',
    await fakeVendor('anthropic', () => ({
      content: [{ type: 'text', text: 'pong from ' }, { type: 'text', text: 'the anthropic shape' }],
      usage: { input_tokens: 13, output_tokens: 9 },
    })));

  await seedModel('test/google', 'google', 'gemini-2.0-flash',
    await fakeVendor('google', () => ({
      candidates: [{ content: { parts: [{ text: 'pong from the gemini shape' }] } }],
      usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 5 },
    })));
});

afterAll(async () => {
  // These rows point at ephemeral ports that die with this file. Leaving them behind
  // makes the model registry describe endpoints that no longer exist.
  const refs = ['test/openai', 'test/anthropic', 'test/google', 'test/nosecret'];
  const ids = (
    await f.db.selectFrom('models').select('id').where('org_id', '=', f.orgId)
      .where('ref', 'in', refs).execute()
  ).map((m) => m.id);
  if (ids.length > 0) {
    await f.db.deleteFrom('capability_grants').where('resource_id', 'in', ids).execute();
    const runIds = (
      await f.db.selectFrom('runs').innerJoin('agent_versions as av', 'av.id', 'runs.agent_version_id')
        .select('runs.id').where('av.model_id', 'in', ids).execute()
    ).map((r) => r.id);
    if (runIds.length > 0) {
      await f.db.deleteFrom('events').where('run_id', 'in', runIds).execute();
      await f.db.deleteFrom('credential_grants').where('run_id', 'in', runIds).execute();
      await f.db.deleteFrom('usage_ledger').where('run_id', 'in', runIds).execute();
      await f.db.deleteFrom('tool_invocations').where('run_id', 'in', runIds).execute();
      await f.db.deleteFrom('dead_letters').where('run_id', 'in', runIds).execute();
      await f.db.deleteFrom('checkpoints').where('run_id', 'in', runIds).execute();
      await f.db.deleteFrom('steps').where('run_id', 'in', runIds).execute();
      await f.db.deleteFrom('run_queue').where('run_id', 'in', runIds).execute();
      await f.db.deleteFrom('runs').where('id', 'in', runIds).execute();
    }
    await f.db.deleteFrom('agent_versions').where('model_id', 'in', ids).execute();
    await f.db.deleteFrom('models').where('id', 'in', ids).execute();
  }
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  await f.close();
});

describe('multiple LLM providers', () => {
  it('drives a run through an OpenAI-compatible endpoint', async () => {
    const run = await runWith('test/openai');
    expect(run['status']).toBe('completed');

    const call = captured['openai']!;
    expect(call.path).toBe('/chat/completions');
    expect(call.headers.authorization).toBe('Bearer test-key-abc123');
    expect(call.body['model']).toBe('gpt-4o-mini');
    // System prompt is a message with role "system" in this family.
    expect(call.body['messages']).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'ping' },
    ]);
  });

  it('drives a run through the Anthropic Messages API', async () => {
    const run = await runWith('test/anthropic');
    expect(run['status']).toBe('completed');

    const call = captured['anthropic']!;
    expect(call.path).toBe('/messages');
    // Different auth header, not Bearer.
    expect(call.headers['x-api-key']).toBe('test-key-abc123');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    // System is a TOP-LEVEL field here, and max_tokens is required.
    expect(call.body['system']).toBe('be brief');
    expect(call.body['max_tokens']).toBeTypeOf('number');
    expect(call.body['messages']).toEqual([{ role: 'user', content: 'ping' }]);
  });

  it('drives a run through Gemini generateContent', async () => {
    const run = await runWith('test/google');
    expect(run['status']).toBe('completed');

    const call = captured['google']!;
    expect(call.path).toBe('/models/gemini-2.0-flash:generateContent');
    // Key in a header, never on the URL, so it cannot land in an access log.
    expect(call.headers['x-goog-api-key']).toBe('test-key-abc123');
    expect(call.path).not.toContain('test-key');
    expect(call.body['contents']).toEqual([{ role: 'user', parts: [{ text: 'ping' }] }]);
    expect(call.body['systemInstruction']).toEqual({ parts: [{ text: 'be brief' }] });
  });

  it('concatenates Anthropic text blocks rather than taking the first', async () => {
    const run = await runWith('test/anthropic');
    const step = await f.db
      .selectFrom('steps').select('output')
      .where('run_id', '=', run['id'] as string).where('kind', '=', 'model_call')
      .executeTakeFirstOrThrow();
    expect((step.output as { text: string }).text).toBe('pong from the anthropic shape');
  });

  it('records each provider\'s own token counts, not an approximation', async () => {
    const run = await runWith('test/google');
    const usage = await f.db
      .selectFrom('usage_ledger').select(['provider', 'input_tokens', 'output_tokens', 'cost_micros'])
      .where('run_id', '=', run['id'] as string).executeTakeFirstOrThrow();
    expect(usage.provider).toBe('google');
    expect(Number(usage.input_tokens)).toBe(17);
    expect(Number(usage.output_tokens)).toBe(5);
    // 17/1000*1000 + 5/1000*2000 = 17 + 10 = 27
    expect(Number(usage.cost_micros)).toBe(27);
  });

  it('audits the credential mint without storing the secret (§16.3)', async () => {
    const run = await runWith('test/openai');
    const grant = await f.db
      .selectFrom('credential_grants').selectAll()
      .where('run_id', '=', run['id'] as string).executeTakeFirstOrThrow();

    expect(grant.scopes).toContain('model:invoke');
    expect(grant.audience).toContain('127.0.0.1');
    expect(JSON.stringify(grant)).not.toContain('test-key-abc123');
  });

  /**
   * §16.1 Constraint 2, and the reason the gate lives in the gateway rather than in
   * admission: the only path to a provider is through `complete()`, so an agent marked
   * regulated is structurally unable to reach an external one regardless of what its
   * spec names.
   */
  it('refuses a regulated agent an external model, and never reaches the vendor', async () => {
    const before = JSON.stringify(captured['openai'] ?? {});

    const created = (await (
      await fetch(`${API}/v1/runs`, {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({
          agent: { model: { ref: 'test/openai' }, security: { dataClass: 'regulated' } },
          input: 'ping',
        }),
      })
    ).json()) as { runId: string };

    const deadline = Date.now() + 15_000;
    let run: Record<string, unknown>;
    for (;;) {
      run = (await (await fetch(`${API}/v1/runs/${created.runId}`, { headers: HEADERS })).json()) as Record<string, unknown>;
      if (['completed', 'failed'].includes(run['status'] as string)) break;
      if (Date.now() > deadline) throw new Error('stuck');
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(run['status']).toBe('failed');
    expect(JSON.stringify(run['error'])).toContain('regulated');
    // The vendor was never called: the gate is before the request, not after the response.
    expect(JSON.stringify(captured['openai'] ?? {})).toBe(before);
  });

  it('allows a regulated agent an internal model', async () => {
    const created = (await (
      await fetch(`${API}/v1/runs`, {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({
          agent: { model: { ref: 'internal/echo' }, security: { dataClass: 'regulated' } },
          input: 'ping',
        }),
      })
    ).json()) as { runId: string };

    const deadline = Date.now() + 15_000;
    for (;;) {
      const run = (await (await fetch(`${API}/v1/runs/${created.runId}`, { headers: HEADERS })).json()) as Record<string, unknown>;
      if (run['status'] === 'completed') break;
      if (run['status'] === 'failed') throw new Error(JSON.stringify(run['error']));
      if (Date.now() > deadline) throw new Error('stuck');
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  it('fails before building a request when the secret is missing', async () => {
    await seedModel('test/nosecret', 'openai-compatible', 'x', 'http://127.0.0.1:1');
    await f.db.updateTable('models').set({ credential_ref: 'absent-vendor' })
      .where('org_id', '=', f.orgId).where('ref', '=', 'test/nosecret').execute();

    const run = await runWith('test/nosecret');
    expect(run['status']).toBe('failed');
    // The message names the ref, never a value, and the run never reached the network.
    expect(JSON.stringify(run['error'])).toContain('absent-vendor');
  });
});
