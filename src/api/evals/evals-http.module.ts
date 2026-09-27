import { Module } from '@nestjs/common';
import { EvalsModule } from '../../bootstrap/modules/evals.module.js';
import { RegistryModule } from '../../bootstrap/modules/registry.module.js';
import { EvalsController } from './evals.controller.js';
import { DeploymentsController } from './deployments.controller.js';

@Module({
  imports: [EvalsModule, RegistryModule],
  controllers: [
    EvalsController,
    // Shares the /v1/agents prefix with AgentsController but collides with none of its
    // routes: every route here is /:name/<literal>, and AgentsController's widest pattern
    // is a single-segment `@Get(':name')`. Order is therefore not load-bearing, which is
    // why the two can live in different modules.
    DeploymentsController,
  ],
})
export class EvalsHttpModule {}
