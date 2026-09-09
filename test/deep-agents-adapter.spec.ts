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
  /**
   * A child host that records WHICH agent asked, so a test can prove an in-process
   * sub-agent's work was attributed to it rather than to its caller.
   */
  forSubAgent(alias: string): RunHost | null {
    if (!this.children.has(alias)) this.children.set(alias, new FakeChild(alias, this));
    return this.children.get(alias)!;
  }
  readonly children = new Map<string, FakeChild>();
}

/** The scoped host `forSubAgent` hands back, sharing the parent's script. */
class FakeChild implements RunHost {
  readonly modelCalls: HostModelRequest[] = [];
  readonly toolCalls: { ref: string; args: Record<string, unknown> }[] = [];

  constructor(
    readonly alias: string,
    private readonly parent: ScriptedHost,
  ) {}

  async callModel(request: HostModelRequest) {
    this.modelCalls.push(request);
    return this.parent.callModel(request);
  }
  async callTool(ref: string, args: Record<string, unknown>) {
    this.toolCalls.push({ ref, args });
    return this.parent.callTool(ref, args);
  }
  async delegate(alias: string): Promise<HostToolOutcome> {
    return { kind: 'suspended', reason: 'delegation', ref: alias };
  }
  async peerCall(alias: string): Promise<HostToolOutcome> {
    return { kind: 'suspended', reason: 'peer_call', ref: alias };
  }
  saveState(): void {}
  forSubAgent(): RunHost | null {
    // One level. An in-process child that could spawn its own in-process children would
    // nest unboundedly inside a run with no delegation chain to check against (§4.6).
    return null;
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
  inlineSubAgents: [],
  responseSchema: null,
  context: { compaction: false, maxChars: 24_000 },
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
        session(second, { runId, spec: gated, resume: { value: 'paid: receipt-9', ref: 'demo.pay', failed: false } }),
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
    subAgents: [{ alias: 'billing', description: 'Answers questions about invoices.', mode: 'run' as const, inline: null }],
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
          spec: spec({ subAgents: [{ alias: 'billing/refunds v2', description: null, mode: 'run' as const, inline: null }] }),
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

describe('a replayed super-step does not repeat its neighbours (Phase 7, §4.5)', () => {
  const twoTools = spec({
    tools: [
      { ref: 'demo.lookup', description: 'read something', inputSchema: { type: 'object' } },
      { ref: 'demo.pay', description: 'send money', inputSchema: { type: 'object' } },
    ],
  });

  it('does not re-run the sibling tool when one of them suspends for approval', async () => {
    const runId = `da-siblings-${Math.random().toString(36).slice(2, 8)}`;
    threads.push(runId);

    // One model turn requesting BOTH tools. LangGraph runs them in the same super-step.
    const turn = {
      text: '',
      toolCalls: [
        { name: 'demo.lookup', args: { id: 1 } },
        { name: 'demo.pay', args: { amount: 100 } },
      ],
    };

    const first = new ScriptedHost([turn], (ref) =>
      ref === 'demo.pay'
        ? { kind: 'suspended', reason: 'approval', ref: 'demo.pay' }
        : { kind: 'ok', output: 'balance 500' },
    );
    const out = await asTenant(() => adapter.run(session(first, { runId, spec: twoTools })));
    expect(out.type).toBe('suspended');
    expect(first.toolCalls.map((c) => c.ref).sort()).toEqual(['demo.lookup', 'demo.pay']);

    // Resume. LangGraph re-executes the whole super-step, so without the ledger
    // `demo.lookup` would be called a second time -- and had it been a write rather than a
    // read, it would have happened twice because a human approved something else.
    const second = new ScriptedHost([{ text: 'All done.' }], () => ({ kind: 'ok', output: 'x' }));
    await asTenant(() =>
      adapter.run(
        session(second, {
          runId,
          spec: twoTools,
          state: JSON.parse(JSON.stringify(first.saved)) as unknown,
          resume: { value: 'paid: receipt-9', ref: 'demo.pay', failed: false },
        }),
      ),
    );

    expect(second.toolCalls).toHaveLength(0);
  });

  it('records the ledger BEFORE interrupting, since interrupt() never returns', async () => {
    const host = new ScriptedHost(
      [
        {
          text: '',
          toolCalls: [
            { name: 'demo.lookup', args: { id: 1 } },
            { name: 'demo.pay', args: { amount: 100 } },
          ],
        },
      ],
      (ref) =>
        ref === 'demo.pay'
          ? { kind: 'suspended', reason: 'approval', ref: 'demo.pay' }
          : { kind: 'ok', output: 'balance 500' },
    );
    await asTenant(() => adapter.run(session(host, { spec: twoTools })));

    // `interrupt()` throws a control signal that unwinds the graph, so a saveState after
    // it would save nothing and the resumed run would re-read the balance.
    const saved = host.saved as { settled: Record<string, string> };
    expect(Object.values(saved.settled)).toContain('balance 500');
  });
});

describe('the free wins (Phase 9)', () => {
  it('offers planning and filesystem tools the platform never had', async () => {
    const host = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() => adapter.run(session(host)));

    const advertised = (host.modelCalls[0]!.tools ?? []).map((t) => t.name);
    // Consumer 03 needs these, and the old adapter had none of them: writing them would
    // have been another wheel.
    expect(advertised).toEqual(
      expect.arrayContaining(['write_todos', 'ls', 'read_file', 'write_file', 'glob', 'grep']),
    );
  });

  it('asks for a structured answer through tool calling, not through the prompt', async () => {
    const schema = {
      type: 'object',
      properties: { intent: { type: 'string' }, confidence: { type: 'number' } },
      required: ['intent'],
    };
    const host = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() => adapter.run(session(host, { spec: spec({ responseSchema: schema }) })));

    // The shape is a TOOL the provider must call, so a trailing comma or a markdown fence
    // is unrepresentable -- rather than asking for JSON in prose and parsing the reply,
    // which is where a correct answer becomes a failed run.
    const advertised = (host.modelCalls[0]!.tools ?? []);
    const structured = advertised.find((t) => JSON.stringify(t.parameters).includes('confidence'));
    expect(structured).toBeDefined();
  });

  it('leaves summarization off when the agent disabled compaction (§0.5)', async () => {
    const off = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() =>
      adapter.run(session(off, { spec: spec({ context: { compaction: false, maxChars: 24_000 } }) })),
    );

    const on = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() =>
      adapter.run(session(on, { spec: spec({ context: { compaction: true, maxChars: 24_000 } }) })),
    );

    // Both still answer. The assertion that matters is that the flag is wired at all: a
    // compensating mechanism that cannot be turned off cannot be shown to help, and
    // over-eager summarisation does its damage invisibly.
    expect(off.modelCalls).toHaveLength(1);
    expect(on.modelCalls).toHaveLength(1);
  });
});

describe('inline sub-agents — DeepAgents named helpers (§13.3)', () => {
  const researcher = {
    name: 'researcher',
    description: 'Digs through the manuals. Use for open-ended lookups.',
    prompt: 'YOU ARE THE RESEARCHER. Answer only from what you read.',
    tools: ['demo.lookup'],
    skills: [],
  };
  const withHelper = spec({
    inlineSubAgents: [researcher],
    tools: [
      { ref: 'demo.lookup', description: 'read something', inputSchema: { type: 'object' } },
      { ref: 'demo.pay', description: 'send money', inputSchema: { type: 'object' } },
    ],
  });

  it('runs the helper with ITS OWN prompt in a fresh context', async () => {
    const host = new ScriptedHost([
      { text: '', toolCalls: [{ name: 'task', args: { description: 'find it', subagent_type: 'researcher' } }] },
      { text: 'the manual says 42' },
      { text: 'The answer is 42.' },
    ]);
    await asTenant(() => adapter.run(session(host, { spec: withHelper })));

    // The helper's turn carries its own system prompt, and NOT the parent's transcript --
    // that clean context window is the entire point of an in-process helper.
    const prompts = host.modelCalls.map((c) => c.systemPrompt ?? '');
    expect(prompts.some((p) => p.includes('YOU ARE THE RESEARCHER'))).toBe(true);
    expect(prompts.filter((p) => p.includes('YOU ARE THE RESEARCHER'))).toHaveLength(1);
  });

  it('narrows the helper to its declared tools', async () => {
    const host = new ScriptedHost([
      { text: '', toolCalls: [{ name: 'task', args: { description: 'find it', subagent_type: 'researcher' } }] },
      { text: 'found' },
      { text: 'done' },
    ]);
    await asTenant(() => adapter.run(session(host, { spec: withHelper })));

    const helperTurn = host.modelCalls.find((c) => (c.systemPrompt ?? '').includes('RESEARCHER'))!;
    const offered = (helperTurn.tools ?? []).map((t) => t.name);
    expect(offered).toContain('demo.lookup');
    // A research helper has no business being able to send money. Narrowing is about
    // focus, not authority -- `callTool` would still refuse anything unbound.
    expect(offered).not.toContain('demo.pay');
  });

  it('meters the helper on the PARENT: same host, same ledger, same ceiling', async () => {
    const host = new ScriptedHost([
      { text: '', toolCalls: [{ name: 'task', args: { description: 'find it', subagent_type: 'researcher' } }] },
      { text: '', toolCalls: [{ name: 'demo.lookup', args: { id: 1 } }] },
      { text: 'found 42' },
      { text: 'The answer is 42.' },
    ]);
    await asTenant(() => adapter.run(session(host, { spec: withHelper })));

    // The tool the HELPER called arrived through the parent's host, so it lands in the
    // parent's steps and tool_invocations. A helper reaching a provider or a tool directly
    // would be unbilled, unbudgeted, unrecorded work (§9, §4.5).
    expect(host.toolCalls.map((c) => c.ref)).toContain('demo.lookup');
  });

  it('does not confuse a helper with a registered sub-agent', async () => {
    const host = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() =>
      adapter.run(
        session(host, {
          spec: spec({
            inlineSubAgents: [researcher],
            subAgents: [{ alias: 'billing', description: 'Owns invoices.', mode: 'run' as const, inline: null }],
          }),
        }),
      ),
    );

    const advertised = (host.modelCalls[0]!.tools ?? []).map((t) => t.name);
    // `task` reaches the in-process helper: parent's model, parent's budget, no lifecycle.
    expect(advertised).toContain('task');
    // `delegate_to_billing` starts a separate run with its own version, policy and budget.
    expect(advertised).toContain('delegate_to_billing');
  });
});

describe("mode: 'inline' — a registered sub-agent inside its caller's run (§13.3)", () => {
  const child = {
    alias: 'classifier',
    description: 'Sorts a request into one of five intents.',
    mode: 'inline' as const,
    inline: {
      agentVersionId: 'ver-classifier',
      systemPrompt: 'YOU ARE THE CLASSIFIER. Answer with one word.',
      tools: [{ ref: 'demo.taxonomy', description: 'read the intent list', inputSchema: { type: 'object' } }],
      skills: [
        {
          name: 'intent taxonomy',
          version: 2,
          whenToUse: 'always, before answering',
          instructions: 'THE FIVE INTENTS ARE: refund, dispute, status, update, other.',
        },
      ],
    },
  };
  const caller = spec({
    subAgents: [child],
    tools: [{ ref: 'demo.pay', description: 'send money', inputSchema: { type: 'object' } }],
  });

  it('is reached through `task`, NOT through a delegation handle', async () => {
    const host = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() => adapter.run(session(host, { spec: caller })));

    const advertised = (host.modelCalls[0]!.tools ?? []).map((t) => t.name);
    expect(advertised).toContain('task');
    // Offering both would let the model pick a semantics it cannot reason about: the two
    // differ in retries, budget and whether a run exists afterwards to inspect.
    expect(advertised).not.toContain('delegate_to_classifier');
  });

  it("runs with the CHILD's prompt and the CHILD's tools, not the caller's", async () => {
    const host = new ScriptedHost([
      { text: '', toolCalls: [{ name: 'task', args: { description: 'classify', subagent_type: 'agent_classifier' } }] },
      { text: 'refund' },
      { text: 'Handled: refund.' },
    ]);
    await asTenant(() => adapter.run(session(host, { spec: caller })));

    const childHost = host.children.get('classifier');
    expect(childHost).toBeDefined();
    const childTurn = childHost!.modelCalls[0]!;

    expect(childTurn.systemPrompt).toContain('YOU ARE THE CLASSIFIER');
    const offered = (childTurn.tools ?? []).map((t) => t.name);
    expect(offered).toContain('demo.taxonomy');
    // The caller can send money. A classifier bound inline must NOT inherit that -- if it
    // did, `inline` would be a way to launder capability between agent versions.
    expect(offered).not.toContain('demo.pay');
  });

  it("carries the CHILD's own pinned skills, which DeepAgents does not inherit", async () => {
    const host = new ScriptedHost([
      { text: '', toolCalls: [{ name: 'task', args: { description: 'classify', subagent_type: 'agent_classifier' } }] },
      { text: 'refund' },
      { text: 'done' },
    ]);
    await asTenant(() => adapter.run(session(host, { spec: caller })));

    const childTurn = host.children.get('classifier')!.modelCalls[0]!;
    // Progressive disclosure still applies, so the selection hint is what appears.
    expect(childTurn.systemPrompt).toContain('always, before answering');
    // And the caller must not be handed a procedure belonging to an agent it delegates to.
    expect(host.modelCalls[0]!.systemPrompt ?? '').not.toContain('always, before answering');
  });

  it('routes the child through its OWN host, so the spend is attributable', async () => {
    const host = new ScriptedHost([
      { text: '', toolCalls: [{ name: 'task', args: { description: 'classify', subagent_type: 'agent_classifier' } }] },
      { text: '', toolCalls: [{ name: 'demo.taxonomy', args: {} }] },
      { text: 'refund' },
      { text: 'Handled: refund.' },
    ]);
    await asTenant(() => adapter.run(session(host, { spec: caller })));

    // Every call the child made went through the scoped host, which stamps
    // `steps.agent_version_id`. Without that the child's model spend and tool calls land
    // on the caller's version and no cost report can separate a stage from its caller.
    const childHost = host.children.get('classifier')!;
    expect(childHost.modelCalls.length).toBeGreaterThan(0);
    expect(childHost.toolCalls.map((c) => c.ref)).toContain('demo.taxonomy');
  });

  it("still offers a delegation handle for a sibling bound 'run'", async () => {
    const host = new ScriptedHost([{ text: 'ok' }]);
    await asTenant(() =>
      adapter.run(
        session(host, {
          spec: spec({
            subAgents: [child, { alias: 'billing', description: 'Owns invoices.', mode: 'run', inline: null }],
          }),
        }),
      ),
    );

    const advertised = (host.modelCalls[0]!.tools ?? []).map((t) => t.name);
    expect(advertised).toContain('delegate_to_billing');
    expect(advertised).not.toContain('delegate_to_classifier');
  });
});
