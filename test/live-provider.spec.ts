import { describe, expect, it } from 'vitest';

/**
 * A real vendor call, skipped unless a key is present.
 *
 * Kept separate from the rest of the suite because it costs money and needs the network:
 * CI runs everything else against local servers speaking the same wire shapes, and this
 * file is what proves those fakes are not lying about the protocol.
 */
const KEY = process.env['TEST_LLM_KEY'];
const API = 'http://localhost:3000';
const HEADERS = {
  'content-type': 'application/json',
  'x-caller-subject': 'svc:demo-client',
  'x-namespace': 'demo',
  'x-tenant-ref': 'merchant-1',
};

describe.skipIf(!KEY)('live provider (TEST_LLM_KEY)', () => {
  it('completes a run against Gemini and records the vendor token counts', async () => {
    const created = (await (
      await fetch(`${API}/v1/runs`, {
        method: 'POST', headers: HEADERS,
        body: JSON.stringify({
          agent: {
            model: { ref: 'google/gemini-2.5-flash' },
            systemPrompt: 'Reply with exactly one short sentence.',
          },
          input: 'Say hello.',
        }),
      })
    ).json()) as { runId: string; status?: string };

    const deadline = Date.now() + 45_000;
    let run: Record<string, unknown>;
    for (;;) {
      run = (await (await fetch(`${API}/v1/runs/${created.runId}`, { headers: HEADERS })).json()) as Record<string, unknown>;
      if (['completed', 'failed'].includes(run['status'] as string)) break;
      if (Date.now() > deadline) throw new Error('run did not settle in 45s');
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(run['status'], JSON.stringify(run['error'])).toBe('completed');

    const output = run['output'] as { text: string };
    expect(output.text.length).toBeGreaterThan(0);
    // An echo provider would return the prompt back; a real completion does not.
    expect(output.text).not.toContain('Say hello.');

    // Real usage means a real call: the echo provider's approximation could not produce
    // a cost that matches the seeded per-1k prices against vendor-reported counts.
    expect(run['costMicros']).toBeGreaterThan(0);
  }, 60_000);
});
