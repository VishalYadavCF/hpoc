import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Validator } from '@langchain/core/utils/json_schema';
import { LangChainMcpClient } from '../src/adapters/protocol/mcp/langchain.mcp-client.js';
import { GoogleProvider } from '../src/adapters/providers/langchain.provider.js';
import type { McpServerRef, McpToolDefinition } from '../src/domain/ports/mcp-client.port.js';

/**
 * A union in an MCP tool's input schema must reach the model, and the validator, whole.
 *
 * relay-dsl's `apply_operations` takes `operations: [anyOf <14 variants>]`, each variant
 * discriminated by `op: { enum: [<one name>] }`. @langchain/mcp-adapters "simplifies" every
 * schema it loads (dist/tools.js `simplifyJsonSchemaForLLM`): a union of objects is merged
 * with `Object.assign` over each variant's `properties`, so the LAST variant's `op` wins. hpoc
 * stored that merged schema as the approved definition, so the model was told only
 * `set_workflow_metadata` exists, and every other op failed validation before dispatch -- in
 * the framework against the stored schema, and again in the adapter against its own copy.
 */
const variant = (op: string, field: string) => ({
  type: 'object',
  required: ['op', field],
  properties: { op: { type: 'string', enum: [op] }, [field]: { type: 'string' } },
  additionalProperties: false,
});

const APPLY_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['workflowId', 'operations'],
  properties: {
    workflowId: { type: 'string' },
    operations: {
      type: 'array',
      minItems: 1,
      items: {
        anyOf: [
          variant('insert_node', 'nodeId'),
          variant('set_trigger', 'trigger'),
          variant('set_workflow_metadata', 'name'),
        ],
      },
    },
  },
};

/** `oneOf` through `$ref`, and a `const` discriminator: the other spellings of the same thing. */
const STEP_SCHEMA = {
  type: 'object',
  properties: {
    step: { oneOf: [{ $ref: '#/$defs/wait' }, { $ref: '#/$defs/branch' }] },
  },
  $defs: {
    wait: { type: 'object', required: ['kind'], properties: { kind: { const: 'wait' }, seconds: { type: 'number' } } },
    branch: { type: 'object', required: ['kind'], properties: { kind: { const: 'branch' }, when: { type: 'string' } } },
  },
};

const PLAIN_SCHEMA = { type: 'object', properties: { id: { type: 'string' } } };

let mcpServer: Server;
let server: McpServerRef;
let discovered: McpToolDefinition[];
const received: unknown[] = [];
const client = new LangChainMcpClient();

const byName = (name: string) => discovered.find((t) => t.name === name)!;
const itemsOf = (schema: Record<string, unknown>) =>
  (schema['properties'] as { operations: { items: { anyOf?: Record<string, unknown>[] } } }).operations.items;
const opsOf = (variants: Record<string, unknown>[] | undefined) =>
  (variants ?? []).map((v) => (v['properties'] as { op: { enum: string[] } }).op.enum);

beforeAll(async () => {
  mcpServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const rpc = JSON.parse(raw || '{}') as { id?: number; method: string; params?: Record<string, unknown> };
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      };
      if (!rpc.method) {
        res.writeHead(405, { allow: 'POST' }).end();
      } else if (rpc.method === 'initialize') {
        reply({
          protocolVersion: (rpc.params?.['protocolVersion'] as string) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'relay-dsl-probe', version: '1.0.0' },
        });
      } else if (rpc.method.startsWith('notifications/')) {
        res.writeHead(202).end();
      } else if (rpc.method === 'tools/list') {
        reply({
          tools: [
            { name: 'apply_operations', description: 'Apply DSL operations', inputSchema: APPLY_SCHEMA },
            { name: 'add_step', description: 'Add a step', inputSchema: STEP_SCHEMA },
            { name: 'lookup', description: 'Look up', inputSchema: PLAIN_SCHEMA },
          ],
        });
      } else if (rpc.method === 'tools/call') {
        received.push(rpc.params?.['arguments']);
        reply({ content: [{ type: 'text', text: 'applied' }] });
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'no such method' } }));
      }
    });
  });
  await new Promise<void>((r) => mcpServer.listen(0, '127.0.0.1', r));
  server = {
    id: 'relay-dsl-probe',
    name: 'relay-dsl-probe',
    endpointUrl: `http://127.0.0.1:${(mcpServer.address() as { port: number }).port}/mcp`,
    protocolRevision: '2026-07-28',
    headers: {},
  };
  discovered = await client.listTools(server);
});

afterAll(async () => {
  await new Promise<void>((r) => mcpServer.close(() => r()));
});

describe('MCP input schemas with unions (§13.2)', () => {
  it('keeps every anyOf variant, each with its own discriminator', () => {
    const items = itemsOf(byName('apply_operations').inputSchema);
    expect(opsOf(items.anyOf)).toEqual([['insert_node'], ['set_trigger'], ['set_workflow_metadata']]);
  });

  it('keeps oneOf variants reached through $ref, with nothing left to resolve', () => {
    const schema = byName('add_step').inputSchema;
    const step = (schema['properties'] as { step: { oneOf: Record<string, unknown>[] } }).step;
    expect(step.oneOf.map((v) => (v['properties'] as { kind: unknown }).kind)).toEqual([
      { const: 'wait' }, { const: 'branch' },
    ]);
    expect(JSON.stringify(schema)).not.toMatch(/\$ref|\$defs/);
  });

  it('validates each variant, and still rejects one that matches none', () => {
    const v = new Validator(byName('apply_operations').inputSchema as never, '7');
    for (const op of [
      { op: 'insert_node', nodeId: 'n1' },
      { op: 'set_trigger', trigger: 'webhook' },
      { op: 'set_workflow_metadata', name: 'wf' },
    ]) {
      expect(v.validate({ workflowId: 'w', operations: [op] }).valid).toBe(true);
    }
    expect(v.validate({ workflowId: 'w', operations: [{ op: 'insert_node', trigger: 'x' }] }).valid).toBe(false);
  });

  it('leaves a union-free schema, and therefore its pin, exactly as before', () => {
    const plain = byName('lookup');
    expect(plain.inputSchema).toEqual(PLAIN_SCHEMA);
    // The same inputs and canonicalisation as hashDefinition, so an existing pin still matches.
    const expected = createHash('sha256')
      .update(JSON.stringify({ name: 'lookup', description: 'Look up', schema: { properties: { id: { type: 'string' } }, type: 'object' } }))
      .digest('hex');
    expect(plain.definitionHash).toBe(expected);
  });

  it('dispatches a call for any variant, not only the last one', async () => {
    received.length = 0;
    for (const op of [{ op: 'insert_node', nodeId: 'n1' }, { op: 'set_trigger', trigger: 'webhook' }]) {
      const result = await client.callTool(server, 'apply_operations', { workflowId: 'w', operations: [op] }, 5_000);
      expect(result).toEqual({ ok: true, content: 'applied' });
    }
    expect(received).toEqual([
      { workflowId: 'w', operations: [{ op: 'insert_node', nodeId: 'n1' }] },
      { workflowId: 'w', operations: [{ op: 'set_trigger', trigger: 'webhook' }] },
    ]);
  });
});

describe('Gemini receives the union intact', () => {
  let gemini: Server;
  let baseUrl = '';
  const bodies: Record<string, unknown>[] = [];

  beforeAll(async () => {
    gemini = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }));
      });
    });
    await new Promise<void>((r) => gemini.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(gemini.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => gemini.close(() => r()));
  });

  it('sends every variant, as anyOf, with discriminators Gemini can read', async () => {
    await new GoogleProvider().complete(
      {
        providerModelId: 'gemini-flash-latest',
        prompt: 'edit the workflow',
        tools: ['apply_operations', 'add_step'].map((name) => ({
          name, description: byName(name).description, parameters: byName(name).inputSchema,
        })),
      },
      { apiKey: 'test-key', baseUrl },
    );

    const declarations = (bodies[0]!['tools'] as { functionDeclarations: { name: string; parameters: Record<string, unknown> }[] }[])
      .flatMap((t) => t.functionDeclarations);
    const apply = declarations.find((d) => d.name === 'apply_operations')!.parameters;
    expect(opsOf(itemsOf(apply).anyOf)).toEqual([['insert_node'], ['set_trigger'], ['set_workflow_metadata']]);

    // Gemini's Schema has anyOf but no oneOf and no const. Both are rewritten, never dropped:
    // dropping `const` would make the two variants indistinguishable, which is the same
    // collapse by another route.
    const step = (declarations.find((d) => d.name === 'add_step')!.parameters['properties'] as {
      step: Record<string, unknown>;
    }).step;
    expect(step['oneOf']).toBeUndefined();
    expect((step['anyOf'] as Record<string, unknown>[]).map((v) => (v['properties'] as { kind: unknown }).kind)).toEqual([
      { type: 'string', enum: ['wait'] }, { type: 'string', enum: ['branch'] },
    ]);
  });
});
