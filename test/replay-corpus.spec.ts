import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { upcast, hasUpcastPath } from '../src/domain/event-log/upcasters.js';
import { registerAllUpcasters } from '../src/domain/event-log/upcasters/index.js';
import { CURRENT_EVENT_SCHEMA_VERSION } from '../src/domain/event-log/taxonomy.js';

registerAllUpcasters();

interface Corpus {
  description: string;
  events: { event_type: string; schema_version: number; payload: Record<string, unknown> }[];
}

const corpusDir = join(process.cwd(), 'test', 'replay-corpus');
const files = readdirSync(corpusDir).filter((f) => f.endsWith('.json'));

/**
 * §0.2's gate, as a test.
 *
 * "CI replays an archived corpus of real event logs on every change to the event model. A
 * change that breaks replay of existing logs IS a breaking change." Without this, the
 * first unversioned change silently renders prior history unreplayable — discovered when
 * history is most needed, which is during an incident.
 */
describe('replay corpus (§0.2)', () => {
  it('has a corpus to replay at all', () => {
    // A green suite with an empty corpus proves nothing, so the absence is the failure.
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const corpus = JSON.parse(readFileSync(join(corpusDir, file), 'utf8')) as Corpus;

    describe(file, () => {
      it('lifts every archived event to the current version', () => {
        for (const event of corpus.events) {
          expect(
            hasUpcastPath(event.event_type, event.schema_version),
            `no upcast path for ${event.event_type} v${event.schema_version} — ` +
              `an archived event can no longer be read`,
          ).toBe(true);

          const lifted = upcast(event.event_type, event.schema_version, event.payload);
          expect(lifted).toBeTypeOf('object');
        }
      });

      it('preserves the meaning of a v1 tool result', () => {
        const event = corpus.events.find((e) => e.event_type === 'tool.completed')!;
        const lifted = upcast(event.event_type, event.schema_version, event.payload);
        // The v1 field was `result`; a reader of the current shape looks for `output`.
        expect(lifted['output']).toEqual({ ok: true });
        // Unknown, not false. Claiming every historical call was uncached would be
        // fabricating data that later gets aggregated.
        expect(lifted['cached']).toBeNull();
      });

      it('refuses to invent a token split it cannot know', () => {
        const event = corpus.events.find((e) => e.event_type === 'model.completed')!;
        const lifted = upcast(event.event_type, event.schema_version, event.payload);
        expect(lifted['inputTokens']).toBeNull();
        expect(lifted['outputTokens']).toBeNull();
        // The original total survives rather than being apportioned by a guess that would
        // then be indistinguishable from measured data.
        expect(lifted['totalTokensLegacy']).toBe(42);
      });
    });
  }

  it('needs no upcaster for events already at the current version', () => {
    const payload = { toolRef: 'demo.echo', output: { ok: true }, cached: false };
    expect(upcast('tool.completed', CURRENT_EVENT_SCHEMA_VERSION, payload)).toEqual(payload);
  });

  it('fails loudly when an upcast path is missing', () => {
    // The alternative is a silent partial read, which is worse than an error: the event
    // would appear to have no payload rather than to be unreadable.
    expect(hasUpcastPath('never.registered', 1)).toBe(false);
    expect(() => upcast('never.registered', 1, {})).toThrow(/No upcaster/);
  });
});
