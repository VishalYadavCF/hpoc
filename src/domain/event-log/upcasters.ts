import { CURRENT_EVENT_SCHEMA_VERSION } from './taxonomy.js';

export type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>;

/**
 * Lifts a historical event to the current shape at READ time (§0.2).
 *
 * Keyed by `${eventType}@${fromVersion}`; each entry moves a payload exactly one version
 * forward, and `upcast` chains them. Writing a migration that rewrites stored events
 * instead would destroy the thing the log exists to preserve.
 */
const upcasters = new Map<string, Upcaster>();

export function registerUpcaster(eventType: string, fromVersion: number, fn: Upcaster): void {
  upcasters.set(`${eventType}@${fromVersion}`, fn);
}

/**
 * Declares that an event type's payload did NOT change across a version bump.
 *
 * The version is global, so bumping it obligates every event type — not only the ones
 * that changed. Making "unchanged" an explicit declaration rather than an implicit
 * fallback keeps the loud failure for a type nobody considered, which is the whole value
 * of the corpus gate: silence would mean an author who forgot an upcaster ships a change
 * that quietly drops payloads on read.
 */
export function registerUnchanged(eventType: string, fromVersion: number): void {
  upcasters.set(`${eventType}@${fromVersion}`, (payload) => payload);
}

export function upcast(
  eventType: string,
  version: number,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  let current = payload;
  for (let v = version; v < CURRENT_EVENT_SCHEMA_VERSION; v++) {
    const fn = upcasters.get(`${eventType}@${v}`);
    if (!fn) {
      throw new Error(
        `No upcaster for ${eventType} v${v} -> v${v + 1}. Replay of archived logs is ` +
          `broken, which §0.2 defines as a breaking change.`,
      );
    }
    current = fn(current);
  }
  return current;
}

export function hasUpcastPath(eventType: string, version: number): boolean {
  for (let v = version; v < CURRENT_EVENT_SCHEMA_VERSION; v++) {
    if (!upcasters.has(`${eventType}@${v}`)) return false;
  }
  return true;
}
