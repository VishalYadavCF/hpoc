import { Injectable } from '@nestjs/common';
import type { Summarizer } from '../../domain/ports/memory.port.js';

/**
 * Deterministic extractive summariser: keeps the highest-signal sentences up to a budget.
 *
 * Chosen as the default over an LLM one for a reason §0.5 cares about. Forced
 * summarisation that discards detail the model could have used natively is a NET
 * NEGATIVE, and its harm is invisible without measurement. An extractive summary never
 * invents, so the worst case is lost detail rather than fabricated detail -- and lost
 * detail is recoverable from the records it consolidated, which are retained.
 *
 * An LLM-backed adapter is one class and one registry line, and should not ship without
 * an eval showing it beats this.
 */
@Injectable()
export class ExtractiveSummarizer implements Summarizer {
  readonly id = 'extractive';

  async summarize(texts: string[], maxChars: number): Promise<string> {
    const sentences = texts
      .flatMap((t) => t.split(/(?<=[.!?])\s+/))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (sentences.length === 0) return '';

    // Frequency of non-trivial terms, as a crude salience proxy.
    const counts = new Map<string, number>();
    for (const sentence of sentences) {
      for (const word of sentence.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []) {
        counts.set(word, (counts.get(word) ?? 0) + 1);
      }
    }

    const scored = sentences.map((sentence, index) => {
      const words = sentence.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
      const score = words.reduce((sum, w) => sum + (counts.get(w) ?? 0), 0) / (words.length || 1);
      return { sentence, index, score };
    });

    const picked: typeof scored = [];
    let budget = maxChars;
    for (const candidate of [...scored].sort((a, b) => b.score - a.score)) {
      if (candidate.sentence.length > budget) continue;
      picked.push(candidate);
      budget -= candidate.sentence.length + 1;
      if (budget <= 0) break;
    }

    // Restored to original order: a summary that reorders events reads as a different
    // sequence of events, which for episodic memory is a correctness problem.
    return picked.sort((a, b) => a.index - b.index).map((p) => p.sentence).join(' ');
  }
}
