import { Module } from '@nestjs/common';
import { DomainModule } from '../domain/domain.module.js';
import { RunLoop } from '../domain/run-engine/run-loop.service.js';
import { ModelGateway } from '../domain/model-gateway/model-gateway.service.js';
import { ToolRuntime } from '../domain/tool-runtime/tool-runtime.service.js';
import { CredentialBroker } from '../domain/identity/credential-broker.service.js';
import { GatewayWiring } from './gateway-wiring.js';

/**
 * The execution engine: the run loop and the only paths from a run to a model, a tool or a
 * credential.
 *
 * Imported by the worker alone. The api and scheduler create, read and recover runs, but
 * never drive one, so constructing a gateway there would only put a provider call one import
 * away from code that has no step, lease or budget around it.
 *
 * Lives in the composition root rather than the domain band because it binds GatewayWiring,
 * the one provider allowed to know both the gateway and the adapter list (§2.1).
 */
@Module({
  imports: [DomainModule],
  providers: [RunLoop, ModelGateway, ToolRuntime, CredentialBroker, GatewayWiring],
  exports: [RunLoop],
})
export class ExecutionModule {}
