import { randomUUID, createHash } from 'node:crypto';

export const newId = (): string => randomUUID();

/** Stable hash of a spec, so an identical inline spec resolves to one AgentVersion (§18.1). */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Key order must not change the hash, or every re-serialisation churns the cache (§10). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
