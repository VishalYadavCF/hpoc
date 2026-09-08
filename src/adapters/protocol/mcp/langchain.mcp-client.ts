import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { Connection } from '@langchain/mcp-adapters';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type {
  McpCallResult,
  McpClient,
  McpServerRef,
  McpToolDefinition,
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
    return this.withClient(server, async (tools) =>
      tools
        .filter((t) => typeof t.name === 'string' && t.name.length > 0)
        .map((t) => {
          const schema = jsonSchemaOf(t);
          return {
            name: t.name,
            description: t.description ?? '',
            inputSchema: schema,
            definitionHash: hashDefinition(t.name, t.description ?? '', schema),
          };
        }),
    );
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
        const content = await withTimeout(
          target.invoke(args) as Promise<unknown>,
          timeoutMs,
          `MCP call ${server.name}/${toolName}`,
        );
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
    fn: (tools: StructuredToolInterface[]) => Promise<T>,
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
      return await fn(await client.getTools());
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
    headers: { ...server.headers, 'MCP-Protocol-Version': server.protocolRevision },
    // The revision is pinned, so the fallback to the older SSE transport must not fire --
    // silently downgrading the protocol is how a pinned revision stops meaning anything.
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
