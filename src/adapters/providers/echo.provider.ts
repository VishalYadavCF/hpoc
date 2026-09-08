import { Injectable } from '@nestjs/common';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
} from '../../domain/ports/model-provider.port.js';

/**
 * A provider that answers without a network call or an API key.
 *
 * It exists so the run loop, the gateway's accounting path and the event log can be
 * exercised end to end in CI and on a laptop. Token counts are a word-count
 * approximation and are labelled as such -- a fabricated exact number would corrupt
 * usage_ledger, which is billing data.
 */
@Injectable()
export class EchoProvider implements ModelProvider {
  readonly id = 'echo';

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const text = `echo(${request.providerModelId}): ${request.prompt}`;
    return {
      text,
      inputTokens: approximateTokens(`${request.systemPrompt ?? ''} ${request.prompt}`),
      outputTokens: approximateTokens(text),
    };
  }

  /**
   * Word-by-word, so a consumer that chunks on clause boundaries has something real to
   * chunk. A single-chunk fake would let a broken chunker pass its tests.
   *
   * Honours `signal` between words rather than ignoring it: the interruption path (§12.3)
   * needs a provider that actually stops, or every abort test passes for the wrong reason.
   */
  async *stream(request: ModelRequest, _credentials: Record<string, string>, signal?: AbortSignal): AsyncIterable<ModelStreamChunk> {
    const text = `echo(${request.providerModelId}): ${request.prompt}`;
    const words = text.split(/(\s+)/).filter((w) => w.length > 0);
    for (const word of words) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      yield { textDelta: word };
    }
  }
}

const approximateTokens = (s: string): number =>
  s.trim().length === 0 ? 0 : Math.ceil(s.trim().split(/\s+/).length * 1.3);
