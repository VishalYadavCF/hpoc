import type { RunStatus } from '../../platform/persistence/schema.types.js';
import { InvalidTransition } from '../errors/platform.errors.js';

/**
 * §4.1's state machine, as data.
 *
 * `waiting` is the single suspension state covering human interaction, peer delegation,
 * MCP server-initiated requests and external waits -- one mechanism, four callers.
 */
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['tool_execution', 'checkpointed', 'waiting', 'completed', 'failed', 'cancelled', 'queued'],
  tool_execution: ['running', 'waiting', 'failed', 'cancelled'],
  checkpointed: ['running', 'waiting', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: ['dead_letter', 'queued'],
  cancelled: [],
  dead_letter: ['queued'],
};

export const TERMINAL: readonly RunStatus[] = ['completed', 'cancelled'];

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransition(from, to);
}

export function isTerminal(status: RunStatus): boolean {
  return TRANSITIONS[status].length === 0 || status === 'completed' || status === 'cancelled';
}
