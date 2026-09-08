export interface Chunk {
  ord: number;
  content: string;
}

export interface ChunkOptions {
  maxChars: number;
  overlapChars: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = { maxChars: 1_200, overlapChars: 150 };

/**
 * Splits a document into overlapping chunks on paragraph boundaries.
 *
 * Deterministic, and that is the point rather than an incidental property: the same bytes
 * must produce the same chunks, or `content_hash` stops meaning "already ingested" and a
 * nightly re-push silently rebuilds the corpus with different boundaries every night.
 *
 * Paragraphs first, then sentences, then a hard cut. Splitting mid-sentence is a real
 * quality loss -- the passage that answers the question ends up half in one embedding and
 * half in another, and neither ranks -- so it is the last resort, not the strategy.
 *
 * Overlap exists for the same failure: a fact stated across a paragraph break belongs to
 * both sides of it. The cost is duplicated text in the index, which is cheap; the cost of
 * omitting it is a retrieval miss, which is invisible.
 */
export function chunk(text: string, options: ChunkOptions = DEFAULT_CHUNKING): Chunk[] {
  const { maxChars, overlapChars } = options;
  const body = text.trim();
  if (body.length === 0) return [];
  if (body.length <= maxChars) return [{ ord: 0, content: body }];

  const units = splitToUnits(body, maxChars);

  const chunks: Chunk[] = [];
  let current = '';
  for (const unit of units) {
    if (current.length > 0 && current.length + unit.length + 2 > maxChars) {
      chunks.push({ ord: chunks.length, content: current });
      // Carry the tail forward. Taken from the emitted chunk rather than from the source
      // so the overlap is always text a reader of the previous chunk actually saw.
      current = overlapChars > 0 ? tail(current, overlapChars) : '';
      // ...unless the next unit already fills the budget on its own. Overlap is a
      // retrieval nicety; the budget is a hard constraint, because a chunk larger than
      // the caller asked for is one the caller's context window may not hold. Units are
      // capped at maxChars by splitToUnits, so dropping the overlap always fits.
      if (current.length + unit.length + 2 > maxChars) current = '';
    }
    current = current.length > 0 ? `${current}\n\n${unit}` : unit;
  }
  if (current.trim().length > 0) chunks.push({ ord: chunks.length, content: current });
  return chunks;
}

/** Paragraphs, then oversized paragraphs by sentence, then oversized sentences by cut. */
function splitToUnits(body: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const paragraph of body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (paragraph.length <= maxChars) {
      out.push(paragraph);
      continue;
    }
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)) {
      if (sentence.length <= maxChars) {
        out.push(sentence);
        continue;
      }
      for (let i = 0; i < sentence.length; i += maxChars) {
        out.push(sentence.slice(i, i + maxChars));
      }
    }
  }
  return out;
}

/** The last `n` characters, snapped forward to a word boundary so overlap starts cleanly. */
function tail(text: string, n: number): string {
  const slice = text.slice(-n);
  const space = slice.indexOf(' ');
  return space === -1 ? slice : slice.slice(space + 1);
}
