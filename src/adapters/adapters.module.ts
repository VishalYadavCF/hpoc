import { Module } from '@nestjs/common';
import { EchoAdapter } from './framework/echo/echo.adapter.js';
import { PipelineAdapter } from './framework/pipeline/pipeline.adapter.js';
import { DeepAgentsAdapter } from './framework/deep-agents/deep-agents.adapter.js';
import { EchoProvider } from './providers/echo.provider.js';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.provider.js';
import { AnthropicProvider } from './providers/anthropic.provider.js';
import { GoogleProvider } from './providers/google.provider.js';
import { EnvSecretStore } from './secrets/env.secret-store.js';
import { PostgresMemoryStore } from './memory/postgres.memory-store.js';
import { PgVectorIndex } from './memory/pgvector.index.js';
import { PgVectorKnowledgeIndex } from './knowledge/pgvector.knowledge-index.js';
import { RemotePeerTransport } from './peer/remote.peer-transport.js';
import {
  BudgetGrader, ContainsGrader, ExactGrader, JsonPathGrader, NotContainsGrader, RegexGrader,
} from './graders/deterministic.graders.js';
import { LlmJudgeGrader } from './graders/llm-judge.grader.js';
import { GraderRegistryImpl } from './graders/grader.registry.js';
import { DeterministicEmbedder } from './memory/deterministic.embedder.js';
import { GeminiEmbedder } from './memory/gemini.embedder.js';
import { InMemoryCache } from './memory/in-memory.cache.js';
import { PostgresRelationIndex } from './memory/postgres.relation-index.js';
import { ExtractiveSummarizer } from './memory/extractive.summarizer.js';
import { FilesystemObjectStore } from './storage/filesystem.object-store.js';
import { StreamableHttpMcpClient } from './protocol/mcp/streamable-http.mcp-client.js';
import { InMemoryResponseCache } from './cache/in-memory.response-cache.js';
import { StdioMcpClient } from './protocol/mcp/stdio.mcp-client.js';
import { McpRouter } from './protocol/mcp/mcp.router.js';
import { HttpEgressSandbox } from './sandbox/http-egress.sandbox.js';
import { ContainerSandbox } from './sandbox/container.sandbox.js';
import { SandboxRouter } from './sandbox/sandbox.router.js';
import { OtlpTraceExporter } from './observability/otlp.exporter.js';
import { FRAMEWORK_ADAPTER, type FrameworkAdapter } from '../domain/ports/framework-adapter.port.js';
import { SANDBOX } from '../domain/ports/sandbox.port.js';
import { MODEL_PROVIDER_REGISTRY } from '../domain/ports/model-provider.port.js';
import { SECRET_STORE } from '../domain/ports/secret-store.port.js';
import { KNOWLEDGE_INDEX } from '../domain/ports/knowledge.port.js';
import { REMOTE_PEER_TRANSPORT } from '../domain/ports/peer-transport.port.js';
import { GRADER_REGISTRY } from '../domain/ports/grader.port.js';
import {
  EMBEDDER, MEMORY_CACHE, MEMORY_STORE, RELATION_INDEX, SUMMARIZER, VECTOR_INDEX,
} from '../domain/ports/memory.port.js';
import { OBJECT_STORE } from '../domain/ports/object-store.port.js';
import { MCP_CLIENT } from '../domain/ports/mcp-client.port.js';
import { RESPONSE_CACHE } from '../domain/ports/response-cache.port.js';
import { TRACE_EXPORTER } from '../domain/ports/trace-exporter.port.js';
import type { ModelProvider } from '../domain/ports/model-provider.port.js';

/**
 * Every adapter, bound to its port token.
 *
 * Adding a framework or a provider is one line here. That is the test §0.3 asks for: if
 * adding the second orchestration adapter had required changes elsewhere, the
 * abstraction would already have leaked.
 */
@Module({
  providers: [
    EchoAdapter,
    PipelineAdapter,
    DeepAgentsAdapter,
    EchoProvider,
    OpenAiCompatibleProvider,
    AnthropicProvider,
    GoogleProvider,
    HttpEgressSandbox,
    ContainerSandbox,
    SandboxRouter,
    OtlpTraceExporter,
    EnvSecretStore,
    PostgresMemoryStore,
    PgVectorIndex,
    PgVectorKnowledgeIndex,
    RemotePeerTransport,
    ExactGrader, ContainsGrader, NotContainsGrader, RegexGrader, JsonPathGrader,
    BudgetGrader, LlmJudgeGrader, GraderRegistryImpl,
    DeterministicEmbedder,
    GeminiEmbedder,
    InMemoryCache,
    PostgresRelationIndex,
    ExtractiveSummarizer,
    FilesystemObjectStore,
    StreamableHttpMcpClient,
    StdioMcpClient,
    McpRouter,
    InMemoryResponseCache,
    {
      provide: FRAMEWORK_ADAPTER,
      inject: [EchoAdapter, PipelineAdapter, DeepAgentsAdapter],
      useFactory: (...adapters: FrameworkAdapter[]) => adapters,
    },
    // The router IS the single boundary §0.4 asks for: the platform picks isolation from
    // the tool's declared profile, and a tool can never pick its own.
    { provide: SANDBOX, useExisting: SandboxRouter },
    { provide: SECRET_STORE, useExisting: EnvSecretStore },
    // §16.1 Constraint 1 lives inside this adapter: it refuses an endpoint it cannot
    // establish as internal, so "self-hosted without exception" is code, not a runbook.
    { provide: TRACE_EXPORTER, useExisting: OtlpTraceExporter },

    // The five memory seams (§6). Each is one line; swapping pgvector for a dedicated
    // vector database, or Postgres for a document store, changes this file and nothing
    // in src/domain.
    { provide: MEMORY_STORE, useExisting: PostgresMemoryStore },
    { provide: VECTOR_INDEX, useExisting: PgVectorIndex },
    { provide: KNOWLEDGE_INDEX, useExisting: PgVectorKnowledgeIndex },
    { provide: REMOTE_PEER_TRANSPORT, useExisting: RemotePeerTransport },
    { provide: GRADER_REGISTRY, useExisting: GraderRegistryImpl },
    {
      // A real embedder when one is configured, a deterministic offline one otherwise.
      // Selected at boot rather than per call: switching embedders mid-corpus leaves the
      // index half in each vector space, which degrades silently.
      provide: EMBEDDER,
      inject: [DeterministicEmbedder, GeminiEmbedder],
      useFactory: (offline: DeterministicEmbedder, gemini: GeminiEmbedder) =>
        GeminiEmbedder.isConfigured() && process.env['EMBEDDER'] !== 'deterministic'
          ? gemini
          : offline,
    },
    { provide: MEMORY_CACHE, useExisting: InMemoryCache },
    { provide: RELATION_INDEX, useExisting: PostgresRelationIndex },
    { provide: SUMMARIZER, useExisting: ExtractiveSummarizer },
    // §11.2's carve-out from the Postgres-centric bet. S3/GCS is one class on this port.
    { provide: OBJECT_STORE, useExisting: FilesystemObjectStore },
    // §2.1: a protocol adapter, never the domain model. `tsconfig.core.json` compiles the
    // core with this excluded, which is what keeps that claim honest.
    // The registry decides the transport, never the caller (§18.5).
    { provide: MCP_CLIENT, useExisting: McpRouter },
    { provide: RESPONSE_CACHE, useExisting: InMemoryResponseCache },
    {
      // Adding a provider is one entry here and one row in `models`. The OpenAI-compatible
      // adapter already covers LiteLLM, OpenRouter, vLLM, Groq and Together, since they
      // share a wire shape -- a LiteLLM proxy is a model row with provider
      // 'openai-compatible' and its own base_url. Anthropic and Google get their own
      // classes because their wire shapes genuinely differ.
      provide: MODEL_PROVIDER_REGISTRY,
      inject: [EchoProvider, OpenAiCompatibleProvider, AnthropicProvider, GoogleProvider],
      useFactory: (...providers: ModelProvider[]) => providers,
    },
  ],
  exports: [
    FRAMEWORK_ADAPTER, SANDBOX, SECRET_STORE, MODEL_PROVIDER_REGISTRY,
    MEMORY_STORE, VECTOR_INDEX, EMBEDDER, MEMORY_CACHE, RELATION_INDEX, SUMMARIZER,
    KNOWLEDGE_INDEX,
    REMOTE_PEER_TRANSPORT,
    GRADER_REGISTRY,
    OBJECT_STORE, MCP_CLIENT, RESPONSE_CACHE, TRACE_EXPORTER,
  ],
})
export class AdaptersModule {}
