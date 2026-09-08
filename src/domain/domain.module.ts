import { Module } from '@nestjs/common';
import { AdmissionService } from './admission/admission.service.js';
import { AgentVersionService } from './registry/agent-version.service.js';
import { CatalogService } from './registry/catalog.service.js';
import { EventLog } from './event-log/event-log.service.js';
import { QueueService } from './queue/queue.service.js';
import { CheckpointService } from './checkpoint/checkpoint.service.js';
import { RunService } from './run-engine/run.service.js';
import { RunLoop } from './run-engine/run-loop.service.js';
import { ModelGateway } from './model-gateway/model-gateway.service.js';
import { ToolRuntime } from './tool-runtime/tool-runtime.service.js';
import { CredentialBroker } from './identity/credential-broker.service.js';
import { InteractionService } from './interaction/interaction.service.js';
import { ThreadService } from './thread/thread.service.js';
import { AgentService } from './agent/agent.service.js';
import { TriggerService } from './trigger/trigger.service.js';
import { OutboxService } from './outbox/outbox.service.js';
import { MemoryEngine } from './memory/memory.engine.js';
import { TraceService } from './observability/trace.service.js';
import { SpanProjectionService } from './observability/span-projection.service.js';
import { AnalyticsService } from './observability/analytics.service.js';
import { FeedbackService } from './observability/feedback.service.js';
import { ArtifactService } from './artifact/artifact.service.js';
import { McpRegistryService } from './mcp/mcp-registry.service.js';
import { BackpressureService } from './governance/backpressure.service.js';
import { BudgetService } from './governance/budget.service.js';
import { ContextEngine } from './context/context.engine.js';
import { KnowledgeService } from './knowledge/knowledge.service.js';
import { SkillService } from './skills/skill.service.js';
import { PeerService } from './peer/peer.service.js';
import { PromptService } from './prompt/prompt.service.js';
import { PolicyService } from './policy/policy.service.js';
import { LocalPeerTransport } from './peer/local.peer-transport.js';
import { PeerRouter } from './peer/peer.router.js';
import { PEER_TRANSPORT } from './ports/peer-transport.port.js';
import { RunReadService } from './run-engine/run-read.service.js';
import { RunRecoveryService } from './run-engine/run-recovery.service.js';
import { ReplayService } from './run-engine/replay.service.js';
import { EvalService } from './eval/eval.service.js';
import { EvalSuiteService } from './eval/suite.service.js';
import { DeploymentService } from './eval/deployment.service.js';
import { AdaptersModule } from '../adapters/adapters.module.js';

/**
 * The domain band. It imports AdaptersModule for the port bindings and nothing else --
 * it never imports an adapter class directly, which is what `tsconfig.core.json` and the
 * dependency-cruiser rules check mechanically rather than by review (§2.1, §0.3).
 */
@Module({
  imports: [AdaptersModule],
  providers: [
    AdmissionService,
    AgentVersionService,
    CatalogService,
    EventLog,
    QueueService,
    CheckpointService,
    RunService,
    RunLoop,
    ModelGateway,
    ToolRuntime,
    CredentialBroker,
    InteractionService,
    ThreadService,
    AgentService,
    TriggerService,
    OutboxService,
    MemoryEngine,
    TraceService,
    SpanProjectionService,
    AnalyticsService,
    FeedbackService,
    ArtifactService,
    McpRegistryService,
    BackpressureService,
    BudgetService,
    ContextEngine,
    KnowledgeService,
    SkillService,
    PeerService,
    PromptService,
    PolicyService,
    LocalPeerTransport,
    PeerRouter,
    RunReadService,
    RunRecoveryService,
    ReplayService,
    EvalService,
    EvalSuiteService,
    DeploymentService,
    // The ROUTER is the port, never a concrete binding: §13.4 has the registry resolve
    // local vs remote per call, so nothing downstream can bind to one of them.
    { provide: PEER_TRANSPORT, useExisting: PeerRouter },
  ],
  // AdaptersModule is re-exported so the composition root can inject port tokens
  // (GatewayWiring needs the provider list). The domain still never imports an adapter
  // class -- only the tokens -- which is what tsconfig.core.json checks.
  exports: [
    AdaptersModule,
    AdmissionService, AgentVersionService, CatalogService, EventLog, QueueService, CheckpointService,
    RunService, RunLoop, ModelGateway, ToolRuntime, CredentialBroker,
    InteractionService, ThreadService, AgentService, TriggerService, OutboxService,
    MemoryEngine,
    TraceService,
    SpanProjectionService,
    AnalyticsService,
    FeedbackService,
    ArtifactService,
    McpRegistryService,
    BackpressureService,
    BudgetService,
    ContextEngine,
    KnowledgeService,
    SkillService,
    PeerService,
    PromptService,
    PolicyService,
    PeerRouter,
    PEER_TRANSPORT,
    RunReadService,
    RunRecoveryService,
    ReplayService,
    EvalService,
    EvalSuiteService,
    DeploymentService,
  ],
})
export class DomainModule {}
