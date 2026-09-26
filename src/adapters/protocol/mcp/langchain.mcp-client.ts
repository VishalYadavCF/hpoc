import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { Connection } from '@langchain/mcp-adapters';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  MCP_TOOL_ERROR,
  type McpCallResult,
  type McpClient,
  type McpServerRef,
  type McpToolDefinition,
} from '../../../domain/ports/mcp-client.port.js';

/**
 * MCP through the official client, over stdio and Streamable HTTP alike.
 *
 * ## What this replaced
 *
 * Two hand-written transports: a JSON-RPC-over-HTTP client that also had to parse SSE,
 * and a stdio client that framed newline-delimited JSON over a child process's pipes --
 * 334 lines of protocol we do not own, could not have kept current, and had never tested
 * against a server we did not also write.
 *
 * MCP is a moving specification. Writing a second implementation of it was the clearest
 * case in this repo of reinventing a wheel: the value was never in the framing, it was in
 * what the platform does either side of it.
 *
 * ## What it deliberately did NOT replace
 *
 * The `definitionHash` below, and everything above this port: the server registry, the
 * approval workflow, capability grants, effect contracts, the sandbox, `tool_invocations`.
 * §13.2's pin is a GOVERNANCE control -- "the tool the operator approved is the tool that
 * ran" -- and no transport library can provide it, because the question is about our
 * records and not about the wire.
 *
 * The hash is computed here, from the definition the client returned, exactly as before.
 * Its inputs and its canonicalisation are unchanged, so pins recorded by the old
 * transports still match.
 *
 * ## Connections
 *
 * A client is built per operation and closed after it. That looks wasteful until you
 * consider what a pool would mean here: a worker holding open stdio child processes for
 * every registered server across every tenant, kept alive between unrelated runs. The
 * transport has been sessionless since the 2026-07-28 revision, so there is no protocol
 * state worth preserving -- only a socket, and only sometimes.
 */
@Injectable()
export class LangChainMcpClient implements McpClient {
  readonly id = 'langchain-mcp';
  private readonly log = new Logger(LangChainMcpClient.name);

  async listTools(server: McpServerRef): Promise<McpToolDefinition[]> {
    return this.withClient(server, async (tools, client) => {
      const raw = await rawInputSchemas(client, server.name);
      return tools
        .filter((t) => typeof t.name === 'string' && t.name.length > 0)
        .map((t) => {
          // Only a schema with a union takes the new path. Every other schema, and so every
          // other pin, is exactly what it was.
          const own = raw.get(t.name);
          const schema = own && hasUnion(own) ? preservingUnions(own) : jsonSchemaOf(t);
          return {
            name: t.name,
            description: t.description ?? '',
            inputSchema: schema,
            definitionHash: hashDefinition(t.name, t.description ?? '', schema),
          };
        });
    });
  }

  async callTool(
    server: McpServerRef,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<McpCallResult> {
    try {
      return await this.withClient(server, async (tools) => {
        const target = tools.find((t) => t.name === toolName);
        if (!target) {
          // Not retryable: the server no longer offers a tool the registry recorded. That
          // is a pin violation to investigate, not a blip to try again through.
          return {
            ok: false,
            content: null,
            error: { message: `Server "${server.name}" does not offer tool "${toolName}"`, retryable: false },
          };
        }
        let content: unknown;
        try {
          content = await withTimeout(
            invokeUnchecked(target, args),
            timeoutMs,
            `MCP call ${server.name}/${toolName}`,
          );
        } catch (e) {
          // Only a tool-level `isError` result is converted here; everything else keeps
          // taking the transport-failure path below.
          const text = toolErrorText(e, server.name, toolName);
          if (text === null) throw e;
          return {
            ok: false,
            // Rebuilt from the exception: the adapter keeps only the text blocks.
            content: { isError: true, content: [{ type: 'text', text }] },
            // Not retryable: the server answered, and would answer the same way again.
            error: { code: MCP_TOOL_ERROR, message: text, retryable: false },
          };
        }
        return { ok: true, content };
      });
    } catch (e) {
      const message = (e as Error).message;
      this.log.warn(`MCP call ${server.name}/${toolName} failed: ${message}`);
      // Transport-shaped failures are worth another attempt; a tool that rejected the
      // arguments is not, and retrying it would just spend the budget twice.
      return { ok: false, content: null, error: { message, retryable: isTransportFailure(message) } };
    }
  }

  private async withClient<T>(
    server: McpServerRef,
    fn: (tools: StructuredToolInterface[], client: MultiServerMCPClient) => Promise<T>,
  ): Promise<T> {
    const client = new MultiServerMCPClient({
      mcpServers: { [server.name]: connectionFor(server) },
      // Names must round-trip: the registry stores what the server called its tool, and a
      // prefixed name would neither match a pin nor resolve on the way back out.
      prefixToolNameWithServerName: false,
      useStandardContentBlocks: true,
      // One broken tool definition must not hide the twelve good ones. Failing the whole
      // discovery closes capability the operator already approved.
      throwOnLoadError: false,
    });
    try {
      return await fn(await client.getTools(), client);
    } finally {
      await client.close().catch((e: unknown) => {
        // A leaked socket or child process is worth a line in the log, and is never worth
        // failing an otherwise successful call over.
        this.log.warn(`closing MCP client for ${server.name}: ${(e as Error).message}`);
      });
    }
  }
}

/**
 * The transport the REGISTRY recorded, never one the caller chose.
 *
 * A server with a registered `command` is stdio; one with an `endpointUrl` is Streamable
 * HTTP. §18.5 keeps server definitions in the registry precisely so that a spec cannot
 * point a stdio server at an arbitrary command.
 */
function connectionFor(server: McpServerRef): Connection {
  if (server.command?.length) {
    const [command, ...args] = server.command;
    return { transport: 'stdio', command: command!, args };
  }
  return {
    transport: 'http',
    url: server.endpointUrl,
    // Already minted by the broker (§16.3). This client never sees a credential it could
    // pass through, which is what §13.2 forbids.
    //
    // `MCP-Protocol-Version` is deliberately NOT set here. The SDK's Streamable HTTP transport
    // sets that header itself from the version it negotiated during `initialize`, so adding our
    // own produced TWO header values, which arrive comma-joined:
    //
    //   Bad Request: Unsupported protocol version: 2025-11-25, 2025-06-18
    //
    // Every request after `initialize` failed, so tool discovery was impossible against any
    // server whose SDK sets the header — i.e. every current one. Matching the pinned revision to
    // the negotiated one does not help; the value is still two tokens ("2025-11-25, 2025-11-25").
    headers: { ...server.headers },
    // What actually keeps the pinned revision meaningful: without this a failed Streamable HTTP
    // attempt silently downgrades to the older SSE transport, and a pinned revision stops meaning
    // anything. This is the guard the header was mistakenly thought to provide.
    automaticSSEFallback: false,
  };
}

/**
 * Canonical hash of a tool definition (§13.2).
 *
 * Key order must not change the hash, or every rediscovery looks like the server mutated
 * its tools and fails closed for no reason. Byte-identical to what the hand-written
 * transports produced, so existing pins still match.
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

/**
 * The tool's JSON Schema, which is what the pin is taken over.
 *
 * The client hands back a LangChain tool whose `schema` is already JSON Schema for an MCP
 * source -- it was JSON Schema on the wire. The fallback keeps a Zod-shaped schema from
 * hashing as `{}` and making every server look like it publishes one identical tool.
 */
function jsonSchemaOf(tool: StructuredToolInterface): Record<string, unknown> {
  const schema = (tool as { schema?: unknown }).schema;
  if (schema && typeof schema === 'object' && 'type' in schema) {
    return schema as Record<string, unknown>;
  }
  return { type: 'object' };
}

/**
 * The input schemas exactly as the server published them, by tool name.
 *
 * Needed because the adapter's tools carry only its SIMPLIFIED schema: `loadMcpTools` runs
 * every one through `simplifyJsonSchemaForLLM` (1.1.3, dist/tools.js), which merges a union of
 * objects by `Object.assign`-ing each variant's `properties` in turn. The last variant's
 * discriminator overwrites every other one -- relay-dsl's 14 `apply_operations` ops became
 * `op: { enum: ["set_workflow_metadata"] }` -- and `required` shrinks to what all variants
 * share. Same connection, one extra `tools/list`, and only during discovery.
 */
async function rawInputSchemas(
  client: MultiServerMCPClient,
  serverName: string,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const sdk = await client.getClient(serverName);
  if (!sdk) return out;
  let cursor: string | undefined;
  do {
    const page = await sdk.listTools(cursor ? { cursor } : {});
    for (const t of page.tools) out.set(t.name, t.inputSchema as Record<string, unknown>);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

const isNode = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether `anyOf`/`oneOf` appears anywhere -- the only construct the adapter collapses lossily. */
function hasUnion(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasUnion);
  if (!isNode(node)) return false;
  if (Array.isArray(node['anyOf']) || Array.isArray(node['oneOf'])) return true;
  return Object.values(node).some(hasUnion);
}

/**
 * The server's schema with its unions intact, made self-contained.
 *
 * Does what the adapter does that is lossless -- inlines `#/$defs/*` and `#/definitions/*`
 * references (a cycle becomes `{ type: "object" }`, as there), drops `$schema`, and gives an
 * object a `properties` -- and nothing else. Every variant survives for the model to see and
 * for the framework's validator to accept. Vendor narrowing stays where it already is, in the
 * provider (`GoogleProvider.toolParameters`), rather than being applied once, here, for all
 * of them.
 */
function preservingUnions(schema: Record<string, unknown>): Record<string, unknown> {
  const defs = (schema['$defs'] ?? schema['definitions'] ?? {}) as Record<string, unknown>;
  const resolve = (node: unknown, seen: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((n) => resolve(n, seen));
    if (!isNode(node)) return node;
    const ref = node['$ref'];
    if (typeof ref === 'string') {
      const name = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref)?.[1];
      const target = name === undefined ? undefined : defs[name];
      if (target !== undefined) {
        if (seen.has(ref)) return { type: 'object' };
        const { $ref: _ref, ...rest } = node;
        return { ...(resolve(target, new Set([...seen, ref])) as Record<string, unknown>), ...rest };
      }
      return node;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$defs' || k === 'definitions' || k === '$schema') continue;
      out[k] = resolve(v, seen);
    }
    return out;
  };
  const out = resolve(schema, new Set()) as Record<string, unknown>;
  // `loadMcpTools` adds this to every tool; matching it keeps an argument-less tool valid.
  if (!out['properties']) out['properties'] = {};
  return out;
}

/**
 * Runs the adapter's tool body without `StructuredTool.call`'s argument check.
 *
 * That check validates against the adapter's simplified schema, so for a union it refused
 * every variant but the last before the server saw the call ("Received tool input did not
 * match expected schema"). Arguments are still validated twice elsewhere: by the framework,
 * against the APPROVED definition, before the platform is asked to call; and by the server,
 * which MCP requires to validate its own input. The result is what `invoke` returned -- the
 * content half of the adapter's content-and-artifact tuple -- and an `isError` result still
 * throws the same ToolException (`_callTool` raises it, not `call`).
 */
async function invokeUnchecked(tool: StructuredToolInterface, args: Record<string, unknown>): Promise<unknown> {
  const func = (tool as { func?: (input: unknown, runManager?: unknown, config?: unknown) => Promise<unknown> }).func;
  if (typeof func !== 'function') return tool.invoke(args);
  const result = await func.call(tool, args, undefined, {});
  return Array.isArray(result) && result.length === 2 ? result[0] : result;
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const isTransportFailure = (message: string): boolean =>
  /timed out|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|EPIPE/i.test(message);

/**
 * The tool's own error text, when `e` is the adapter reporting an `isError: true` result;
 * null for anything else.
 *
 * @langchain/mcp-adapters (1.1.3, dist/tools.js `_convertCallToolResult`) does not return
 * an `isError` result: it throws a `ToolException` whose message is this fixed prefix
 * followed by the result's text blocks joined with "\n", and `_callTool` rethrows it
 * unchanged. Matching the exact prefix, with this server and tool name, is what tells it
 * apart from the adapter's other ToolExceptions (invalid result, bad arguments, and
 * transport errors, which it wraps as "Error calling tool ..."). test/mcp-tool-error.spec.ts
 * runs the real adapter against a fake server, so a change to that message on upgrade
 * fails a test rather than silently reclassifying tool errors as transport failures.
 */
function toolErrorText(e: unknown, serverName: string, toolName: string): string | null {
  if (!(e instanceof Error) || e.name !== 'ToolException') return null;
  const prefix = `MCP tool '${toolName}' on server '${serverName}' returned an error: `;
  return e.message.startsWith(prefix) ? e.message.slice(prefix.length) : null;
}
