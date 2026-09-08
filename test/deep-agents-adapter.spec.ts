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
  harness: { excludedTools: [], systemPromptSuffix: null },
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

describe('skills and memory behind DeepAgents own middleware (Phase 4)', () => {
  const withSkill = spec({
    skills: [
      {
        name: 'refund procedure',
        version: 3,
        whenToUse: 'the customer asks for money back',
        instructions: 'STEP ONE: verify the order. STEP TWO: check the refund window.',
      },
    ],
  });

  it('advertises a skill by DESCRIPTION and withholds the body until asked', async () => {
    const host = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() => adapter.run(session(host, { spec: withSkill })));

    const prompt = host.modelCalls[0]!.systemPrompt ?? '';
    // The selection hint is present...
    expect(prompt).toContain('the customer asks for money back');
    // ...and the procedure itself is NOT. Twelve pinned skills used to mean twelve full
    // procedures in context on every turn, most of them irrelevant to the question asked.
    expect(prompt).not.toContain('STEP ONE: verify the order');
  });

  it('lets the model read the body through the filesystem when it decides to', async () => {
    const host = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() => adapter.run(session(host, { spec: withSkill })));

    // The read tool is offered, which is what makes the withheld body reachable rather
    // than lost. Without it, progressive disclosure would just be truncation.
    const advertised = (host.modelCalls[0]!.tools ?? []).map((t) => t.name);
    expect(advertised).toContain('read_file');
  });

  it('puts recalled memory in the prompt WHOLE, with provenance per record', async () => {
    const host = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() =>
      adapter.run(
        session(host, {
          spec: spec({
            recalled: [
              { tier: 'semantic', content: 'prefers email', provenance: 'run:1', trusted: true, score: 1 },
              { tier: 'semantic', content: 'lives in Pune', provenance: 'peer:x', trusted: false, score: 1 },
            ],
          }),
        }),
      ),
    );

    const prompt = host.modelCalls[0]!.systemPrompt ?? '';
    expect(prompt).toContain('prefers email');
    // §6.4: hearsay stays marked at the point of use, not in a header the model may not
    // carry down to the fact it acts on.
    expect(prompt).toContain('unverified');
  });

  it('refuses to let a run edit a skill it was given', async () => {
    const backendSpec = withSkill;
    const host = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() => adapter.run(session(host, { spec: backendSpec })));

    // Constructed the same way the adapter does, since the refusal is the backend's.
    const { PlatformBackend } = await import(
      '../src/adapters/framework/deep-agents/platform.backend.js'
    );
    const backend = new PlatformBackend(backendSpec);
    const path = '/skills/refund-procedure/SKILL.md';

    expect(backend.read(path).content).toContain('STEP ONE');
    // A skill is a governed, versioned artifact (§17.2). If a run could rewrite one, the
    // next run's behaviour would depend on the last run's improvisation and no eval could
    // attribute a regression to anything.
    expect(backend.write(path, 'do whatever').error).toMatch(/cannot be written/);
    expect(backend.edit(path, 'STEP ONE', 'SKIP').error).toMatch(/cannot be edited/);
    // Scratch space is still writable, or the filesystem tools would be useless.
    expect(backend.write('/workspace/notes.md', 'draft').error).toBeUndefined();
  });
});

describe('the policy shapes the framework surface too (Phase 5)', () => {
  it('hides a framework tool the pinned policy denies', async () => {
    const open = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() => adapter.run(session(open)));
    const before = (open.modelCalls[0]!.tools ?? []).map((t) => t.name);
    expect(before).toContain('write_file');

    const locked = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() =>
      adapter.run(
        session(locked, {
          spec: spec({ harness: { excludedTools: ['write_file'], systemPromptSuffix: null } }),
        }),
      ),
    );

    // Until the framework was allowed to bring its own tools, "this agent may not write
    // files" was unsayable: the platform had no name for a tool it did not grant.
    expect((locked.modelCalls[0]!.tools ?? []).map((t) => t.name)).not.toContain('write_file');
  });

  it('appends per-model tuning AFTER the registry prompt, not inside it', async () => {
    const host = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() =>
      adapter.run(
        session(host, {
          spec: spec({
            systemPrompt: 'AUTHORED PROMPT BODY',
            harness: { excludedTools: [], systemPromptSuffix: 'Answer in one sentence.' },
          }),
        }),
      ),
    );

    const prompt = host.modelCalls[0]!.systemPrompt ?? '';
    expect(prompt).toContain('AUTHORED PROMPT BODY');
    expect(prompt).toContain('Answer in one sentence.');
    // Order matters: the nudge is a suffix so that swapping models does not require a new
    // prompt version -- and therefore a new eval baseline -- every time (§17.2).
    expect(prompt.indexOf('AUTHORED PROMPT BODY')).toBeLessThan(prompt.indexOf('Answer in one'));
  });
});

describe('two kinds of sub-agent, kept apart (Phase 6, §13.3)', () => {
  const withBoth = spec({
    subAgents: [{ alias: 'billing', description: 'Answers questions about invoices.' }],
  });

  it('offers the in-process helper and the platform delegation as DIFFERENT tools', async () => {
    const host = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() => adapter.run(session(host, { spec: withBoth })));

    const advertised = (host.modelCalls[0]!.tools ?? []).map((t) => t.name);
    // `task`: DeepAgents' own, in-process, no lifecycle, exists to keep a long sub-task
    // out of the main context window.
    expect(advertised).toContain('task');
    // `delegate_to_billing`: a separate run with its own agent version, policy, budget and
    // checkpoints. Collapsing the two would silently strip per-stage governance from
    // every pipeline the platform runs.
    expect(advertised).toContain('delegate_to_billing');
  });

  it('gives the model the sub-agent DESCRIPTION, not just an alias', async () => {
    const host = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() => adapter.run(session(host, { spec: withBoth })));

    const handle = (host.modelCalls[0]!.tools ?? []).find((t) => t.name === 'delegate_to_billing');
    // Picking the right one of six sub-agents by alias alone is exactly the guessing that
    // produces a plausible wrong answer. The registry has always had this text; nothing
    // used to carry it to the model.
    expect(handle?.description).toContain('invoices');
  });

  it('sanitises an alias a provider would reject, rather than failing the run', async () => {
    const host = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() =>
      adapter.run(
        session(host, {
          spec: spec({ subAgents: [{ alias: 'billing/refunds v2', description: null }] }),
        }),
      ),
    );

    const names = (host.modelCalls[0]!.tools ?? []).map((t) => t.name);
    expect(names).toContain('delegate_to_billing_refunds_v2');
  });

  it('meters the in-process helper through the host like any other model call', async () => {
    const host = new ScriptedHost([
      { text: '', toolCalls: [{ name: 'task', args: { description: 'sub', subagent_type: 'general-purpose' } }] },
      { text: 'sub-agent answer' },
      { text: 'final answer' },
    ]);
    await asTenant(() => adapter.run(session(host, { spec: withBoth })));

    // The in-process sub-agent shares this adapter's HostChatModel, so its thinking is
    // billed, budgeted and recorded exactly like the parent's. A framework sub-agent that
    // reached a provider directly would be free reasoning nobody could see (§9).
    expect(host.modelCalls.length).toBeGreaterThanOrEqual(3);
  });
});
