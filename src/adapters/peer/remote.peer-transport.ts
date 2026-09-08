import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PlatformError } from '../../domain/errors/platform.errors.js';
import type {
  PeerDispatch,
  PeerTask,
  PeerTransport,
} from '../../domain/ports/peer-transport.port.js';
import type { PeerTaskState } from '../../platform/persistence/schema.types.js';

/**
 * A2A's own state vocabulary, translated into ours at the boundary.
 *
 * Translation happens HERE rather than in the run loop so that §13.4's conformance
 * requirement has a single enforcement point: past this adapter, nothing can tell which
 * binding served the call.
 */
const REMOTE_STATE: Record<string, PeerTaskState> = {
  submitted: 'submitted',
  working: 'working',
  'input-required': 'input_required',
  'auth-required': 'input_required',
  completed: 'completed',
  failed: 'failed',
  canceled: 'cancelled',
  cancelled: 'cancelled',
  rejected: 'failed',
  unknown: 'failed',
};

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * The remote A2A binding: JSON-RPC over HTTPS (§13.4).
 *
 * Everything that makes this different from the local binding is contained here --
 * transport, the protocol's state names, its error codes, and the fact that budget and
 * cancellation are REQUESTS rather than guarantees once they cross a runtime we do not own.
 */
@Injectable()
export class RemotePeerTransport implements PeerTransport {
  readonly binding = 'remote' as const;
  private readonly log = new Logger(RemotePeerTransport.name);

  async send(dispatch: PeerDispatch): Promise<PeerTask> {
    const { peer, caller } = dispatch;
    const result = await this.rpc(peer, 'message/send', {
      message: {
        role: 'user',
        parts: [{ kind: 'text', text: asText(dispatch.input) }],
        messageId: randomUUID(),
        ...(dispatch.contextId ? { contextId: dispatch.contextId } : {}),
      },
      metadata: {
        // §5.2 and §0.1 travel across the hop. What the callee DOES with them is subject
        // to its own inbound trust policy -- we assert our identity, we do not assume it
        // is honoured, and the peer registry records which peers we extend that trust to.
        tenantRef: caller.tenantRef,
        traceId: caller.traceId,
        delegationDepth: caller.delegationDepth + 1,
        // §13.5 budget propagation, stated honestly as a REQUEST. We cannot enforce a
        // ceiling inside someone else's runtime; recording that we asked is the difference
        // between a limit and a hope, and `timeout_ms` is the containment that actually works.
        budgetHintMicros: caller.maxCostMicros,
      },
    });

    const task = result as { id?: string; contextId?: string; status?: { state?: string } };
    if (!task?.id) {
      throw new PlatformError('upstream_failure', `Peer "${peer.name}" returned no task id`);
    }
    return {
      taskId: task.id,
      contextId: task.contextId ?? null,
      state: this.state(task.status?.state),
      output: null,
      error: null,
    };
  }

  async get(peer: PeerDispatch['peer'], taskId: string): Promise<PeerTask> {
    const result = (await this.rpc(peer, 'tasks/get', { id: taskId })) as {
      id?: string;
      contextId?: string;
      status?: { state?: string; message?: unknown };
      artifacts?: unknown[];
    };
    const state = this.state(result?.status?.state);
    return {
      taskId,
      contextId: result?.contextId ?? null,
      state,
      output: state === 'completed' ? (result?.artifacts ?? result?.status?.message ?? null) : null,
      error:
        state === 'failed'
          ? { code: 'peer_failed', message: asText(result?.status?.message) || 'Peer task failed' }
          : null,
    };
  }

  async cancel(peer: PeerDispatch['peer'], taskId: string): Promise<void> {
    try {
      await this.rpc(peer, 'tasks/cancel', { id: taskId });
    } catch (e) {
      // Best effort, and said so out loud. A peer that refuses or cannot be reached does
      // not make OUR run uncancellable -- treating it as fatal would mean an unreachable
      // peer can pin a run open forever, which is the opposite of what cancel is for.
      this.log.warn(`cancel not accepted by peer ${peer.name}: ${(e as Error).message}`);
    }
  }

  private state(remote: string | undefined): PeerTaskState {
    if (!remote) return 'submitted';
    const mapped = REMOTE_STATE[remote];
    if (!mapped) {
      // An unknown state is reported as failed rather than guessed at. Optimistically
      // mapping it to `working` would hang the caller on a task nobody is advancing.
      this.log.warn(`unknown A2A task state "${remote}" — treating as failed`);
      return 'failed';
    }
    return mapped;
  }

  private async rpc(
    peer: PeerDispatch['peer'],
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!peer.endpointUrl) {
      throw new PlatformError('not_found', `Peer "${peer.name}" has no endpoint`);
    }
    // A remote peer is egress with someone else's latency (§16.1). Without a deadline the
    // call is an unbounded hold on one of our runs, decided by their availability.
    const signal = AbortSignal.timeout(peer.timeoutMs);
    let response: Response;
    try {
      response = await fetch(peer.endpointUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
        signal,
      });
    } catch (e) {
      throw new PlatformError('upstream_failure', `Peer "${peer.name}" unreachable: ${(e as Error).message}`);
    }

    if (!response.ok) {
      throw new PlatformError('upstream_failure', `Peer "${peer.name}" returned ${response.status}`, {
        status: response.status,
        body: (await response.text()).slice(0, 500),
      });
    }

    const body = (await response.json()) as JsonRpcResponse;
    if (body.error) {
      throw new PlatformError('upstream_failure', `Peer "${peer.name}": ${body.error.message}`, {
        rpcCode: body.error.code,
      });
    }
    return body.result;
  }
}

/** A2A messages are parts; our inputs are arbitrary JSON. One conversion, in one place. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  const parts = (value as { parts?: { text?: string }[] }).parts;
  if (Array.isArray(parts)) return parts.map((p) => p?.text ?? '').join('');
  const message = (value as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  return JSON.stringify(value);
}
