import { Injectable, Logger } from '@nestjs/common';
import { MemoryEngine } from '../memory/memory.engine.js';
import type { RecalledMemory } from '../ports/framework-adapter.port.js';

export interface ContextBudget {
  /** Characters, not tokens: the engine must not assume a tokenizer it does not own. */
  maxChars: number;
  reserveForAnswer: number;
}

export interface AssembledContext {
  recalled: RecalledMemory[];
  droppedCount: number;
  usedChars: number;
  compacted: boolean;
}

/**
 * §7. The runtime maintains a logical context larger than the model's physical window.
 *
 * Three mechanisms, and §0.5 governs all of them: each is disableable per agent, and one
 * that cannot be shown to help should be removed rather than tolerated. Forced
 * summarisation that discards detail the model could have used natively is a NET
 * NEGATIVE, and its harm is invisible without measurement — so this engine reports what
 * it dropped rather than silently shrinking the input.
 *
 * Budgets are in characters. Tokenization is provider-specific and the platform does not
 * own a tokenizer; pretending to count tokens would be precise and wrong.
 */
@Injectable()
export class ContextEngine {
  private readonly log = new Logger(ContextEngine.name);

  constructor(private readonly memory: MemoryEngine) {}

  /**
   * Fits recalled context into a budget by eviction, then compaction.
   *
   * Eviction first, deliberately: dropping the least relevant item loses one thing
   * completely, while compacting everything degrades all of it. Losing the worst item is
   * usually better than blurring the best.
   */
  async assemble(
    recalled: RecalledMemory[],
    budget: ContextBudget,
    options: { compaction: boolean; eviction: boolean } = { compaction: true, eviction: true },
  ): Promise<AssembledContext> {
    const available = Math.max(budget.maxChars - budget.reserveForAnswer, 0);
    const size = (r: RecalledMemory): number => (r.content ?? '').length;

    let kept = [...recalled];
    let used = kept.reduce((total, r) => total + size(r), 0);
    if (used <= available) {
      return { recalled: kept, droppedCount: 0, usedChars: used, compacted: false };
    }

    let dropped = 0;
    if (options.eviction) {
      // Priority: score first, then trust. An unverified peer claim is evicted before a
      // first-party fact of equal relevance (§6.4).
      kept.sort((a, b) => b.score - a.score || Number(b.trusted) - Number(a.trusted));
      while (kept.length > 0 && used > available) {
        const evicted = kept.pop()!;
        used -= size(evicted);
        dropped += 1;
      }
    }

    let compacted = false;
    if (options.compaction && used > available && kept.length > 0) {
      // Last resort. Truncation is honest about being lossy in a way a summary is not:
      // a summary reads complete, so a reader cannot tell what is missing.
      const perItem = Math.floor(available / kept.length);
      kept = kept.map((r) => ({
        ...r,
        content: r.content && r.content.length > perItem
          ? `${r.content.slice(0, Math.max(perItem - 20, 0))}… [truncated]`
          : r.content,
      }));
      used = kept.reduce((total, r) => total + size(r), 0);
      compacted = true;
    }

    if (dropped > 0 || compacted) {
      this.log.debug(`context: dropped ${dropped}, compacted=${compacted}, chars=${used}`);
    }
    return { recalled: kept, droppedCount: dropped, usedChars: used, compacted };
  }
}
