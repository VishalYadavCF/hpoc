import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, isTerminal } from '../src/domain/run-engine/state-machine.js';
import { InvalidTransition } from '../src/domain/errors/platform.errors.js';

describe('run state machine (§4.1)', () => {
  it('allows the happy path', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
  });

  it('treats waiting as the single suspension state', () => {
    // §4.1: one mechanism, four callers -- human interaction, peer delegation,
    // MCP server-initiated requests, external waits.
    for (const from of ['running', 'tool_execution', 'checkpointed'] as const) {
      expect(canTransition(from, 'waiting')).toBe(true);
    }
    expect(canTransition('waiting', 'running')).toBe(true);
  });

  it('refuses to resurrect a completed run', () => {
    expect(canTransition('completed', 'running')).toBe(false);
    expect(() => assertTransition('completed', 'running')).toThrow(InvalidTransition);
  });

  it('lets a failed run be replayed but not a cancelled one', () => {
    expect(canTransition('failed', 'queued')).toBe(true);
    expect(canTransition('cancelled', 'queued')).toBe(false);
  });

  it('marks completed and cancelled terminal', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('waiting')).toBe(false);
  });
});
