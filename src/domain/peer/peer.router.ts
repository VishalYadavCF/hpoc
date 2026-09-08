import { Inject, Injectable } from '@nestjs/common';
import { LocalPeerTransport } from './local.peer-transport.js';
import {
  REMOTE_PEER_TRANSPORT,
  type PeerDispatch,
  type PeerTask,
  type PeerTransport,
} from '../ports/peer-transport.port.js';

/**
 * Resolves a peer's binding to a transport (§13.4).
 *
 * "Callers name a peer; the registry resolves the binding." This class is that sentence.
 * It exists so the choice is made in ONE place from a registry row, rather than by every
 * call site inspecting the peer and picking — which is how the two bindings drift apart.
 *
 * `binding` is `'local'` only because the interface demands a value; nothing reads it on
 * the router, and per-call resolution is the point.
 */
@Injectable()
export class PeerRouter implements PeerTransport {
  readonly binding = 'local' as const;

  constructor(
    // Local is a domain collaborator; remote arrives through a PORT, because only it
    // speaks to something outside this runtime.
    private readonly local: LocalPeerTransport,
    @Inject(REMOTE_PEER_TRANSPORT) private readonly remote: PeerTransport,
  ) {}

  private for(peer: PeerDispatch['peer']): PeerTransport {
    return peer.binding === 'remote' ? this.remote : this.local;
  }

  send(dispatch: PeerDispatch): Promise<PeerTask> {
    return this.for(dispatch.peer).send(dispatch);
  }

  get(peer: PeerDispatch['peer'], taskId: string): Promise<PeerTask> {
    return this.for(peer).get(peer, taskId);
  }

  cancel(peer: PeerDispatch['peer'], taskId: string): Promise<void> {
    return this.for(peer).cancel(peer, taskId);
  }
}
