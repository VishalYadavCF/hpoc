import { Injectable } from '@nestjs/common';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from '../../domain/ports/model-provider.port.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';

/** Gemini rejects dots in function names; tool refs are dotted (`demo.echo`). */
const sanitiseName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * Google Gemini generateContent.
 *
 * Third distinct wire shape: `contents` with `parts`, the system prompt as
 * `systemInstruction`, the key on the URL rather than a header, and usage under
 * `usageMetadata`.
 */
@Injectable()
export class GoogleProvider implements ModelProvider {
  readonly id = 'google';

  async complete(
    request: ModelRequest,
    credentials: Record<string, string>,
  ): Promise<ModelResponse> {
    const apiKey = credentials['apiKey'];
    if (!apiKey) {
      throw new PlatformError('upstream_failure', 'No apiKey resolved for the Google provider');
    }
    const baseUrl = credentials['baseUrl'] ?? 'https://generativelanguage.googleapis.com/v1beta';

    const response = await fetch(
      `${baseUrl}/models/${request.providerModelId}:generateContent`,
      {
        method: 'POST',
        // Header rather than ?key= so the secret never reaches an access log or a proxy's
        // URL capture.
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
          ...(request.systemPrompt
            ? { systemInstruction: { parts: [{ text: request.systemPrompt }] } }
            : {}),
          ...(request.maxOutputTokens
            ? { generationConfig: { maxOutputTokens: request.maxOutputTokens } }
            : {}),
          ...(request.tools?.length
            ? {
                tools: [
                  {
                    functionDeclarations: request.tools.map((t) => ({
                      name: sanitiseName(t.name),
                      description: t.description,
                      parameters: t.parameters,
                    })),
                  },
                ],
              }
            : {}),
        }),
      },
    );

    if (!response.ok) {
      throw new PlatformError('upstream_failure', `Google returned ${response.status}`, {
        status: response.status,
        body: (await response.text()).slice(0, 500),
      });
    }

    const body = (await response.json()) as {
      candidates?: {
        content?: {
          parts?: { text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }[];
        };
      }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const parts = body.candidates?.[0]?.content?.parts ?? [];
    // Gemini flattens tool names, so map back to the original ref the platform knows.
    const original = new Map((request.tools ?? []).map((t) => [sanitiseName(t.name), t.name]));
    const toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p) => ({
        name: original.get(p.functionCall!.name) ?? p.functionCall!.name,
        args: p.functionCall!.args ?? {},
      }));

    return {
      text: parts.map((p) => p.text ?? '').join(''),
      inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}
