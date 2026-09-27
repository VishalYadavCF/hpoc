import { Module } from '@nestjs/common';
import { RunLoop } from '../../domain/run-engine/run-loop.service.js';
import { ModelGateway } from '../../domain/model-gateway/model-gateway.service.js';
import { ToolRuntime } from '../../domain/tool-runtime/tool-runtime.service.js';
import { CredentialBroker } from '../../domain/identity/credential-broker.service.js';
import { LocalPeerTransport } from '../../domain/peer/local.peer-transport.js';
import { PeerRouter } from '../../domain/peer/peer.router.js';
import { PEER_TRANSPORT } from '../../domain/ports/peer-transport.port.js';
import { FrameworkAdaptersModule } from '../../adapters/framework-adapters.module.js';
import { ModelProviderAdaptersModule } from '../../adapters/model-provider-adapters.module.js';
import { SecretAdaptersModule } from '../../adapters/secret-adapters.module.js';
import { SandboxAdaptersModule } from '../../adapters/sandbox-adapters.module.js';
import { McpAdaptersModule } from '../../adapters/mcp-adapters.module.js';
import { PeerAdaptersModule } from '../../adapters/peer-adapters.module.js';
import { GatewayWiring } from '../gateway-wiring.js';
import { RunStateModule } from './run-state.module.js';
import { RegistryModule } from './registry.module.js';
import { GovernanceModule } from './governance.module.js';
import { MemoryModule } from './memory.module.js';
import { KnowledgeModule } from './knowledge.module.js';
import { ArtifactsModule } from './artifacts.module.js';

/**
 * The execution engine: the run loop and the only paths from a run to a model, a tool, a
 * credential or a peer.
 *
 * Imported by the worker alone. The api and scheduler create, read and recover runs, but
 * never drive one, so constructing a gateway there would only put a provider call one import
 * away from code that has no step, lease or budget around it.
 */
@Module({
  imports: [
    RunStateModule,
    RegistryModule,
    GovernanceModule,
    MemoryModule,
    KnowledgeModule,
    ArtifactsModule,
    FrameworkAdaptersModule,
    ModelProviderAdaptersModule,
    SecretAdaptersModule,
    SandboxAdaptersModule,
    McpAdaptersModule,
    PeerAdaptersModule,
  ],
  providers: [
    RunLoop,
    ModelGateway,
    ToolRuntime,
    CredentialBroker,
    LocalPeerTransport,
    PeerRouter,
    // The ROUTER is the port, never a concrete binding: §13.4 has the registry resolve
    // local vs remote per call, so nothing downstream can bind to one of them.
    { provide: PEER_TRANSPORT, useExisting: PeerRouter },
    // The one provider allowed to know both the gateway and the adapter list (§2.1).
    GatewayWiring,
  ],
  exports: [RunLoop],
})
export class ExecutionModule {}
