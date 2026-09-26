import { Injectable } from '@nestjs/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { AIMessageChunk, BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { PlatformError } from '../../domain/errors/platform.errors.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
} from '../../domain/ports/model-provider.port.js';

/**
 * Vendor access through LangChain's `BaseChatModel`, rather than hand-written HTTP.
 *
 * ## Why the wire protocol left this repo
 *
 * These adapters used to speak each vendor's REST API directly -- request shaping,
 * response parsing, and an SSE decoder buffering `data:` frames across TCP reads. All of
 * it was verified only against local servers we wrote ourselves, which cannot tell us our
 * reading of a protocol is wrong: a fake that shares the misconception agrees with it.
 * `ap-executor` had already been running the same vendors through `BaseChatModel` in
 * production, so the choice was between two implementations of one protocol where only
 * one had ever met a real vendor.
 *
 * ## What deliberately did NOT move
 *
 * Everything §9 and §16.1 care about stays in `ModelGateway`: the residency gate, the
 * tenant-keyed response cache, per-call credential brokering, fallback, and cost
 * attribution. A provider here is only "turn this request into that vendor's call" --
 * it never sees an org, a tenant, or a budget. Keeping the `ModelProvider` port intact is
 * what let the vendor implementation be replaced without the gateway noticing.
 *
 * Credentials arrive per call and are used to construct a client per call. They are never
 * held on the injected singleton and never written to `process.env` -- under concurrency
 * that is precisely how one tenant's key reaches another tenant's request (§16.3), and
 * ap-executor carries a comment recording that it had exactly that bug.
 *
 * ## Retry belongs to the gateway, not the client
 *
 * Every vendor SDK retries by default. Left on, a 500 is retried by the SDK, and THEN
 * `ModelGateway` falls back to a second model -- so one failure becomes several calls, the
 * budget is charged for all of them, and a test asserting "a 500 surfaces" hangs for the
 * length of the backoff instead. Retry policy depends on budgets, backpressure and the
 * effect contract, none of which a vendor client can see, so `maxRetries: 0` puts the
 * decision where those live.
 */
export abstract class LangChainProvider implements ModelProvider {
  abstract readonly id: string;

  /** Construct the vendor client. Per call, never cached -- see the class comment. */
  protected abstract build(
    request: ModelRequest,
    credentials: Record<string, string>,
  ): BaseChatModel;

  protected apiKey(credentials: Record<string, string>): string {
    const apiKey = credentials['apiKey'];
    if (!apiKey) {
      throw new PlatformError('upstream_failure', 'No apiKey supplied by the credential broker');
    }
    return apiKey;
  }

  async complete(
    request: ModelRequest,
    credentials: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const model = this.bind(this.build(request, credentials), request);
    const result = await model.invoke(messagesFor(request), { signal });
    return toModelResponse(result as AIMessage);
  }

  async *stream(
    request: ModelRequest,
    credentials: Record<string, string>,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamChunk> {
    const model = this.bind(this.build(request, credentials), request);

    for await (const chunk of await model.stream(messagesFor(request), { signal })) {
      const mapped = toStreamChunk(chunk);
      // A chunk carrying neither text nor a tool-call fragment is protocol bookkeeping
      // (role announcements, finish reasons). Forwarding it would make a consumer
      // counting chunks believe output arrived when none did.
      if (mapped) yield mapped;
    }
  }

  /**
   * Native tool calling, per the port's own reasoning about why text-parsed calls fail.
   *
   * `ToolSchema.parameters` is JSON Schema, which is what every vendor's function-calling
   * API wants; the OpenAI function envelope is the shape LangChain normalises FROM for
   * all three vendors.
   *
   * It is NOT true that no per-vendor branch is needed, which this comment used to claim.
   * Gemini accepts a restricted subset and rejects the whole request over constructs that are
   * ordinary JSON Schema elsewhere, so `toolParameters` is the seam for narrowing per vendor.
   */
  private bind(model: BaseChatModel, request: ModelRequest): BaseChatModel {
    if (!request.tools?.length) return model;
    if (typeof model.bindTools !== 'function') {
      throw new PlatformError(
        'upstream_failure',
        `Provider ${this.id} does not support tool calling`,
      );
    }
    return model.bindTools(
      request.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: this.toolParameters(t.parameters),
        },
      })),
    ) as unknown as BaseChatModel;
  }

  /** Per-vendor narrowing of a tool's JSON Schema. Identity unless a vendor needs less. */
  protected toolParameters(parameters: Record<string, unknown>): Record<string, unknown> {
    return parameters;
  }
}

/** OpenAI and anything speaking its chat-completions API (LiteLLM, OpenRouter, vLLM). */
@Injectable()
export class OpenAiCompatibleProvider extends LangChainProvider {
  readonly id = 'openai-compatible';

  protected build(request: ModelRequest, credentials: Record<string, string>): BaseChatModel {
    return new ChatOpenAI({
      apiKey: this.apiKey(credentials),
      model: request.providerModelId,
      maxRetries: 0,
      ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}),
      configuration: { baseURL: credentials['baseUrl'] ?? 'https://api.openai.com/v1' },
    });
  }
}

@Injectable()
export class AnthropicProvider extends LangChainProvider {
  readonly id = 'anthropic';

  protected build(request: ModelRequest, credentials: Record<string, string>): BaseChatModel {
    return new ChatAnthropic({
      apiKey: this.apiKey(credentials),
      model: request.providerModelId,
      // Anthropic requires a token ceiling; the previous adapter defaulted to 1024 and
      // callers depend on that rather than on a vendor default that may change.
      maxTokens: request.maxOutputTokens ?? 1024,
      maxRetries: 0,
      anthropicApiUrl: credentials['baseUrl'] ?? 'https://api.anthropic.com',
    });
  }
}

@Injectable()
export class GoogleProvider extends LangChainProvider {
  readonly id = 'google';

  protected build(request: ModelRequest, credentials: Record<string, string>): BaseChatModel {
    return new ChatGoogleGenerativeAI({
      apiKey: this.apiKey(credentials),
      model: request.providerModelId,
      maxRetries: 0,
      ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
      ...(credentials['baseUrl'] ? { baseUrl: credentials['baseUrl'] } : {}),
    });
  }

  protected override toolParameters(parameters: Record<string, unknown>): Record<string, unknown> {
    return geminiSafeSchema(parameters) as Record<string, unknown>;
  }
}

/**
 * JSON Schema keywords Gemini's function-declaration proto has no field for. It rejects the
 * WHOLE request rather than ignoring them, so they are removed rather than passed and hoped for.
 */
const GEMINI_UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  'additionalProperties',
  'const',
  'default',
  'examples',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'patternProperties',
  'definitions',
  '$defs',
]);

/**
 * Narrows ordinary JSON Schema to the subset Gemini accepts.
 *
 * Two things bite in practice, both produced by perfectly normal Zod:
 *
 *  - `z.string().nullable()` becomes `type: ["string", "null"]`. Gemini's proto types `type` as a
 *    single enum value, so an array is "Proto field is not repeating, cannot start list" and the
 *    entire request 400s — one nullable field on one tool takes down the whole run.
 *  - Keywords above have no proto field at all, and are likewise fatal rather than ignored.
 *
 * Nullability is dropped rather than encoded: Gemini expresses optionality through `required`,
 * which survives untouched, so a field that was nullable simply becomes optional-with-a-type.
 */
function geminiSafeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(geminiSafeSchema);
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  const source = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    // Gemini's Schema has `anyOf` and no `oneOf`. Every variant is kept; "exactly one" relaxes
    // to "at least one", which is the same thing for discriminated variants.
    if (key === 'oneOf' && source['anyOf'] === undefined) {
      out['anyOf'] = geminiSafeSchema(value);
      continue;
    }
    if (GEMINI_UNSUPPORTED_KEYWORDS.has(key)) continue;

    if (key === 'type' && Array.isArray(value)) {
      const concrete = value.find((t) => t !== 'null');
      // A type that was ONLY "null" carries no information Gemini can act on; string is the
      // least surprising stand-in, and the field stays optional via `required`.
      out[key] = concrete ?? 'string';
      continue;
    }
    out[key] = geminiSafeSchema(value);
  }
  // A union's discriminator is often `const`, and dropping it made every variant identical --
  // the union collapsed by another route. Gemini's enum is string-only, so a string const
  // becomes a one-value enum; any other const is still dropped, as before.
  if (typeof source['const'] === 'string' && out['enum'] === undefined) {
    out['enum'] = [source['const']];
    out['type'] ??= 'string';
  }
  return out;
}

/**
 * The transcript, preserving tool-call structure when the caller supplied it.
 *
 * `request.messages` wins over `request.prompt` because a reasoning loop's history is
 * structured: an assistant turn carries `tool_calls` and each answering turn carries the
 * matching `tool_call_id`. Every vendor validates that pairing, so a ToolMessage without
 * its AIMessage is a 400 rather than a degraded answer -- which is the failure mode worth
 * having, since the alternative is a model quietly re-answering a question it already
 * has the result for.
 */
function messagesFor(request: ModelRequest): BaseMessage[] {
  const messages: BaseMessage[] = [];
  if (request.systemPrompt) messages.push(new SystemMessage(request.systemPrompt));

  if (!request.messages?.length) {
    messages.push(new HumanMessage(request.prompt));
    return messages;
  }

  for (const m of request.messages) {
    if (m.role === 'user') {
      messages.push(new HumanMessage(m.content));
    } else if (m.role === 'tool') {
      messages.push(
        new ToolMessage({ content: m.content, tool_call_id: m.toolCallId ?? 'unknown' }),
      );
    } else {
      messages.push(
        new AIMessage({
          content: m.content,
          tool_calls: (m.toolCalls ?? []).map((c) => ({
            id: c.id ?? 'unknown',
            name: c.name,
            args: c.args,
          })),
          // Replayed verbatim. `@langchain/google-genai` reads its thought signatures straight
          // out of `additional_kwargs`, so this is the one place the sealed envelope is reopened
          // — by the provider that sealed it.
          ...(m.providerMetadata ? { additional_kwargs: m.providerMetadata } : {}),
        }),
      );
    }
  }
  return messages;
}

/**
 * `usage_metadata` is LangChain's normalised token count across vendors, which is the
 * whole reason it is read here rather than from each vendor's own field name. Zero when a
 * vendor reports nothing: §9's ledger would rather record a known-zero than a guess.
 */
function toModelResponse(message: AIMessage): ModelResponse {
  const usage = message.usage_metadata;
  const toolCalls = (message.tool_calls ?? []).map((c) => ({
    name: c.name,
    args: (c.args ?? {}) as Record<string, unknown>,
    ...(c.id ? { id: c.id } : {}),
  }));

  // Kept whole rather than picked apart: the platform does not know which keys a vendor needs,
  // and guessing would silently drop the next one it adds.
  const providerMetadata = message.additional_kwargs as Record<string, unknown> | undefined;
  // Each LangChain vendor adapter spells it differently: Gemini `finishReason`, OpenAI
  // `finish_reason`, Anthropic `stop_reason`.
  const meta = (message.response_metadata ?? {}) as Record<string, unknown>;
  const finishReason = meta['finishReason'] ?? meta['finish_reason'] ?? meta['stop_reason'];

  return {
    text: textOf(message.content),
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(providerMetadata && Object.keys(providerMetadata).length ? { providerMetadata } : {}),
    ...(typeof finishReason === 'string' ? { finishReason } : {}),
  };
}

function toStreamChunk(chunk: AIMessageChunk): ModelStreamChunk | null {
  // Tool-call fragments first: a chunk can carry both, and the port models them as
  // separate fields rather than one union, so a consumer accumulating arguments does not
  // have to re-inspect a text field to find out whether it should.
  const fragment = chunk.tool_call_chunks?.[0];
  if (fragment) {
    return {
      toolCallDelta: {
        index: fragment.index ?? 0,
        ...(fragment.id ? { id: fragment.id } : {}),
        ...(fragment.name ? { name: fragment.name } : {}),
        ...(fragment.args ? { argsDelta: fragment.args } : {}),
      },
    };
  }

  const text = textOf(chunk.content);
  return text ? { textDelta: text } : null;
}

/**
 * Content is a string for text-only replies and an array of typed parts once a vendor
 * returns anything richer. Only the text parts are joined: a caller asking for `text`
 * must not silently receive a JSON dump of an image block.
 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      typeof part === 'string'
        ? part
        : typeof (part as { text?: unknown })?.text === 'string'
          ? ((part as { text: string }).text)
          : '',
    )
    .join('');
}
