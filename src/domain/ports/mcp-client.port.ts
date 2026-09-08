export const MCP_CLIENT = Symbol('McpClient');

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** sha256 of the canonical definition — the pin §13.2 requires. */
  definitionHash: string;
}

export interface McpServerRef {
  id: string;
  name: string;
  /** Empty for stdio servers, which are addressed by `command` instead. */
  endpointUrl: string;
  /** Set only for stdio servers, and only ever from the registry (§18.5). */
  command?: string[];
  /** A dated revision, pinned. Never "latest". */
  protocolRevision: string;
  headers: Record<string, string>;
}

export interface McpCallResult {
  ok: boolean;
  content: unknown;
  error?: { message: string; retryable: boolean };
}

/**
 * §13.1. MCP is an outward adapter, never the domain model.
 *
 * Two things this port deliberately does NOT have:
 *
 *  - **No session lifecycle.** The transport core became stateless in the 2026-07-28
 *    revision: the GET stream and protocol-level sessions were removed. Any client with
 *    `connect`/`disconnect`/session affinity predates that (§20).
 *  - **No credential handling.** Headers arrive already minted by the broker (§16.3). A
 *    client that took an API key would be token passthrough, which §13.2 forbids.
 */
export interface McpClient {
  readonly id: string;
  listTools(server: McpServerRef): Promise<McpToolDefinition[]>;
  callTool(
    server: McpServerRef,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<McpCallResult>;
}
