import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  McpCallResult,
  McpClient,
  McpServerRef,
  McpToolDefinition,
} from '../../../domain/ports/mcp-client.port.js';

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * MCP over Streamable HTTP.
 *
 * A single POST endpoint; the reply is either a JSON object or a request-scoped SSE
 * stream. There is no GET stream and no session to establish or resume -- those were
 * removed in the 2026-07-28 revision, so this client opens no connection, keeps no state
 * and needs no affinity. Adding any of that back would be reimplementing a protocol
 * feature that no longer exists.
 *
 * Cancellation is transport-level: closing the response stream IS the signal, which is
 * what the AbortSignal below does.
 */
@Injectable()
export class StreamableHttpMcpClient implements McpClient {
  readonly id = 'streamable-http';
  private readonly log = new Logger(StreamableHttpMcpClient.name);
  private nextId = 1;

  async listTools(server: McpServerRef): Promise<McpToolDefinition[]> {
    const result = await this.rpc(server, 'tools/list', {}, 15_000);
    const tools = (result['tools'] ?? []) as {
      name?: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }[];

    return tools
      .filter((t) => typeof t.name === 'string' && t.name.length > 0)
      .map((t) => ({
        name: t.name!,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object' },
        definitionHash: hashDefinition(t.name!, t.description ?? '', t.inputSchema ?? {}),
      }));
  }

  async callTool(
    server: McpServerRef,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<McpCallResult> {
    try {
      const result = await this.rpc(
        server,
        'tools/call',
        { name: toolName, arguments: args },
        timeoutMs,
      );
      // MCP reports tool-level failure in the RESULT, not as a JSON-RPC error: an `isError`
      // result is the tool saying no, which is different from the transport failing.
      if (result['isError'] === true) {
        return {
          ok: false,
          content: result['content'] ?? null,
          error: { message: 'MCP tool reported an error', retryable: false },
        };
      }
      return { ok: true, content: result['content'] ?? result };
    } catch (e) {
      const message = (e as Error).message;
      return {
        ok: false,
        content: null,
        error: { message, retryable: /timeout|abort|ECONN|5\d\d/i.test(message) },
      };
    }
  }

  private async rpc(
    server: McpServerRef,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(server.endpointUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The client must accept both shapes: the server chooses per request whether to
        // answer with a JSON object or a request-scoped SSE stream.
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': server.protocolRevision,
        // Routing headers §13.1 requires. Disagreement between header and body is a client
        // bug, not something to retry, so both are derived from the same values here.
        'mcp-method': method,
        ...(params['name'] ? { 'mcp-name': String(params['name']) } : {}),
        ...server.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`MCP server returned ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('text/event-stream')
      ? parseSseEnvelope(await response.text())
      : ((await response.json()) as JsonRpcResponse);

    if (body.error) {
      throw new Error(`MCP error ${body.error.code}: ${body.error.message}`);
    }
    return body.result ?? {};
  }
}

/** A request-scoped SSE reply: take the last `data:` frame carrying a JSON-RPC envelope. */
function parseSseEnvelope(text: string): JsonRpcResponse {
  let last: JsonRpcResponse | null = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const parsed = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
      if (parsed.result !== undefined || parsed.error !== undefined) last = parsed;
    } catch {
      // Not every frame is an envelope; progress notifications are expected.
    }
  }
  if (!last) throw new Error('MCP SSE reply carried no JSON-RPC envelope');
  return last;
}

/**
 * Canonical hash of a tool definition (§13.2).
 *
 * Key order must not change the hash, or every rediscovery looks like the server mutated
 * its tools and fails closed for no reason.
 */
function hashDefinition(name: string, description: string, schema: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify({ name, description, schema: canonical(schema) }))
    .digest('hex');
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonical(v)]),
  );
}
