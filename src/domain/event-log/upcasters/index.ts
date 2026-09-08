import { registerUnchanged, registerUpcaster } from '../upcasters.js';
import { EventType } from '../taxonomy.js';

/**
 * Upcasters lift historical events to the current shape at READ time (§0.2).
 *
 * The rule that makes this work: **never rewrite a stored event**. A migration that
 * rewrote history would destroy the thing the log exists to preserve, and a bug in that
 * migration would be undetectable afterwards. Instead the payload is transformed on the
 * way out, so the archive stays exactly what was written.
 *
 * Adding one:
 *   1. Bump CURRENT_EVENT_SCHEMA_VERSION in taxonomy.ts.
 *   2. Register a function here moving a payload from v(n) to v(n+1).
 *   3. Add a fixture of the OLD shape to test/replay-corpus/.
 *
 * The corpus test then proves every archived shape still replays. §0.2 is explicit that a
 * change breaking replay of existing logs IS a breaking change — this is the mechanism
 * that makes that detectable rather than aspirational.
 */
export function registerAllUpcasters(): void {
  // v1 -> v2 changed only the two payloads below. Every other type is declared unchanged
  // EXPLICITLY: a global version bump obligates all of them, and an implicit passthrough
  // would let a forgotten upcaster ship as a silent payload drop.
  for (const type of [
    EventType.RunCreated, EventType.RunStarted, EventType.RunCheckpointed,
    EventType.RunWaiting, EventType.RunResumed, EventType.RunCompleted,
    EventType.RunFailed, EventType.RunCancelled, EventType.RunDeadLettered,
    EventType.StepStarted, EventType.StepCompleted, EventType.StepFailed,
    EventType.ModelRequested, EventType.ModelFallback,
    EventType.ToolCalled, EventType.ToolFailed,
    EventType.InteractionCreated, EventType.InteractionResolved, EventType.InteractionExpired,
    EventType.CacheHit, EventType.CacheMiss,
    EventType.StreamConnected, EventType.StreamResumed,
  ]) {
    registerUnchanged(type, 1);
  }

  // v1 -> v2: `tool.completed` carried the output at the top level; it now nests under
  // `output` alongside `cached`, so a reader can tell a cache hit from a fresh call.
  registerUpcaster(EventType.ToolCompleted, 1, (payload) => ({
    toolRef: payload['toolRef'],
    output: 'output' in payload ? payload['output'] : payload['result'],
    // Absent in v1, and absent means "we do not know", not "false". Guessing false would
    // silently claim every historical tool call was uncached.
    cached: 'cached' in payload ? payload['cached'] : null,
  }));

  // v1 -> v2: `model.completed` reported `tokens`; split into input and output, because a
  // single total cannot be priced (§9 charges them at different rates).
  registerUpcaster(EventType.ModelCompleted, 1, (payload) => {
    if ('inputTokens' in payload) return payload;
    const total = Number(payload['tokens'] ?? 0);
    return {
      text: payload['text'],
      // The split is unknowable from a total, so it is recorded as unknown rather than
      // apportioned by a guess that would then look like measured data.
      inputTokens: null,
      outputTokens: null,
      totalTokensLegacy: total,
    };
  });
}
