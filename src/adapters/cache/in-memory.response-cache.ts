import { Injectable } from '@nestjs/common';
import type { CachedCompletion, ResponseCache } from '../../domain/ports/response-cache.port.js';

/**
 * Per-process model response cache.
 *
 * Redis is the obvious swap and the reason this is a port: with several workers a hit rate
 * is per-pod, so this is a cost optimisation rather than a guarantee. It is deliberately
 * NOT shared today — a distributed cache in the model path is a new failure mode, and
 * §11.3 says another datastore needs written justification.
 */
@Injectable()
export class InMemoryResponseCache implements ResponseCache {
  readonly id = 'in-process';
  private readonly entries = new Map<string, { value: CachedCompletion; expiresAt: number }>();
  private hits = 0;
  private misses = 0;
  private readonly maxEntries = 2_000;

  async get(key: string): Promise<CachedCompletion | undefined> {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.value;
  }

  async set(key: string, value: CachedCompletion, ttlSeconds: number): Promise<void> {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }
}
