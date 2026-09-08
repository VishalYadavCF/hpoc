import { Injectable } from '@nestjs/common';
import type { Embedder } from '../../domain/ports/memory.port.js';
import { EMBEDDING_DIMENSIONS } from '../../domain/ports/memory.port.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';

/**
 * Gemini embeddings, truncated to the column width.
 *
 * `gemini-embedding-001` is natively 3072-dimensional and supports Matryoshka
 * truncation via `outputDimensionality`. Truncating a Matryoshka embedding requires
 * RE-NORMALISING it -- the shortened vector is no longer unit length, and cosine
 * similarity over unnormalised vectors ranks by magnitude as much as by direction. The
 * pgvector index would still return results; they would just be quietly worse.
 *
 * Reads its key from the environment rather than the credential broker: embedding happens
 * during consolidation on the scheduler, outside any run, and the broker's audit record
 * is keyed by run. Wiring a non-run mint is the right fix and is noted in STATUS.md.
 */
@Injectable()
export class GeminiEmbedder implements Embedder {
  private readonly model = process.env['EMBEDDING_MODEL'] ?? 'gemini-embedding-001';
  readonly id = `gemini:${process.env['EMBEDDING_MODEL'] ?? 'gemini-embedding-001'}@${EMBEDDING_DIMENSIONS}`;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  static isConfigured(): boolean {
    return Boolean(process.env['MODEL_CREDENTIAL_EMBEDDING'] ?? process.env['TEST_LLM_KEY']);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const key = process.env['MODEL_CREDENTIAL_EMBEDDING'] ?? process.env['TEST_LLM_KEY'];
    if (!key) throw new PlatformError('capability_denied', 'No embedding credential configured');

    const base =
      process.env['EMBEDDING_BASE_URL'] ?? 'https://generativelanguage.googleapis.com/v1beta';

    // One request per text: batchEmbedContents exists but partial failures in a batch are
    // reported per-item, and a half-embedded batch is worse than a slower loop.
    const out: number[][] = [];
    for (const text of texts) {
      const response = await fetch(`${base}/models/${this.model}:embedContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
          outputDimensionality: this.dimensions,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new PlatformError('upstream_failure', `Embedding returned ${response.status}`, {
          body: (await response.text()).slice(0, 300),
        });
      }
      const body = (await response.json()) as { embedding?: { values?: number[] } };
      const values = body.embedding?.values;
      if (!values || values.length !== this.dimensions) {
        // A dimension mismatch is not recoverable at run time: vectors of two widths
        // cannot share an index, and padding one would be a fabricated direction.
        throw new PlatformError('upstream_failure', 'Embedding had unexpected dimensions', {
          got: values?.length ?? 0,
          expected: this.dimensions,
          model: this.model,
        });
      }
      out.push(normalise(values));
    }
    return out;
  }
}

/** Unit-length, so cosine distance measures direction rather than magnitude. */
function normalise(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? values : values.map((v) => v / norm);
}
