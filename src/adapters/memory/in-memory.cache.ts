import { Injectable } from '@nestjs/common';
import type { MemoryCache } from '../../domain/ports/memory.port.js';

interface Entry {
  value: unknown;
  expiresAt: number;
  scopeKey: string;
}

/**
 * Per-process retrieval cache with scope-keyed invalidation.
 *
 * Redis is the obvious swap and the reason this is behind a port: with several API pods,
 * a write on one does not invalidate the others' caches, so the TTL is deliberately short
 * and this is only ever a latency optimisation.
 *
 * §10 applies here as everywhere: a cached retrieval never reaches the event log, so a
 * hit and a miss produce identical replayable history.
 */
@Injectable()
export class InMemoryCache implements MemoryCache {
  readonly id = 'in-process';
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries = 5_000;

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (this.entries.size >= this.maxEntries) {
      // Oldest insertion first: a Map preserves insertion order, which is a good enough
      // approximation of LRU for a cache whose entries expire in seconds anyway.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      scopeKey: key.split('|')[0] ?? '',
    });
  }

  async invalidate(scopeKey: string): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.scopeKey === scopeKey) this.entries.delete(key);
    }
  }
}
