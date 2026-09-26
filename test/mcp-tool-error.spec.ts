import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { LangChainMcpClient } from '../src/adapters/protocol/mcp/langchain.mcp-client.js';
import { ToolRuntime, type ToolBinding } from '../src/domain/tool-runtime/tool-runtime.service.js';
import { RunReadService } from '../src/domain/run-engine/run-read.service.js';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { runInContext } from '../src/platform/context/platform-context.js';
import type { McpRegistryService } from '../src/domain/mcp/mcp-registry.service.js';
import type { CredentialBroker } from '../src/domain/identity/credential-broker.service.js';
import type { Sandbox } from '../src/domain/ports/sandbox.port.js';
import type { McpServerRef } from '../src/domain/ports/mcp-client.port.js';
import { fixture, makeRun, type Fixture } from './fixtures.js';

/**
 * An MCP tool that answers `isError: true` is a FAILED invocation, not a transport failure.
 *
 * MCP reports a tool-level failure inside a successful JSON-RPC response. The adapter this
 * repo uses turns that into a thrown ToolException, which used to reach the generic catch:
 * recorded with no response and no code, the text prefixed with adapter boilerplate, and
 * `retryable` decided by whether the tool's own message happened to say "timed out".
 *
 * The fake server is real Streamable HTTP and the client is the real adapter, so these
 * pin the adapter's actual behaviour rather than a mock of it.
 */
let f: Fixture;
let mcpServer: Server;
let server: McpServerRef;
const SUFFIX = Math.random().toString(36).slice(2, 8);
const SERVER_NAME = `relay-probe-${SUFFIX}`;
const TOOL_ERROR = 'op "frobnicate" is not a valid operation; expected one of: insert_node, set_trigger';
const client = new LangChainMcpClient();

beforeAll(async () => {
  mcpServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const rpc = JSON.parse(raw || '{}') as { id?: number; method: string; params?: Record<string, unknown> };
      const reply = (body: Record<string, unknown>) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...body }));
      };
      if (!rpc.method) {
        res.writeHead(405, { allow: 'POST' }).end();
      } else if (rpc.method === 'initialize') {
        reply({
          result: {
            protocolVersion: (rpc.params?.['protocolVersion'] as string) ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'relay-probe', version: '1.0.0' },
          },
        });
      } else if (rpc.method.startsWith('notifications/')) {
        res.writeHead(202).end();
      } else if (rpc.method === 'tools/list') {
        const schema = { type: 'object', properties: { op: { type: 'string' }, text: { type: 'string' } } };
        reply({
          result: {
            tools: ['lookup', 'apply_operations', 'rpc_error'].map((name) => ({
              name, description: name, inputSchema: schema,
            })),
          },
        });
      } else if (rpc.method === 'tools/call') {
        const name = rpc.params?.['name'];
        const args = (rpc.params?.['arguments'] ?? {}) as Record<string, unknown>;
        if (name === 'lookup') {
          reply({ result: { content: [{ type: 'text', text: `looked up ${JSON.stringify(args)}` }] } });
        } else if (name === 'apply_operations') {
          // The JSON-RPC call succeeds; the TOOL failed. This is how MCP says so.
          reply({ result: { isError: true, content: [{ type: 'text', text: (args['text'] as string) ?? TOOL_ERROR }] } });
        } else {
          reply({ error: { code: -32602, message: 'Invalid params' } });
        }
      } else {
        reply({ error: { code: -32601, message: 'no such method' } });
      }
    });
  });
  await new Promise<void>((r) => mcpServer.listen(0, '127.0.0.1', r));
  server = {
    id: `srv-${SUFFIX}`,
    name: SERVER_NAME,
    endpointUrl: `http://127.0.0.1:${(mcpServer.address() as { port: number }).port}/mcp`,
    protocolRevision: '2026-07-28',
    headers: {},
  };
});

afterAll(async () => {
  await new Promise<void>((r) => mcpServer.close(() => r()));
});

describe('MCP isError results at the client (§13.1)', () => {
  it('returns an isError result as a non-retryable mcp_tool_error carrying the tool text', async () => {
    const result = await client.callTool(server, 'apply_operations', { op: 'frobnicate' }, 5_000);
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: 'mcp_tool_error', message: TOOL_ERROR, retryable: false });
    expect(result.content).toEqual({ isError: true, content: [{ type: 'text', text: TOOL_ERROR }] });
  });

  it('does not let the tool text decide retryability', async () => {
    // The old path ran the adapter's message through the transport-failure regex, so a tool
    // saying "timed out" was classed as a blip worth retrying.
    const result = await client.callTool(server, 'apply_operations', { text: 'workflow step timed out' }, 5_000);
    expect(result.error?.code).toBe('mcp_tool_error');
    expect(result.error?.retryable).toBe(false);
  });

  it('leaves a successful call exactly as before', async () => {
    const result = await client.callTool(server, 'lookup', { op: 'm-1' }, 5_000);
    expect(result).toEqual({ ok: true, content: 'looked up {"op":"m-1"}' });
  });

  it('does not classify a JSON-RPC error as a tool error', async () => {
    const result = await client.callTool(server, 'rpc_error', {}, 5_000);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBeUndefined();
    expect(result.error?.message).toMatch(/Invalid params/);
  });
});

describe('MCP isError results in the invocation record (§4.5, §16.2)', () => {
  let runId: string;
  let threadId: string;
  let toolId: string;
  let runtime: ToolRuntime;
  let uow: UnitOfWork;
  let reads: RunReadService;

  const ctx = <T>(fn: () => Promise<T>): Promise<T> =>
    runInContext(
      {
        orgId: f.orgId, namespaceId: f.namespaceId, tenantRef: f.tenantRef,
        callerPrincipalId: f.principalId, onBehalfOfPrincipalId: null,
        authorizingHumanId: null, delegationChain: [],
        traceId: `mcp-err-${SUFFIX}`, correlationId: `mcp-err-${SUFFIX}`,
      },
      fn,
    );

  const binding = (toolName: string): ToolBinding => ({
    toolId, ref: `mcp__${SERVER_NAME}__${toolName}`, origin: 'mcp', version: 1,
    effects: ['read_only'], endpointUrl: null, sandboxProfile: 'none', timeoutMs: 5_000,
    definitionHash: null, idempotencyKeyTpl: null, cacheTtlSeconds: null, fixedArgs: {},
    description: null, inputSchema: { type: 'object' },
    mcpServerId: server.id, mcpToolName: toolName,
    httpMethod: 'POST', pathTemplate: null, argPlacement: null, argWrapperKey: null,
    staticHeaders: {}, codeRuntime: null, codeSource: null,
  });

  const call = async (seq: number, toolName: string, toolArgs: Record<string, unknown>) => {
    const step = await f.db
      .insertInto('steps')
      .values({
        run_id: runId, seq, kind: 'tool_call', status: 'running',
        org_id: f.orgId, namespace_id: f.namespaceId, tenant_ref: f.tenantRef,
      })
      .returning('id').executeTakeFirstOrThrow();
    return uow.run((tx) =>
      runtime.execute({
        tx, binding: binding(toolName), stepId: step.id, runId, threadId,
        orgId: f.orgId, namespaceId: f.namespaceId, tenantRef: f.tenantRef,
        agentWorkloadId: f.principalId, onBehalfOf: null, toolArgs, replaying: false,
      }),
    );
  };

  beforeAll(async () => {
    f = await fixture();
    ({ runId, threadId } = await makeRun(f));
    toolId = (
      await f.db
        .insertInto('tools')
        .values({
          org_id: f.orgId, namespace_id: f.namespaceId, ref: `mcp-err.${SUFFIX}`,
          origin: 'native', residency: 'internal', input_schema: JSON.stringify({ type: 'object' }),
          default_effects: ['read_only'], sandbox_profile: 'none',
        })
        .returning('id').executeTakeFirstOrThrow()
    ).id;

    // Only the gates are faked: approval/pin (McpRegistryService) and minting (the broker)
    // have their own specs. The call itself goes through the real adapter.
    const registry = { resolveForCall: async () => server } as unknown as McpRegistryService;
    const broker = { mint: async () => ({ headers: {} }) } as unknown as CredentialBroker;
    const sandbox = { execute: async () => { throw new Error('not an MCP call'); } } as unknown as Sandbox;
    runtime = new ToolRuntime(f.db, undefined as never, sandbox, client, registry, broker);
    uow = new UnitOfWork(f.db);
    reads = new RunReadService(f.db);
  });

  afterAll(async () => {
    if (!f) return;
    // Deleting the run cascades its steps and invocations; the tool is RESTRICT until then.
    await f.db.deleteFrom('runs').where('id', '=', runId).execute();
    await f.db.deleteFrom('threads').where('id', '=', threadId).execute();
    await f.db.deleteFrom('tools').where('id', '=', toolId).execute();
    await f.close();
  });

  it('settles an isError call as failed, keeps the response, and hands the loop the text', async () => {
    const outcome = await call(1, 'apply_operations', { op: 'frobnicate' });

    // An outcome, not a throw: runToolStep turns `failed` into a tool_error observation and
    // the run continues. Non-retryable, so nothing treats it as a transport blip.
    expect(outcome).toMatchObject({ kind: 'failed', error: { message: TOOL_ERROR, retryable: false } });

    const [row] = await ctx(() => reads.toolInvocations(runId));
    expect(row).toMatchObject({
      step_seq: 1,
      origin: 'mcp',
      status: 'failed',
      request: { op: 'frobnicate' },
      request_artifact_id: null,
      response: { isError: true, content: [{ type: 'text', text: TOOL_ERROR }] },
      response_artifact_id: null,
      error: { code: 'mcp_tool_error', message: TOOL_ERROR },
    });
  });

  it('truncates the recorded message but not what the model receives', async () => {
    const long = 'x'.repeat(5_000);
    const outcome = await call(2, 'apply_operations', { text: long });
    expect(outcome.kind === 'failed' && outcome.error.message).toBe(long);

    const row = (await ctx(() => reads.toolInvocations(runId))).find((r) => r.step_seq === 2)!;
    const error = row.error as { code: string; message: string };
    expect(error.code).toBe('mcp_tool_error');
    expect(error.message.length).toBeLessThanOrEqual(2_001);
    expect(error.message.startsWith('x'.repeat(2_000))).toBe(true);
    // The full text is still on record, in the response.
    expect(JSON.stringify(row.response)).toContain(long);
  });

  it('records a successful call as before', async () => {
    const outcome = await call(3, 'lookup', { op: 'm-1' });
    expect(outcome).toMatchObject({ kind: 'completed', output: 'looked up {"op":"m-1"}', cached: false });

    const row = (await ctx(() => reads.toolInvocations(runId))).find((r) => r.step_seq === 3)!;
    expect(row).toMatchObject({
      status: 'succeeded',
      request: { op: 'm-1' },
      response: 'looked up {"op":"m-1"}',
      error: null,
    });
  });
});
