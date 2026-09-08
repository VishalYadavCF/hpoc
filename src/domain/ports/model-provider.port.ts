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

export interface ModelRequest {
  providerModelId: string;
  prompt: string;
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
