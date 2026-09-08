import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import type {
  McpCallResult,
  McpClient,
  McpServerRef,
  McpToolDefinition,
} from '../../../domain/ports/mcp-client.port.js';

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * MCP over stdio, against a subprocess.
 *
 * The one place §13.1's "connection reuse applies only to stdio subprocesses" bites: an
 * HTTP server is stateless and needs nothing kept, but a stdio server IS a process, and
 * spawning one per tool call would pay process start-up on every invocation.
 *
 * So the process is reused and keyed by server id — but that is process management, not
 * the protocol session the 2026-07-28 revision removed. Nothing here resumes a stream or
 * carries a session id.
 */
@Injectable()
export class StdioMcpClient implements McpClient, OnModuleDestroy {
  readonly id = 'stdio';
  private readonly log = new Logger(StdioMcpClient.name);
  private readonly processes = new Map<string, { child: ChildProcessWithoutNullStreams; buffer: string }>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  async listTools(server: McpServerRef): Promise<McpToolDefinition[]> {
    const result = await this.rpc(server, 'tools/list', {}, 15_000);
    const tools = (result['tools'] ?? []) as {
      name?: string; description?: string; inputSchema?: Record<string, unknown>;
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
      const result = await this.rpc(server, 'tools/call', { name: toolName, arguments: args }, timeoutMs);
      if (result['isError'] === true) {
        return { ok: false, content: result['content'] ?? null, error: { message: 'MCP tool reported an error', retryable: false } };
      }
      return { ok: true, content: result['content'] ?? result };
    } catch (e) {
      const message = (e as Error).message;
      return { ok: false, content: null, error: { message, retryable: /timeout/i.test(message) } };
    }
  }

  private async rpc(
    server: McpServerRef,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const proc = this.ensureProcess(server);
    const id = this.nextId++;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP stdio call timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private ensureProcess(server: McpServerRef): { child: ChildProcessWithoutNullStreams; buffer: string } {
    const existing = this.processes.get(server.id);
    if (existing && !existing.child.killed) return existing;

    // The command lives in the registry, never in a spec — §18.5 forbids inline server
    // definitions, and for stdio an inline definition would be arbitrary code execution.
    const command = (server as McpServerRef & { command?: string[] }).command;
    if (!command || command.length === 0) {
      throw new Error(`stdio MCP server ${server.name} has no registered command`);
    }

    const child = spawn(command[0]!, command.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Only the broker-minted headers reach the child, never the worker's environment:
      // a subprocess inheriting DATABASE_URL is a credential leak with extra steps.
      env: { PATH: process.env['PATH'] ?? '', ...server.headers },
    });

    const entry = { child, buffer: '' };
    child.stdout.on('data', (chunk: Buffer) => {
      entry.buffer += chunk.toString('utf8');
      // Newline-delimited JSON-RPC: a frame may span chunks, so hold the remainder.
      let newline = entry.buffer.indexOf('\n');
      while (newline !== -1) {
        const line = entry.buffer.slice(0, newline).trim();
        entry.buffer = entry.buffer.slice(newline + 1);
        if (line) this.dispatch(line);
        newline = entry.buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) =>
      this.log.debug(`[${server.name}] ${chunk.toString('utf8').trim().slice(0, 300)}`),
    );
    child.on('exit', (code) => {
      this.log.warn(`stdio MCP server ${server.name} exited with ${String(code)}`);
      this.processes.delete(server.id);
      // Callers waiting on a dead process must fail rather than hang to their timeout.
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('MCP stdio server exited'));
        this.pending.delete(id);
      }
    });

    this.processes.set(server.id, entry);
    return entry;
  }

  private dispatch(line: string): void {
    let message: { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return; // servers log to stdout more often than they should
    }
    if (typeof message.id !== 'number') return; // a notification, not a reply
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
    else waiting.resolve(message.result ?? {});
  }

  onModuleDestroy(): void {
    for (const { child } of this.processes.values()) child.kill('SIGTERM');
    this.processes.clear();
  }
}

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
