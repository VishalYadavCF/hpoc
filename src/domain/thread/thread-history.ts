import type { Db } from '../../platform/persistence/database.js';
import type { RecalledMemory } from '../ports/framework-adapter.port.js';

/**
 * Thread continuity (§3): what earlier turns of a thread a new run is handed.
 *
 * A turn is a new run -- execution state resets, continuity does not. Without this, a
 * second run on a thread saw only its own input and the conversation silently restarted.
 * Independent of `memory.enabled` (recall is a similarity search, not the transcript), and
 * opt-in per agent via `spec.thread.history = 'transcript'`.
 */

/** Defaults, mirrored by `spec.thread` (opt-in: `history: 'transcript'`), which overrides them. */
export const THREAD_HISTORY_MAX_MESSAGES = 20;
/** Total character budget across all prior turns handed to the framework. */
export const THREAD_HISTORY_MAX_CHARS = 8_000;
/** One turn longer than this is truncated rather than pushing every other turn out. */
export const THREAD_HISTORY_MAX_MESSAGE_CHARS = 8_000;

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface HistoryLimits {
  maxMessages: number;
  maxChars: number;
  maxMessageChars: number;
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
  maxMessages: THREAD_HISTORY_MAX_MESSAGES,
  maxChars: THREAD_HISTORY_MAX_CHARS,
  maxMessageChars: THREAD_HISTORY_MAX_MESSAGE_CHARS,
};

export interface ThreadRunRow {
  id: string;
  status: string;
  input: unknown;
  output: unknown;
  created_at: Date;
  ended_at: Date | null;
}

export interface ProjectedMessage {
  role: 'user' | 'assistant';
  content: unknown;
  runId: string;
  at: Date;
}

/**
 * §6.3 transcript fidelity: what the user actually RECEIVED -- run inputs and the terminal
 * output of completed runs, never intermediate generations. Shared by
 * `GET /v1/threads/:id/messages` and the history a run is handed, so the two cannot drift.
 */
export function projectThreadMessages(runs: ThreadRunRow[]): ProjectedMessage[] {
  const out: ProjectedMessage[] = [];
  for (const run of runs) {
    if (run.input !== null) {
      out.push({ role: 'user', content: run.input, runId: run.id, at: run.created_at });
    }
    if (run.status === 'completed' && run.output !== null) {
      out.push({
        role: 'assistant',
        content: (run.output as { text?: unknown }).text ?? run.output,
        runId: run.id,
        at: run.ended_at ?? run.created_at,
      });
    }
  }
  return out;
}

export function renderContent(content: unknown): string {
  if (content === null || content === undefined) return '';
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/**
 * Newest-first within both a message count and a character budget, then back in order.
 * Never starts on an assistant turn: a reply with its question cut off reads as the model
 * talking to itself.
 */
export function boundHistory(
  messages: { role: 'user' | 'assistant'; content: unknown }[],
  limits: HistoryLimits = DEFAULT_HISTORY_LIMITS,
): HistoryTurn[] {
  if (limits.maxMessages <= 0 || limits.maxChars <= 0) return [];
  const kept: HistoryTurn[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0 && kept.length < limits.maxMessages; i--) {
    const m = messages[i]!;
    let content = renderContent(m.content);
    if (!content) continue;
    if (content.length > limits.maxMessageChars) {
      content = `${content.slice(0, limits.maxMessageChars)}\n…[truncated ${content.length - limits.maxMessageChars} chars]`;
    }
    if (used + content.length > limits.maxChars) break;
    used += content.length;
    kept.push({ role: m.role, content });
  }
  kept.reverse();
  while (kept.length > 0 && kept[0]!.role === 'assistant') kept.shift();
  return kept;
}

/**
 * Loads the delivered turns that precede `run` on its thread.
 *
 * Only top-level runs: a delegated child shares its parent's thread id but is not a turn
 * of the conversation, and it gets its own input from the delegation -- so a child run
 * receives no history, and children never appear as turns in anyone else's.
 */
export async function loadThreadHistory(
  db: Db,
  run: { id: string; thread_id: string; parent_run_id: string | null },
  limits: HistoryLimits = DEFAULT_HISTORY_LIMITS,
): Promise<HistoryTurn[]> {
  if (run.parent_run_id !== null || limits.maxMessages <= 0) return [];

  // Each run contributes at most two messages, so maxMessages runs always suffice.
  const rows = (await db
    .selectFrom('runs')
    .select(['id', 'status', 'input', 'output', 'created_at', 'ended_at'])
    .where('thread_id', '=', run.thread_id)
    .where('id', '!=', run.id)
    .where('parent_run_id', 'is', null)
    .where('created_at', '<', (eb) => eb.selectFrom('runs').select('created_at').where('id', '=', run.id))
    .orderBy('created_at', 'desc')
    .limit(limits.maxMessages)
    .execute()) as ThreadRunRow[];

  return boundHistory(projectThreadMessages(rows.reverse()), limits);
}

/**
 * The history a run is handed, per its version's `spec.thread` setting.
 *
 * Only `transcript` injects. `none` (the default, and what an absent setting means) and
 * `memory` return nothing, so an agent that did not opt in runs exactly as it did before.
 */
export async function threadHistoryFor(
  db: Db,
  run: { id: string; thread_id: string; parent_run_id: string | null },
  thread: { history: 'none' | 'transcript' | 'memory'; maxMessages: number; maxChars: number } | undefined,
): Promise<HistoryTurn[]> {
  if (thread?.history !== 'transcript') return [];
  return loadThreadHistory(db, run, {
    maxMessages: thread.maxMessages,
    maxChars: thread.maxChars,
    maxMessageChars: Math.min(THREAD_HISTORY_MAX_MESSAGE_CHARS, thread.maxChars),
  });
}

/**
 * Drops conversational-memory hits that are the same turns the transcript already carries.
 *
 * `remember()` writes a completed run's input and output verbatim to the `conversational`
 * tier, so with memory enabled recall would hand the framework the same turn twice -- once
 * in the transcript and once as a "memory". Exact-content match against the turns actually
 * handed over; a recalled turn older than the window (or truncated in it) is kept, since
 * the transcript does not carry it whole.
 */
export function dedupeRecalled<T extends Pick<RecalledMemory, 'tier' | 'content'>>(
  recalled: T[],
  historyTurns: HistoryTurn[],
): T[] {
  if (historyTurns.length === 0) return recalled;
  const shown = new Set(historyTurns.map((t) => t.content.trim()));
  return recalled.filter((r) => {
    if (r.tier !== 'conversational' || r.content === null) return true;
    return !shown.has(r.content.trim());
  });
}
