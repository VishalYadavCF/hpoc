import { describe, expect, it } from 'vitest';
import { EchoAdapter } from '../src/adapters/framework/echo/echo.adapter.js';
import type { AdvanceInput } from '../src/domain/ports/framework-adapter.port.js';

const base = (over: Partial<AdvanceInput> = {}): AdvanceInput => ({
  runId: 'r1',
  spec: { modelRef: 'm', systemPrompt: null, tools: [], maxSteps: 50, recalled: [], skills: [], knowledge: [], subAgents: [], peers: [] },
  input: 'hello',
  stepSeq: 0,
  state: null,
  observation: { kind: 'none' },
  ...over,
});

describe('echo adapter — §0.3 second orchestration adapter', () => {
  it('opens with a model call', async () => {
    const out = await new EchoAdapter().advance(base());
    expect(out.action.type).toBe('model_call');
  });

  it('completes without a tool call when no tool is bound', async () => {
    const adapter = new EchoAdapter();
    const first = await adapter.advance(base());
    const second = await adapter.advance(
      base({ state: first.state, observation: { kind: 'model_result', content: 'x' }, stepSeq: 1 }),
    );
    expect(second.action.type).toBe('complete');
  });

  it('calls the first bound tool before completing', async () => {
    const adapter = new EchoAdapter();
    const spec = {
      modelRef: 'm',
      systemPrompt: null,
      tools: [{ ref: 'demo.echo', description: null, inputSchema: {} }],
      maxSteps: 50,
      recalled: [],
      skills: [],
      knowledge: [],
      subAgents: [],
      peers: [],
    };
    const first = await adapter.advance(base({ spec }));
    const second = await adapter.advance(
      base({ spec, state: first.state, stepSeq: 1, observation: { kind: 'model_result', content: 'x' } }),
    );
    expect(second.action).toMatchObject({ type: 'tool_call', toolRef: 'demo.echo' });

    const third = await adapter.advance(
      base({ spec, state: second.state, stepSeq: 2, observation: { kind: 'tool_result', content: { ok: true } } }),
    );
    expect(third.action.type).toBe('complete');
  });

  it('round-trips its state, so a resumed run continues rather than restarts', async () => {
    const adapter = new EchoAdapter();
    const first = await adapter.advance(base());
    // Simulate a checkpoint: state crosses a JSON boundary and comes back.
    const revived = JSON.parse(JSON.stringify(first.state)) as unknown;
    const second = await adapter.advance(
      base({ state: revived, stepSeq: 1, observation: { kind: 'model_result', content: 'x' } }),
    );
    expect(second.action.type).toBe('complete');
  });
});
