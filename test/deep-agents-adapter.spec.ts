import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeepAgentsAdapter } from '../src/adapters/framework/deep-agents/deep-agents.adapter.js';
import { PostgresCheckpointSaver } from '../src/adapters/framework/deep-agents/postgres.checkpoint-saver.js';
import type {
  AgentSpecView,
  HostModelRequest,
  HostToolOutcome,
  RunHost,
  RunSession,
} from '../src/domain/ports/framework-adapter.port.js';
import { runInContext } from '../src/platform/context/platform-context.js';
import { fixture, type Fixture } from './fixtures.js';

/**
 * Phase 3: the framework drives the loop, and the platform still owns every consequence.
 *
 * These drive a REAL `createDeepAgent` graph -- real middleware, real tool node, real
 * checkpointer -- against a scripted host. The previous adapter could not be tested this
 * way because it never called `createDeepAgent` at all.
 */
let f: Fixture;
let adapter: DeepAgentsAdapter;
const threads: string[] = [];
let saver: PostgresCheckpointSaver;

/**
 * A host that answers from a script, so a test can pin exactly what the model said.
 *
 * The scripted turns stand in for a provider; everything downstream of `callModel` --
 * DeepAgents' middleware, the tool node, the checkpointer -- is the real thing.
 */
class ScriptedHost implements RunHost {
  readonly modelCalls: HostModelRequest[] = [];
  readonly toolCalls: { ref: string; args: Record<string, unknown> }[] = [];
  saved: unknown = null;
  private turn = 0;

  constructor(
    private readonly script: { text: string; toolCalls?: { name: string; args: Record<string, unknown> }[] }[],
    private readonly toolOutcome: (ref: string) => HostToolOutcome = () => ({ kind: 'ok', output: 'done' }),
  ) {}

  async callModel(request: HostModelRequest) {
    this.modelCalls.push(request);
    const turn = this.script[Math.min(this.turn++, this.script.length - 1)]!;
    return {
      text: turn.text,
      toolCalls: (turn.toolCalls ?? []).map((c, i) => ({ id: `c${this.turn}_${i}`, ...c })),
      inputTokens: 10,
      outputTokens: 5,
    };
  }
  async callTool(ref: string, args: Record<string, unknown>) {
    this.toolCalls.push({ ref, args });
    return this.toolOutcome(ref);
  }
  async delegate(alias: string): Promise<HostToolOutcome> {
    return { kind: 'suspended', reason: 'delegation', ref: alias };
  }
  async peerCall(alias: string): Promise<HostToolOutcome> {
    return { kind: 'suspended', reason: 'peer_call', ref: alias };
  }
  saveState(state: unknown) {
    this.saved = state;
  }
}

const spec = (over: Partial<AgentSpecView> = {}): AgentSpecView => ({
  modelRef: 'm',
  systemPrompt: 'You are a test agent.',
  tools: [],
  maxSteps: 10,
  recalled: [],
  skills: [],
  knowledge: [],
  subAgents: [],
  peers: [],
  ...over,
});

const session = (host: RunHost, over: Partial<RunSession> = {}): RunSession => {
  const runId = (over.runId as string) ?? `da-${Math.random().toString(36).slice(2, 10)}`;
  threads.push(runId);
  return {
    runId,
    spec: spec(),
    input: 'what is the balance?',
    state: null,
    resume: null,
    signal: new AbortController().signal,
    host,
    ...over,
    // `runId` is generated above so the thread can be cleaned up; an override still wins.
    ...(over.runId ? { runId: over.runId } : {}),
  };
};

/** The saver reads its tenant from the ambient context, exactly as the run loop pins it. */
const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  runInContext(
    {
      orgId: f.orgId,
      namespaceId: f.namespaceId,
      tenantRef: 'deep-agents-tests',
      callerPrincipalId: f.principalId,
      onBehalfOfPrincipalId: null,
      authorizingHumanId: null,
      delegationChain: [],
      traceId: 'trace',
      correlationId: 'corr',
    },
    fn,
  );

beforeAll(async () => {
  f = await fixture();
  saver = new PostgresCheckpointSaver(f.db);
  adapter = new DeepAgentsAdapter(saver);
});

afterAll(async () => {
  for (const t of threads) await saver.deleteThread(t);
  await f.close();
});

describe('the framework drives the loop', () => {
  it('runs a real createDeepAgent graph and answers', async () => {
    const host = new ScriptedHost([{ text: 'The balance is 42.' }]);
    const out = await asTenant(() => adapter.run(session(host)));

    expect(out).toMatchObject({
      type: 'complete',
      output: { adapter: 'deep-agents', text: expect.stringContaining('42') as unknown as string },
    });
  });

  it('calls a bound tool NATIVELY, with no text parsing anywhere', async () => {
    const host = new ScriptedHost(
      [
        { text: '', toolCalls: [{ name: 'demo.balance', args: { account: 'a-1' } }] },
        { text: 'Your balance is 42.' },
      ],
      () => ({ kind: 'ok', output: '42' }),
    );

    const out = await asTenant(() =>
      adapter.run(
        session(host, {
          spec: spec({
            tools: [
              {
                ref: 'demo.balance',
                description: 'Read an account balance',
                inputSchema: { type: 'object', properties: { account: { type: 'string' } } },
              },
            ],
          }),
        }),
      ),
    );

    // The old adapter got here by regex-matching `TOOL demo.balance {...}` out of prose.
    // The arguments arriving intact is the difference between the two designs.
    expect(host.toolCalls).toEqual([{ ref: 'demo.balance', args: { account: 'a-1' } }]);
    expect(out.type).toBe('complete');
  });

  it('sends the model a TRANSCRIPT, so the second turn can see the tool result', async () => {
    const host = new ScriptedHost(
      [
        { text: '', toolCalls: [{ name: 'demo.balance', args: {} }] },
        { text: 'done' },
      ],
      () => ({ kind: 'ok', output: '42' }),
    );

    await asTenant(() =>
      adapter.run(
        session(host, {
          spec: spec({ tools: [{ ref: 'demo.balance', description: null, inputSchema: { type: 'object' } }] }),
        }),
      ),
    );

    const second = host.modelCalls[1]!;
    // Not a flattened string. The assistant turn keeps its tool_calls and the tool turn
    // keeps the matching id -- which is what stops the model re-asking for a result it
    // already has.
    const assistant = second.messages.find((m) => m.role === 'assistant');
    const toolTurn = second.messages.find((m) => m.role === 'tool');
    expect(assistant?.toolCalls?.[0]?.name).toBe('demo.balance');
    expect(toolTurn?.toolCallId).toBe(assistant!.toolCalls![0]!.id);
  });

  it('tells the model about DeepAgents own tools, not only the platform bindings', async () => {
    const host = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() => adapter.run(session(host)));

    const advertised = (host.modelCalls[0]!.tools ?? []).map((t) => t.name);
    // The middleware stack contributes tools the platform has never heard of. Advertising
    // only the bound set would leave them permanently invisible to the model -- which is
    // how "we adopted the framework" turns into "we adopted its import statement".
    expect(advertised.length).toBeGreaterThan(0);
  });

  it('surfaces a failed tool as information rather than killing the run (§13.5)', async () => {
    const host = new ScriptedHost(
      [
        { text: '', toolCalls: [{ name: 'demo.balance', args: {} }] },
        { text: 'I could not read the balance.' },
      ],
      () => ({ kind: 'error', message: 'upstream 503' }),
    );

    const out = await asTenant(() =>
      adapter.run(
        session(host, {
          spec: spec({ tools: [{ ref: 'demo.balance', description: null, inputSchema: { type: 'object' } }] }),
        }),
      ),
    );

    expect(out.type).toBe('complete');
    const toolTurn = host.modelCalls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolTurn?.content).toContain('upstream 503');
  });
});

describe('suspension survives the framework owning the loop', () => {
  const gated = spec({
    tools: [{ ref: 'demo.pay', description: 'Send money', inputSchema: { type: 'object' } }],
  });

  it('suspends on an approval gate instead of completing', async () => {
    const host = new ScriptedHost(
      [{ text: '', toolCalls: [{ name: 'demo.pay', args: { amount: 100 } }] }],
      () => ({ kind: 'suspended', reason: 'approval', ref: 'demo.pay' }),
    );

    const runId = `da-gate-${Math.random().toString(36).slice(2, 8)}`;
    threads.push(runId);
    const out = await asTenant(() => adapter.run(session(host, { runId, spec: gated })));

    expect(out.type).toBe('suspended');
    // The graph's state is in OUR Postgres, which is what makes the wait free: the worker
    // goes away, the run does not.
    const saved = await asTenant(() => saver.getTuple({ configurable: { thread_id: runId } }));
    expect(saved).toBeDefined();
  });

  it('RESUMES the approved call rather than replaying the run', async () => {
    const runId = `da-resume-${Math.random().toString(36).slice(2, 8)}`;
    threads.push(runId);

    const first = new ScriptedHost(
      [{ text: '', toolCalls: [{ name: 'demo.pay', args: { amount: 100 } }] }],
      () => ({ kind: 'suspended', reason: 'approval', ref: 'demo.pay' }),
    );
    await asTenant(() => adapter.run(session(first, { runId, spec: gated })));
    expect(first.toolCalls).toHaveLength(1);

    // Second drive: the platform executed the approved tool itself and hands back what it
    // produced. A framework that replayed instead of resuming would send the money twice.
    const second = new ScriptedHost([{ text: 'Payment sent.' }]);
    const out = await asTenant(() =>
      adapter.run(
        session(second, { runId, spec: gated, resume: { value: 'paid: receipt-9', ref: 'demo.pay' } }),
      ),
    );

    expect(out).toMatchObject({ type: 'complete' });
    expect(second.toolCalls).toHaveLength(0);
    // And the resumed graph carried the receipt back into the transcript.
    const turns = second.modelCalls[0]!.messages;
    expect(JSON.stringify(turns)).toContain('receipt-9');
  });
});

describe('the platform can still stop a run the framework is driving', () => {
  it('abandons the graph when the signal is tripped mid-flight', async () => {
    const controller = new AbortController();
    const host = new ScriptedHost(
      [{ text: '', toolCalls: [{ name: 'demo.slow', args: {} }] }, { text: 'never reached' }],
      () => {
        // Stands in for the host deciding the budget is spent during a step.
        controller.abort();
        return { kind: 'ok', output: 'ok' };
      },
    );

    const out = await asTenant(() =>
      adapter.run(
        session(host, {
          signal: controller.signal,
          spec: spec({ tools: [{ ref: 'demo.slow', description: null, inputSchema: { type: 'object' } }] }),
        }),
      ),
    );

    // Not `complete`. The run loop decides what an aborted run becomes -- and it knows the
    // real reason, which "aborted" would have overwritten.
    expect(out.type).not.toBe('complete');
    expect(host.modelCalls.length).toBeLessThanOrEqual(2);
  });
});
