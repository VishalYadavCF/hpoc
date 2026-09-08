import type { Tx } from '../../platform/persistence/database.js';
import type { PeerTaskState } from '../../platform/persistence/schema.types.js';

export const PEER_TRANSPORT = Symbol('PeerTransport');
/** The remote binding alone is an adapter; the local one is the engine dispatching to itself. */
export const REMOTE_PEER_TRANSPORT = Symbol('RemotePeerTransport');

/**
 * The normalised task view both bindings must produce.
 *
 * §13.4 requires local and remote to be **semantically identical** -- same states, same
 * ordering, same error taxonomy, same cancellation. That is only checkable if there is one
 * shape to check, so translation from a remote vocabulary happens inside the adapter and
 * never leaks past this type.
 */
export interface PeerTask {
  taskId: string;
  contextId: string | null;
  state: PeerTaskState;
  output: unknown;
  error: { code: string; message: string } | null;
}

export interface PeerDispatch {
  tx: Tx;
  peer: {
    id: string;
    name: string;
    binding: 'local' | 'remote';
    localAgentId: string | null;
    endpointUrl: string | null;
    timeoutMs: number;
  };
  /** The calling run, whose identity, tenancy and budget travel with the call. */
  caller: {
    runId: string;
    stepId: string;
    orgId: string;
    namespaceId: string;
    tenantRef: string;
    traceId: string | null;
    callerPrincipalId: string;
    onBehalfOfPrincipalId: string | null;
    authorizingHumanId: string | null;
    /** §13.5: the ORIGINATING tenant's ceiling, decremented across the hop. */
    maxCostMicros: string | null;
    delegationDepth: number;
    delegationChain: unknown;
  };
  input: unknown;
  /** Reuses the peer's thread when the caller is continuing an existing conversation. */
  contextId?: string | null;
}

/**
 * The A2A dispatcher seam (§13.4).
 *
 * Two bindings sit behind it. *Local* dispatches straight into the execution engine as a
 * child run in the same event log -- no JSON-RPC, no HTTP round trip to ourselves.
 * *Remote* speaks JSON-RPC over HTTPS with SSE.
 *
 * The port exists so callers name a peer and the REGISTRY resolves the binding. A caller
 * that could tell the difference would encode the topology of today's deployment into its
 * spec, and moving an agent out of this runtime would then be a caller-visible change --
 * which §13.4 calls out as a bug discovered during a migration at the worst moment.
 */
export interface PeerTransport {
  readonly binding: 'local' | 'remote';
  /** Dispatches and returns the task's initial state. Never blocks to completion. */
  send(dispatch: PeerDispatch): Promise<PeerTask>;
  /** Current state. For local this reads a run row; for remote it is `tasks/get`. */
  get(peer: PeerDispatch['peer'], taskId: string): Promise<PeerTask>;
  /** §13.5 cancellation propagation. Best-effort across a boundary we do not own. */
  cancel(peer: PeerDispatch['peer'], taskId: string): Promise<void>;
}
