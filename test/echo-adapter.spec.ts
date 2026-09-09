import { describe, expect, it } from 'vitest';
import { EchoAdapter } from '../src/adapters/framework/echo/echo.adapter.js';
import { PipelineAdapter } from '../src/adapters/framework/pipeline/pipeline.adapter.js';
import type {
  AgentSpecView,
  HostModelRequest,
  HostToolOutcome,
  RunHost,
  RunSession,
} from '../src/domain/ports/framework-adapter.port.js';

/** Records what the framework asked the platform for, so a test can assert on it. */
class FakeHost implements RunHost {
  readonly modelCalls: HostModelRequest[] = [];
  readonly toolCalls: { ref: string; args: Record<string, unknown> }[] = [];
  readonly delegations: { alias: string; input: unknown }[] = [];
  readonly peerCalls: { alias: string; input: unknown }[] = [];
  saved: unknown = null;

  constructor(
    private readonly toolOutcome: HostToolOutcome = { kind: 'ok', output: { ok: true } },
    private readonly handoffOutcome: HostToolOutcome = { kind: 'suspended', reason: 'delegation', ref: 'x' },
  ) {}

  async callModel(request: HostModelRequest) {
    this.modelCalls.push(request);
    return { text: 'model said so', toolCalls: [], inputTokens: 1, outputTokens: 2 };
  }
  async callTool(ref: string, args: Record<string, unknown>) {
    this.toolCalls.push({ ref, args });
    return this.toolOutcome;
  }
  async delegate(alias: string, input: unknown) {
    this.delegations.push({ alias, input });
    return this.handoffOutcome;
  }
  async peerCall(alias: string, input: unknown) {
    this.peerCalls.push({ alias, input });
    return this.handoffOutcome;
  }
  saveState(state: unknown) {
    this.saved = state;
  }
}

const spec = (over: Partial<AgentSpecView> = {}): AgentSpecView => ({
  modelRef: 'm',
  systemPrompt: null,
  tools: [],
  maxSteps: 50,
  recalled: [],
  skills: [],
  knowledge: [],
  subAgents: [],
  peers: [],
  harness: { excludedTools: [], systemPromptSuffix: null },
  inlineSubAgents: [],
  responseSchema: null,
  context: { compaction: false, maxChars: 24_000 },
  ...over,
});

const session = (host: RunHost, over: Partial<RunSession> = {}): RunSession => ({
  runId: 'r1',
  spec: spec(),
  input: 'hello',
  state: null,
  resume: null,
  signal: new AbortController().signal,
  host,
  ...over,
});

describe('echo adapter — §0.3 second orchestration adapter', () => {
  it('reaches the model through the host rather than a provider of its own', async () => {
    const host = new FakeHost();
    const out = await new EchoAdapter().run(session(host));

    expect(out.type).toBe('complete');
    // The point of the assertion is the ROUTE, not the answer: an adapter that acquired a
    // vendor client directly would still produce text, and would have skipped the
    // residency gate, the cost ledger and the step row on the way (§9).
    expect(host.modelCalls).toHaveLength(1);
    expect(host.modelCalls[0]!.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('completes without a tool call when no tool is bound', async () => {
    const host = new FakeHost();
    const out = await new EchoAdapter().run(session(host));
    expect(out).toMatchObject({ type: 'complete', output: { text: 'model said so' } });
    expect(host.toolCalls).toHaveLength(0);
  });

  it('calls the first bound tool before completing', async () => {
    const host = new FakeHost();
    const out = await new EchoAdapter().run(
      session(host, { spec: spec({ tools: [{ ref: 'demo.echo', description: null, inputSchema: {} }] }) }),
    );

    expect(host.toolCalls).toEqual([{ ref: 'demo.echo', args: { echo: 'model said so' } }]);
    expect(out).toMatchObject({ type: 'complete', output: { observation: { ok: true } } });
  });

  it('stops at a suspension instead of reporting a result the run never produced', async () => {
    const host = new FakeHost({ kind: 'suspended', reason: 'approval', ref: 'demo.pay' });
    const out = await new EchoAdapter().run(
      session(host, { spec: spec({ tools: [{ ref: 'demo.pay', description: null, inputSchema: {} }] }) }),
    );

    // A `complete` here would overwrite a run that is legitimately `waiting` for a human,
    // and the approval would then be granted for something already reported as done.
    expect(out.type).toBe('suspended');
  });

  it('RESUMES rather than replays, so an approved side effect happens exactly once', async () => {
    const host = new FakeHost();
    const out = await new EchoAdapter().run(
      session(host, {
        spec: spec({ tools: [{ ref: 'demo.pay', description: null, inputSchema: {} }] }),
        resume: { value: { charged: true }, ref: 'demo.pay', failed: false },
      }),
    );

    // This is the sharpest edge on the new port. `run()` is re-entered from the top after
    // a suspension, so an adapter that simply re-executes charges the card a second time
    // -- caused by the platform politely asking again.
    expect(host.toolCalls).toHaveLength(0);
    expect(host.modelCalls).toHaveLength(0);
    expect(out).toMatchObject({ type: 'complete', output: { observation: { charged: true } } });
  });

  it('names a peer by ALIAS and cannot tell where it runs', async () => {
    const host = new FakeHost();
    await new EchoAdapter().run(
      session(host, { spec: spec({ peers: [{ alias: 'billing', description: null }] }) }),
    );
    expect(host.peerCalls).toEqual([{ alias: 'billing', input: 'model said so' }]);
  });
});

describe('pipeline adapter — a framework with no checkpointer of its own', () => {
  const stages = spec({
    subAgents: [
      { alias: 'intent', description: null },
      { alias: 'draft', description: null },
    ],
  });

  it('dispatches stage one and saves its position BEFORE suspending', async () => {
    const host = new FakeHost();
    const out = await new PipelineAdapter().run(session(host, { spec: stages }));

    expect(out.type).toBe('suspended');
    expect(host.delegations).toEqual([{ alias: 'intent', input: 'hello' }]);
    // Written before the delegate call, because nothing after it runs.
    expect(host.saved).toEqual({ index: 1, results: [] });
  });

  it('resumes at stage two rather than re-dispatching stage one', async () => {
    const host = new FakeHost();
    const out = await new PipelineAdapter().run(
      session(host, {
        spec: stages,
        // What the platform restored from the checkpoint, having crossed JSON.
        state: JSON.parse(JSON.stringify({ index: 1, results: [] })) as unknown,
        resume: { value: { intent: 'refund' }, ref: 'intent', failed: false },
      }),
    );

    expect(out.type).toBe('suspended');
    // Stage one is NOT re-dispatched -- that is the whole of `saveState`'s job.
    expect(host.delegations).toEqual([{ alias: 'draft', input: { intent: 'refund' } }]);
    expect(host.saved).toEqual({
      index: 2,
      results: [{ alias: 'intent', output: { intent: 'refund' }, failed: false }],
    });
  });

  it('stops the pipeline when a stage fails instead of feeding the next one nothing', async () => {
    const host = new FakeHost();
    const out = await new PipelineAdapter().run(
      session(host, {
        spec: stages,
        state: { index: 1, results: [] },
        resume: { value: { error: 'intent agent failed' }, ref: 'intent', failed: true },
      }),
    );

    expect(host.delegations).toHaveLength(0);
    expect(out).toMatchObject({
      type: 'complete',
      output: { halted: true, stages: [{ alias: 'intent', failed: true }] },
    });
  });
});
