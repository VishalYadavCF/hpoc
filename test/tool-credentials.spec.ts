import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { ToolRuntime, type ToolBinding } from '../src/domain/tool-runtime/tool-runtime.service.js';
import { CredentialBroker } from '../src/domain/identity/credential-broker.service.js';
import { EnvSecretStore } from '../src/adapters/secrets/env.secret-store.js';
import { HttpEgressSandbox } from '../src/adapters/sandbox/http-egress.sandbox.js';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import type { McpClient } from '../src/domain/ports/mcp-client.port.js';
import type { McpRegistryService } from '../src/domain/mcp/mcp-registry.service.js';
import { fixture, makeRun, type Fixture } from './fixtures.js';

/**
 * Migration 0033: a tool whose template names a `credential_ref` calls a third-party API with
 * THAT API's credential, and never with the platform's own token.
 *
 * Real broker, real env secret store, real egress sandbox; the only fake is the upstream, which
 * records what it was sent. GitHub is the motivating case, so the upstream answers like it.
 */
let f: Fixture;
let upstream: Server;
let origin = '';
let received: IncomingHttpHeaders[] = [];
let runId: string;
let threadId: string;
let toolId: string;
let runtime: ToolRuntime;
let uow: UnitOfWork;

const SUFFIX = Math.random().toString(36).slice(2, 8);
const REF = `tool_cred_${SUFFIX}`;
const ENV = `MODEL_CREDENTIAL_${REF.toUpperCase()}`;

const binding = (over: Partial<ToolBinding> = {}): ToolBinding => ({
  toolId, ref: `github.probe.${SUFFIX}`, origin: 'http', version: 1,
  effects: ['read_only'], endpointUrl: origin, sandboxProfile: 'http-egress', timeoutMs: 5_000,
  definitionHash: null, idempotencyKeyTpl: null, cacheTtlSeconds: null, fixedArgs: {},
  description: null, inputSchema: { type: 'object' },
  httpMethod: 'GET', pathTemplate: '/repos/{owner}/{repo}', argPlacement: 'none', argWrapperKey: null,
  staticHeaders: { accept: 'application/vnd.github+json' }, codeRuntime: null, codeSource: null,
  credentialRef: REF,
  ...over,
});

let seq = 0;
const call = async (b: ToolBinding, toolArgs: Record<string, unknown> = { owner: 'o', repo: 'r' }) => {
  const step = await f.db
    .insertInto('steps')
    .values({
      run_id: runId, seq: ++seq, kind: 'tool_call', status: 'running',
      org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef,
    })
    .returning('id').executeTakeFirstOrThrow();
  return uow.run((tx) =>
    runtime.execute({
      tx, binding: b, stepId: step.id, runId, threadId,
      orgId: f.orgId, namespaceId: f.namespaceId, tenantRef: f.tenantRef,
      agentWorkloadId: f.principalId, onBehalfOf: null, toolArgs, replaying: false,
    }),
  );
};

beforeAll(async () => {
  upstream = createServer((req, res) => {
    received.push(req.headers);
    if (req.url?.startsWith('/repos/o/missing')) {
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Validation Failed', errors: ['line must be part of the diff'] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ full_name: 'o/r' }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

  f = await fixture();
  ({ runId, threadId } = await makeRun(f));
  toolId = (
    await f.db
      .insertInto('tools')
      .values({
        org_id: f.orgId, namespace_id: f.namespaceId, ref: `github.probe.${SUFFIX}`,
        origin: 'http', residency: 'internal', input_schema: JSON.stringify({ type: 'object' }),
        default_effects: ['read_only'], sandbox_profile: 'http-egress', endpoint_url: origin,
        credential_ref: REF,
      })
      .returning('id').executeTakeFirstOrThrow()
  ).id;

  const broker = new CredentialBroker(new EnvSecretStore());
  runtime = new ToolRuntime(
    f.db, undefined as never, new HttpEgressSandbox(),
    {} as McpClient, {} as McpRegistryService, broker,
  );
  uow = new UnitOfWork(f.db);
});

afterAll(async () => {
  delete process.env[ENV];
  await new Promise<void>((r) => upstream.close(() => r()));
  if (!f) return;
  await f.db.deleteFrom('runs').where('id', '=', runId).execute();
  await f.db.deleteFrom('threads').where('id', '=', threadId).execute();
  await f.db.deleteFrom('tools').where('id', '=', toolId).execute();
  await f.close();
});

describe('a tool with a credential_ref (migration 0033)', () => {
  it('sends the third-party token as a bearer, and NOT the platform token', async () => {
    process.env[ENV] = 'ghp_test_token';
    received = [];
    const outcome = await call(binding());

    expect(outcome.kind).toBe('completed');
    expect(received[0]!['authorization']).toBe('Bearer ghp_test_token');
    // The platform's workload identity and tenant are ours, not the third party's business.
    expect(received[0]!['x-agent-workload']).toBeUndefined();
    expect(received[0]!['x-tenant-ref']).toBeUndefined();
    expect(received[0]!['accept']).toBe('application/vnd.github+json');
  });

  it('records the grant but never the token', async () => {
    const grants = await f.db
      .selectFrom('credential_grants').selectAll().where('run_id', '=', runId).execute();
    expect(grants.length).toBeGreaterThan(0);
    expect(JSON.stringify(grants)).not.toContain('ghp_test_token');
  });

  it('honours a JSON secret naming its own header and scheme', async () => {
    process.env[ENV] = JSON.stringify({ apiKey: 'k-1', header: 'X-Api-Key', scheme: '' });
    received = [];
    await call(binding());
    expect(received[0]!['x-api-key']).toBe('k-1');
    expect(received[0]!['authorization']).toBeUndefined();
  });

  it('fails the invocation, without calling out, when the secret is missing', async () => {
    delete process.env[ENV];
    received = [];
    const outcome = await call(binding());

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.error).toEqual({ message: expect.stringMatching(/No secret/), retryable: false });
    expect(received).toHaveLength(0);
    const row = await f.db
      .selectFrom('tool_invocations').select('status')
      .where('id', '=', outcome.invocationId).executeTakeFirstOrThrow();
    expect(row.status).toBe('failed');
  });

  it('keeps the platform token for a tool with no credential_ref', async () => {
    received = [];
    await call(binding({ credentialRef: null }));
    expect(received[0]!['authorization']).toMatch(/^Bearer [\w-]+\.[\w-]+$/);
    expect(received[0]!['x-agent-workload']).toBe(f.principalId);
  });

  it('hands the model the upstream reason for a 4xx, not only its status', async () => {
    process.env[ENV] = 'ghp_test_token';
    const outcome = await call(binding(), { owner: 'o', repo: 'missing' });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.error.message).toMatch(/returned 422: .*line must be part of the diff/);
    expect(outcome.error.retryable).toBe(false);
  });
});
