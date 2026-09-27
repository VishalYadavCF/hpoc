import { Module } from '@nestjs/common';
import { EchoProvider } from './providers/echo.provider.js';
import {
  AnthropicProvider,
  GoogleProvider,
  OpenAiCompatibleProvider,
} from './providers/langchain.provider.js';
import { InMemoryResponseCache } from './cache/in-memory.response-cache.js';
import { MODEL_PROVIDER_REGISTRY, type ModelProvider } from '../domain/ports/model-provider.port.js';
import { RESPONSE_CACHE } from '../domain/ports/response-cache.port.js';

/**
 * Model providers and the model-response cache.
 *
 * Adding a provider is one entry here and one row in `models`. The OpenAI-compatible
 * adapter already covers LiteLLM, OpenRouter, vLLM, Groq and Together, since they share a
 * wire shape -- a LiteLLM proxy is a model row with provider 'openai-compatible' and its own
 * base_url. Anthropic and Google get their own classes because their wire shapes genuinely
 * differ.
 */
@Module({
  providers: [
    EchoProvider,
    OpenAiCompatibleProvider,
    AnthropicProvider,
    GoogleProvider,
    InMemoryResponseCache,
    {
      provide: MODEL_PROVIDER_REGISTRY,
      inject: [EchoProvider, OpenAiCompatibleProvider, AnthropicProvider, GoogleProvider],
      useFactory: (...providers: ModelProvider[]) => providers,
    },
    { provide: RESPONSE_CACHE, useExisting: InMemoryResponseCache },
  ],
  exports: [MODEL_PROVIDER_REGISTRY, RESPONSE_CACHE],
})
export class ModelProviderAdaptersModule {}
