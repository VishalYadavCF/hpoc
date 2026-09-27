import { Module } from '@nestjs/common';
import { RegistryModule } from '../../bootstrap/modules/registry.module.js';
import { RunsModule } from '../../bootstrap/modules/runs.module.js';
import { KnowledgeModule } from '../../bootstrap/modules/knowledge.module.js';
import { AgentsController } from './agents.controller.js';
import { McpController } from './mcp.controller.js';
import { SkillsController } from './skills.controller.js';
import { KnowledgeController } from './knowledge.controller.js';
import { PeersController } from './peers.controller.js';
import { PromptsController } from './prompts.controller.js';
import { PoliciesController } from './policies.controller.js';
import { CatalogController } from './catalog.controller.js';

@Module({
  imports: [RegistryModule, RunsModule, KnowledgeModule],
  controllers: [
    AgentsController, McpController, SkillsController, KnowledgeController, PeersController,
    PromptsController, PoliciesController, CatalogController,
  ],
})
export class ControlPlaneHttpModule {}
