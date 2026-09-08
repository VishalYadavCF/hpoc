import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { MODEL_PROVIDER_REGISTRY, type ModelProvider } from '../domain/ports/model-provider.port.js';
import { ModelGateway } from '../domain/model-gateway/model-gateway.service.js';

/**
 * Registers provider adapters into the gateway at boot.
 *
 * The gateway does not import them: providers are adapter-band, the gateway is
 * domain-band, and the dependency may only point downward (§2.1). This binder lives in
 * the composition root, the one place allowed to know about both.
 */
@Injectable()
export class GatewayWiring implements OnApplicationBootstrap {
  constructor(
    @Inject(MODEL_PROVIDER_REGISTRY) private readonly providers: ModelProvider[],
    private readonly gateway: ModelGateway,
  ) {}

  onApplicationBootstrap(): void {
    for (const provider of this.providers) this.gateway.register(provider);
  }
}
