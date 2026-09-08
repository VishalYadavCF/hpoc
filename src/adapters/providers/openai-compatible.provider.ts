import { Injectable } from '@nestjs/common';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
} from '../../domain/ports/model-provider.port.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';

/**
 * Chat-completions over any OpenAI-compatible endpoint (OpenAI, LiteLLM, OpenRouter,
 * vLLM). One adapter covers the whole family because the wire shape is the same; a
 * vendor with a different shape gets its own class and one registry line.
 *
 * Credentials arrive from the credential broker per call. Nothing is written to
 * process.env -- under concurrent runs that lets one tenant's key leak into another
 * tenant's request, whichever run wrote last winning for both.
 */
@Injectable()
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id = 'openai-compatible';

  async complete(
    request: ModelRequest,
    credentials: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const apiKey = credentials['apiKey'];
    const baseUrl = credentials['baseUrl'] ?? 'https://api.openai.com/v1';
    if (!apiKey) {
      throw new PlatformError('upstream_failure', 'No apiKey supplied by the credential broker');
    }

    const messages = [
      ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
      { role: 'user', content: request.prompt },
    ];

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      ...(signal ? { signal } : {}),
      body: JSON.stringify({
        model: request.providerModelId,
        messages,
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
      }),
    });

    if (!response.ok) {
      // Propagate honestly rather than fabricating an empty completion: the gateway
      // decides whether this is a fallback case, and it cannot decide on a lie.
      throw new PlatformError(
        'upstream_failure',
        `Provider returned ${response.status}`,
        { status: response.status, body: (await response.text()).slice(0, 500) },
      );
    }

    const body = (await response.json()) as {
      choices?: {
        message?: {
          content?: string;
          tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const message = body.choices?.[0]?.message;
    const toolCalls = (message?.tool_calls ?? [])
      .map((c) => {
        try {
          // Arguments arrive as a JSON STRING here, unlike Gemini's object. A malformed
          // one is dropped rather than guessed at -- inventing arguments invokes a side
          // effect nobody asked for.
          return {
            name: c.function?.name ?? '',
            args: JSON.parse(c.function?.arguments ?? '{}') as Record<string, unknown>,
            id: c.id,
          };
        } catch {
          return null;
        }
      })
      .filter((c): c is { name: string; args: Record<string, unknown>; id: string | undefined } =>
        c !== null && c.name !== '',
      );

    return {
      text: message?.content ?? '',
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  /**
   * `stream: true` over the same endpoint, decoding SSE `data:` frames.
   *
   * Proof that the port fits a real wire protocol rather than only the deterministic fake.
   * Two details that bite: frames can split mid-line across TCP reads, so the buffer is
   * carried between reads rather than parsed per chunk; and `[DONE]` is a sentinel, not
   * JSON, so parsing it would throw at the end of every successful stream.
   */
  async *stream(
    request: ModelRequest,
    credentials: Record<string, string>,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamChunk> {
    const apiKey = credentials['apiKey'];
    const baseUrl = credentials['baseUrl'] ?? 'https://api.openai.com/v1';
    if (!apiKey) {
      throw new PlatformError('upstream_failure', 'No apiKey supplied by the credential broker');
    }

    const messages = [
      ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
      { role: 'user', content: request.prompt },
    ];

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      ...(signal ? { signal } : {}),
      body: JSON.stringify({
        model: request.providerModelId,
        messages,
        stream: true,
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      }),
    });

    if (!response.ok || !response.body) {
      throw new PlatformError('upstream_failure', `Provider returned ${response.status}`, {
        status: response.status,
      });
    }

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split('\n');
      // The last element is whatever arrived after the final newline -- possibly half a
      // frame -- so it stays in the buffer for the next read.
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const frame = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const delta = frame.choices?.[0]?.delta?.content;
          if (delta) yield { textDelta: delta };
        } catch {
          // A frame we cannot parse is skipped rather than fatal: one malformed keepalive
          // must not discard a generation that is otherwise arriving fine.
        }
      }
    }
  }
}
