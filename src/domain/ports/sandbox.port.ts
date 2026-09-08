export const SANDBOX = Symbol('Sandbox');

export interface SandboxRequest {
  profile: string;
  toolRef: string;
  /** Already-minted, audience-restricted headers. Never a raw secret, never in model context. */
  headers: Record<string, string>;
  endpointUrl: string | null;
  args: Record<string, unknown>;
  timeoutMs: number;
  /**
   * The registered request shape (§8.1). Absent means the legacy default: POST to
   * `endpointUrl` with `args` as the JSON body.
   *
   * This is what makes an HTTP tool general rather than a first-party RPC call. Without
   * it, every third-party API needs a shim service whose only job is to accept our one
   * hardcoded shape -- so `origin = 'http'` described the caller's convenience rather
   * than the protocol.
   */
  http?: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    pathTemplate: string | null;
    argPlacement: 'query' | 'body' | 'none' | null;
    staticHeaders: Record<string, string>;
  };
  /**
   * The tool's own body, for `origin = 'function'` (§8.1). Present means "run this",
   * absent means the tool is an outbound call rather than code.
   *
   * Carried as data rather than baked into an image for the same reason `http` is data:
   * a tool edit should be an UPDATE, not a rebuild and a deploy.
   */
  code?: CodeBody;
}

export type CodeRuntime = 'node' | 'python';

export interface CodeBody {
  runtime: CodeRuntime;
  source: string;
}

export interface SandboxResult {
  ok: boolean;
  output?: unknown;
  error?: { message: string; retryable: boolean };
  instanceId: string;
}

/**
 * §0.4: ONE isolation boundary for all agent types, chosen before the first tool executes.
 *
 * Phase 1 ships an in-process HTTP egress sandbox, which is honest for tools that are
 * HTTP calls to first-party services and nothing more. It is NOT sufficient for a coding
 * agent that executes agent-authored code -- see ai-docs/client-interactions/03. The seam
 * is `tools.sandbox_profile`, so the upgrade to container or microVM is a registry change
 * rather than a rewrite of every call site.
 */
export interface Sandbox {
  readonly id: string;
  execute(request: SandboxRequest): Promise<SandboxResult>;
}
