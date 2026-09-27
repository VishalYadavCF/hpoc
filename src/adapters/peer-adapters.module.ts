import { Module } from '@nestjs/common';
import { RemotePeerTransport } from './peer/remote.peer-transport.js';
import { REMOTE_PEER_TRANSPORT } from '../domain/ports/peer-transport.port.js';

@Module({
  providers: [
    RemotePeerTransport,
    { provide: REMOTE_PEER_TRANSPORT, useExisting: RemotePeerTransport },
  ],
  exports: [REMOTE_PEER_TRANSPORT],
})
export class PeerAdaptersModule {}
