import { Injectable } from '@nestjs/common';
import type {
  McpCallResult,
  McpClient,
  McpServerRef,
  McpToolDefinition,
} from '../../../domain/ports/mcp-client.port.js';
import { StreamableHttpMcpClient } from './streamable-http.mcp-client.js';
import { StdioMcpClient } from './stdio.mcp-client.js';

/**
 * Routes to the transport the registry recorded for a server.
 *
 * A server with a registered `command` is stdio; one with an `endpointUrl` is Streamable
 * HTTP. The decision is the registry's, never the caller's — a caller choosing a transport
 * could point a stdio server at an arbitrary command, and §18.5 keeps server definitions
 * in the registry precisely so that is not reachable from a spec.
 */
@Injectable()
export class McpRouter implements McpClient {
  readonly id = 'router';

  constructor(
    private readonly http: StreamableHttpMcpClient,
    private readonly stdio: StdioMcpClient,
  ) {}

  private pick(server: McpServerRef): McpClient {
    return (server as McpServerRef & { command?: string[] }).command?.length ? this.stdio : this.http;
  }

  listTools(server: McpServerRef): Promise<McpToolDefinition[]> {
    return this.pick(server).listTools(server);
  }

  callTool(
    server: McpServerRef,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<McpCallResult> {
    return this.pick(server).callTool(server, toolName, args, timeoutMs);
  }
}
