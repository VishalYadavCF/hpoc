import { describe, expect, it } from 'vitest';
import { stableHash } from '../src/platform/ids.js';

describe('spec hashing (§18.1, §10)', () => {
  it('is insensitive to key order', () => {
    // Key order must not change the hash, or every re-serialisation mints a new
    // AgentVersion and churns the prompt cache -- which is exactly the §18.5 alarm
    // firing on a non-problem.
    expect(stableHash({ a: 1, b: { c: 2, d: 3 } })).toBe(stableHash({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('separates specs that genuinely differ', () => {
    expect(stableHash({ model: 'a' })).not.toBe(stableHash({ model: 'b' }));
  });

  it('ignores undefined but not null', () => {
    expect(stableHash({ a: 1, b: undefined })).toBe(stableHash({ a: 1 }));
    expect(stableHash({ a: 1, b: null })).not.toBe(stableHash({ a: 1 }));
  });
});
