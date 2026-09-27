import { Module } from '@nestjs/common';
import { AdmissionService } from '../../domain/admission/admission.service.js';
import { AgentService } from '../../domain/agent/agent.service.js';
import { AgentVersionService } from '../../domain/registry/agent-version.service.js';
import { CatalogService } from '../../domain/registry/catalog.service.js';
import { SkillService } from '../../domain/skills/skill.service.js';
import { PromptService } from '../../domain/prompt/prompt.service.js';
import { PolicyService } from '../../domain/policy/policy.service.js';
import { PeerService } from '../../domain/peer/peer.service.js';
import { McpRegistryService } from '../../domain/mcp/mcp-registry.service.js';
import { DeploymentService } from '../../domain/eval/deployment.service.js';
import { StorageAdaptersModule } from '../../adapters/storage-adapters.module.js';
import { McpAdaptersModule } from '../../adapters/mcp-adapters.module.js';

/**
 * What an agent is: its registration, admission, immutable versions, and the prompts,
 * skills, policies, MCP servers and peers a spec may name.
 *
 * One module because admission resolves all of them, and deployments with it: an agent's
 * current version is a deployment decision, and splitting that out would put AgentService on
 * one side of a module boundary and the routing it cannot work without on the other.
 *
 * Peer REGISTRATION is here; peer EXECUTION is in ExecutionModule. Admission needs to know a
 * peer exists, and calling one needs agents -- keeping the two apart is what keeps the
 * graph acyclic.
 */
@Module({
  imports: [StorageAdaptersModule, McpAdaptersModule],
  providers: [
    AdmissionService,
    AgentService,
    AgentVersionService,
    CatalogService,
    SkillService,
    PromptService,
    PolicyService,
    PeerService,
    McpRegistryService,
    DeploymentService,
  ],
  exports: [
    AdmissionService,
    AgentService,
    AgentVersionService,
    CatalogService,
    SkillService,
    PromptService,
    PolicyService,
    PeerService,
    McpRegistryService,
    DeploymentService,
  ],
})
export class RegistryModule {}
