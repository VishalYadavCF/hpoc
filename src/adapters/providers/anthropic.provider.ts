import { Injectable } from '@nestjs/common';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from '../../domain/ports/model-provider.port.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';

/**
 * Anthropic Messages API.
 *
 * A separate class rather than a branch inside the OpenAI-compatible one, because the
 * wire shape genuinely differs: the system prompt is a top-level `system` field rather
 * than a message with role "system", `max_tokens` is REQUIRED, content is an array of
 * typed blocks, and usage is reported as input_tokens/output_tokens.
 */
@Injectable()
export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';

  async complete(
    request: ModelRequest,
    credentials: Record<string, string>,
  ): Promise<ModelResponse> {
    const apiKey = credentials['apiKey'];
    if (!apiKey) {
      throw new PlatformError('upstream_failure', 'No apiKey resolved for the Anthropic provider');
    }
    const baseUrl = credentials['baseUrl'] ?? 'https://api.anthropic.com/v1';

    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': credentials['apiVersion'] ?? '2023-06-01',
      },
      body: JSON.stringify({
        model: request.providerModelId,
        // Required by this API, unlike the OpenAI family where it is optional. Omitting
        // it is a 400, so the default is a real value rather than a conditional spread.
        max_tokens: request.maxOutputTokens ?? 4096,
        ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
        messages: [{ role: 'user', content: request.prompt }],
      }),
    });

    if (!response.ok) {
      throw new PlatformError('upstream_failure', `Anthropic returned ${response.status}`, {
        status: response.status,
        body: (await response.text()).slice(0, 500),
      });
    }

    const body = (await response.json()) as {
      content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const toolCalls = (body.content ?? [])
      .filter((b) => b.type === 'tool_use' && b.name)
      .map((b) => ({ name: b.name!, args: b.input ?? {}, id: b.id }));

    return {
      // Content is a block array; concatenate the text blocks and ignore the rest rather
      // than assuming index 0 is text -- tool_use blocks share the array.
      text: (body.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join(''),
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}
