export const RESPONSE_CACHE = Symbol('ResponseCache');

export interface CachedCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * §10. Platform-managed caching, driven by declared contracts rather than heuristics.
 *
 * Two rules this port exists to keep enforceable:
 *
 *  - **Caches are never part of the event log.** A hit and a miss must produce identical
 *    replayable history, so a hit still writes its step and its event carrying the output.
 *    Replay reads the recorded event, never this.
 *  - **Cacheability is declared, never inferred.** Nothing reaches here unless an agent
 *    said determinism is acceptable for that model call.
 */
export interface ResponseCache {
  readonly id: string;
  get(key: string): Promise<CachedCompletion | undefined>;
  set(key: string, value: CachedCompletion, ttlSeconds: number): Promise<void>;
  stats(): { hits: number; misses: number; size: number };
}
