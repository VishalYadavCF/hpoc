import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Embedder } from '../../domain/ports/memory.port.js';
import { EMBEDDING_DIMENSIONS } from '../../domain/ports/memory.port.js';

/**
 * A hashing embedder that needs no API key and no network.
 *
 * Honest about what it is: this is lexical, not semantic. It hashes token trigrams into
 * buckets, so "invoice" and "bill" are as unrelated as "invoice" and "banana". It exists
 * so the retrieval pipeline -- indexing, filtering, ranking, decay -- can be exercised
 * deterministically in CI and on a laptop, not to produce good recall.
 *
 * Swapping in a real embedder is one registry line plus a re-embed. Anything relying on
 * semantic similarity must not ship on this.
 */
@Injectable()
export class DeterministicEmbedder implements Embedder {
  readonly id = 'deterministic-hash';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.one(text));
  }

  private one(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

    for (const token of tokens) {
      // The token itself plus its character trigrams, so near-misses and inflections
      // ("invoice" / "invoices") land in overlapping buckets rather than nowhere near.
      this.add(vector, token, 1);
      for (let i = 0; i + 3 <= token.length; i++) {
        this.add(vector, token.slice(i, i + 3), 0.4);
      }
    }

    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    // A zero vector has no direction; cosine against it is undefined, so an empty string
    // gets a fixed unit vector rather than NaN scores.
    if (norm === 0) {
      vector[0] = 1;
      return vector;
    }
    return vector.map((v) => v / norm);
  }

  private add(vector: number[], key: string, weight: number): void {
    const digest = createHash('sha256').update(key).digest();
    const bucket = digest.readUInt32BE(0) % this.dimensions;
    // Sign from an independent byte so unrelated keys cancel rather than always adding.
    const sign = (digest[4]! & 1) === 0 ? 1 : -1;
    vector[bucket] += weight * sign;
  }
}
