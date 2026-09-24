export const MODEL_PROVIDER_REGISTRY = Symbol('ModelProviderRegistry');

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

/**
 * Opaque, provider-owned state that must survive a round trip.
 *
 * The platform NEVER interprets this — it is a sealed envelope handed back to the same provider
 * on the next turn. Gemini's reasoning models are why it exists: each `functionCall` comes with a
 * `thoughtSignature`, and replaying the transcript without it is rejected outright
 * ("Function call is missing a thought_signature… required for tools to work correctly"). On the
 * older models it is not even an error, just silently degraded answers — which presented as the
 * agent going quiet and calling no tools at all.
 *
 * Deliberately untyped and provider-neutral rather than a `thoughtSignature` field: the next
 * vendor's opaque state will not be Gemini's, and the port should not learn one vendor's vocabulary.
 */
export type ProviderMetadata = Record<string, unknown>;

/** One turn of a transcript, in the shape every vendor's chat API agrees on. */
export interface ModelMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on an assistant turn that asked for tools. */
  toolCalls?: ToolCall[];
  /** Present on a tool turn, matching the assistant turn's call id. */
  toolCallId?: string;
  /** Opaque provider state captured when this turn was produced. Replayed verbatim. */
  providerMetadata?: ProviderMetadata;
}

export interface ModelRequest {
  providerModelId: string;
  /**
   * The single-turn form. Kept because most callers have exactly one question to ask and
   * building a one-element array for them is noise.
   */
  prompt: string;
  /**
   * The multi-turn form, which WINS over `prompt` when present.
   *
   * A reasoning loop's transcript is not a string: it is an alternation of assistant
   * turns that requested tools and tool turns that answered them, tied together by call
   * ids. Flattening that into prose loses the ids, and the model then has to re-infer
   * which result belonged to which request -- which is exactly where a correct second
   * tool call turns into a wrong one.
   */
  messages?: ModelMessage[];
  systemPrompt?: string | null;
  maxOutputTokens?: number | null;
  /**
   * Tool schemas for NATIVE tool calling.
   *
   * The alternative -- instructing a model to emit `TOOL name {...}` as text and parsing
   * it back -- fails in ways that look like the agent choosing not to act: the model
   * copies the placeholder verbatim, or hallucinates the tool's result inline and never
   * calls it, or emits prose the parser must refuse rather than guess at. Every provider
   * here has a real tool-calling API; using it removes a whole class of silent failure.
   */
  tools?: ToolSchema[];
}

export interface ModelResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Populated when the model asked for a tool rather than answering. */
  toolCalls?: ToolCall[];
  /** Opaque provider state to replay on the next turn. See `ProviderMetadata`. */
  providerMetadata?: ProviderMetadata;
}

/**
 * One incremental piece of a streaming completion.
 *
 * Deltas rather than snapshots: a provider sends "what is new", and the consumer
 * accumulates. Snapshots would make the wire cost quadratic in output length, which is
 * exactly the case a voice turn is trying to keep short.
 */
export interface ModelStreamChunk {
  textDelta?: string;
  /** Native tool calls arrive fragmented too; `index` identifies which call is growing. */
  toolCallDelta?: { index: number; id?: string; name?: string; argsDelta?: string };
}

export interface ModelProvider {
  readonly id: string;
  complete(
    request: ModelRequest,
    credentials: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<ModelResponse>;

  /**
   * Incremental generation, where the provider supports it.
   *
   * OPTIONAL by design. A provider without it is driven through `complete()` by the
   * gateway's shim and yields its whole answer as one chunk, so adding streaming to the
   * platform did not require touching every adapter at once — and a provider that never
   * gains a native streaming API is not second-class.
   *
   * `signal` is what makes a turn interruptible: §12.3's barge-in has to stop generation,
   * not merely stop listening to it, or the tokens are billed and the model keeps running.
   */
  stream?(
    request: ModelRequest,
    credentials: Record<string, string>,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamChunk>;
}
