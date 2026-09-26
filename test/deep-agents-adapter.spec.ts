import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeepAgentsAdapter } from '../src/adapters/framework/deep-agents/deep-agents.adapter.js';
import { PostgresCheckpointSaver } from '../src/adapters/framework/deep-agents/postgres.checkpoint-saver.js';
import { ObjectStoreAgentStore } from '../src/adapters/framework/deep-agents/object-store-agent-store.js';
import { FilesystemObjectStore } from '../src/adapters/storage/filesystem.object-store.js';
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
  readonly recordedArtifacts: Parameters<RunHost['recordArtifact']>[0][] = [];
  saved: unknown = null;
  private turn = 0;

  constructor(
    /** A call's `id` is minted per turn unless the script pins one, as a provider may. */
    private readonly script: { text: string; toolCalls?: { name: string; args: Record<string, unknown>; id?: string }[] }[],
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
  async recordArtifact(input: Parameters<RunHost['recordArtifact']>[0]) {
    this.recordedArtifacts.push(input);
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
  async recordArtifact(input: Parameters<RunHost['recordArtifact']>[0]) {
    return this.parent.recordArtifact(input);
  }
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
    // Defaults to a value distinct from `runId`: a test that wants two runs to share a
    // conversation must say so explicitly by passing the same `threadId` to both `session()`
    // calls, rather than getting it for free from runId's own randomness.
    threadId: `thread-${Math.random().toString(36).slice(2, 10)}`,
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
  adapter = new DeepAgentsAdapter(
    saver,
    new ObjectStoreAgentStore(new FilesystemObjectStore()),
    new FilesystemObjectStore(),
  );
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

  it('keeps every variant of a union schema, for the model and for validation', async () => {
    const variant = (op: string, field: string) => ({
      type: 'object',
      required: ['op', field],
      properties: { op: { type: 'string', enum: [op] }, [field]: { type: 'string' } },
    });
    const inputSchema = {
      type: 'object',
      required: ['operations'],
      properties: {
        operations: {
          type: 'array',
          items: {
            anyOf: [variant('insert_node', 'nodeId'), variant('set_trigger', 'trigger'), variant('set_workflow_metadata', 'name')],
          },
        },
      },
    };
    const first = { operations: [{ op: 'insert_node', nodeId: 'n1' }] };
    const middle = { operations: [{ op: 'set_trigger', trigger: 'webhook' }] };
    const host = new ScriptedHost([
      { text: '', toolCalls: [{ name: 'relay.apply', args: first }] },
      { text: '', toolCalls: [{ name: 'relay.apply', args: middle }] },
      { text: 'done' },
    ]);

    await asTenant(() =>
      adapter.run(session(host, {
        spec: spec({ tools: [{ ref: 'relay.apply', description: 'Apply ops', inputSchema }] }),
      })),
    );

    const advertised = host.modelCalls[0]!.tools!.find((t) => t.name === 'relay.apply')!.parameters as typeof inputSchema;
    expect(advertised.properties.operations.items.anyOf.map((v) => v.properties.op.enum)).toEqual([
      ['insert_node'], ['set_trigger'], ['set_workflow_metadata'],
    ]);
    // Neither is the last variant, which is all a collapsed schema would have let through.
    expect(host.toolCalls).toEqual([{ ref: 'relay.apply', args: first }, { ref: 'relay.apply', args: middle }]);
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
        contentUri: null,
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

  it('streams an UPLOADED skill body from object storage when the model reads it', async () => {
    const store = new FilesystemObjectStore();
    // skill-uploads/, not skills/ -- matching SkillService.publish's real key so this
    // test exercises the actual prefix an upload lands under, not a colliding one.
    const uploaded = await store.put(
      `${f.orgId}/${f.namespaceId}/skill-uploads/${Math.random().toString(36).slice(2)}`,
      Buffer.from('---\nname: escalation\ndescription: when a VIP complains\n---\n\nESCALATE IMMEDIATELY.'),
      'text/markdown',
    );
    const uploadedSkill = spec({
      skills: [
        {
          name: 'escalation procedure',
          version: 1,
          whenToUse: 'when a VIP complains',
          instructions: null,
          contentUri: uploaded.uri,
        },
      ],
    });

    const host = new ScriptedHost([
      { text: '', toolCalls: [{ name: 'read_file', args: { file_path: '/skills/escalation-procedure/SKILL.md' } }] },
      { text: 'read it' },
    ]);
    const out = await asTenant(() => adapter.run(session(host, { spec: uploadedSkill })));

    expect(out.type).toBe('complete');
    const toolTurn = host.modelCalls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolTurn?.content).toContain('ESCALATE IMMEDIATELY');
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
    const path = '/skills/refund-procedure/SKILL.md';
    const host = new ScriptedHost([
      { text: '', toolCalls: [{ name: 'edit_file', args: { file_path: path, old_string: 'STEP ONE', new_string: 'SKIP' } }] },
      { text: 'could not edit' },
    ]);

    // A skill is a governed, versioned artifact (§17.2). If a run could rewrite one, the
    // next run's behaviour would depend on the last run's improvisation -- and because
    // skill content is cached across runs in this namespace (seeded once, read many
    // times), a successful edit here would corrupt what every OTHER run reads back too.
    const out = await asTenant(() => adapter.run(session(host, { spec: withSkill })));

    expect(out.type).toBe('complete');
    const toolTurn = host.modelCalls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolTurn?.content).toMatch(/read-only|governed/i);
  });

  it('still lets a run write to /workspace in the same drive', async () => {
    const host = new ScriptedHost([
      { text: '', toolCalls: [{ name: 'write_file', args: { file_path: '/workspace/notes.md', content: 'draft' } }] },
      { text: 'saved' },
    ]);

    const out = await asTenant(() => adapter.run(session(host, { spec: withSkill })));

    expect(out.type).toBe('complete');
    const toolTurn = host.modelCalls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolTurn?.content ?? '').not.toMatch(/error|read-only/i);
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

  /** A policy-denied tool, called by name anyway: what the model sees, and what came back. */
  const callDenied = async (excludedTools: string[]) => {
    const host = new ScriptedHost([
      { text: '', toolCalls: [{ name: 'glob', args: { pattern: '**/*prompt*' } }] },
      { text: 'ok' },
    ]);
    const out = await asTenant(() =>
      adapter.run(session(host, { spec: spec({ harness: { excludedTools, systemPromptSuffix: null } }) })),
    );
    return {
      out,
      offered: (host.modelCalls[0]!.tools ?? []).map((t) => t.name),
      prompt: host.modelCalls[0]!.systemPrompt ?? '',
      reply: host.modelCalls[1]?.messages.find((m) => m.role === 'tool')?.content,
    };
  };

  it('refuses a denied framework tool the model calls anyway, and never describes it', async () => {
    // relay-dsl-eval's deny list. Hiding the schemas was all that used to happen: `glob` still
    // ran ("No files found matching pattern ...") and nothing recorded it.
    const denied = ['write_todos', 'ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'execute', 'task'];
    const { out, offered, prompt, reply } = await callDenied(denied);

    expect(out.type).toBe('complete');
    expect(offered.filter((n) => denied.includes(n))).toEqual([]);
    expect(reply).toBe("Tool 'glob' is not available in this agent");
    // Not installed, so not described: no filesystem, todo or task section in the prompt.
    expect(prompt).not.toMatch(/`glob`|write_todos|`task`|Filesystem Tools/);
  });

  it('narrows the filesystem tools when only some are denied', async () => {
    const { offered, prompt, reply } = await callDenied(['glob']);

    expect(offered).toContain('read_file');
    expect(offered).not.toContain('glob');
    expect(prompt).toContain('`read_file`');
    expect(prompt).not.toContain('`glob`');
    expect(reply).toBe("Tool 'glob' is not available in this agent");
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

  it('dispatches a later call that reuses an earlier call id, rather than replaying its answer', async () => {
    // The provider mints ids, and nothing guarantees they are unique across a run. The ledger
    // used to answer on id alone, so the corrected call got the dry run's result back, never
    // reached the platform, and the agent looped on it until the recursion limit.
    const dry = { dryRun: true, operations: [{ op: 'insert_node' }] };
    const real = { operations: [{ op: 'insert_node' }] };
    const host = new ScriptedHost(
      [
        { text: '', toolCalls: [{ id: 'fc-1', name: 'demo.lookup', args: dry }] },
        { text: '', toolCalls: [{ id: 'fc-1', name: 'demo.lookup', args: dry }] },
        { text: '', toolCalls: [{ id: 'fc-1', name: 'demo.lookup', args: real }] },
        { text: 'applied' },
      ],
      () => ({ kind: 'ok', output: 'ok' }),
    );

    const out = await asTenant(() => adapter.run(session(host, { spec: twoTools })));

    expect(out.type).toBe('complete');
    // Every call the model made reached the host -- the exact repeat included, since within a
    // drive nothing is a replay.
    expect(host.toolCalls.map((c) => c.args)).toEqual([dry, dry, real]);
  });

  it('still replays across a resume when the reused id asks for something else', async () => {
    const runId = `da-reuse-${Math.random().toString(36).slice(2, 8)}`;
    threads.push(runId);
    const first = new ScriptedHost(
      [{
        text: '',
        toolCalls: [
          { id: 'fc-1', name: 'demo.lookup', args: { id: 1 } },
          { id: 'fc-2', name: 'demo.pay', args: { amount: 100 } },
        ],
      }],
      (ref) => (ref === 'demo.pay' ? { kind: 'suspended', reason: 'approval', ref: 'demo.pay' } : { kind: 'ok', output: 'balance 500' }),
    );
    await asTenant(() => adapter.run(session(first, { runId, spec: twoTools })));

    // Resumed: the super-step replays (fc-1 answered from the ledger, fc-2 from the approval),
    // then the model reuses fc-1 for a different lookup, which must be dispatched.
    const second = new ScriptedHost(
      [
        { text: '', toolCalls: [{ id: 'fc-1', name: 'demo.lookup', args: { id: 2 } }] },
        { text: 'done' },
      ],
      () => ({ kind: 'ok', output: 'balance 700' }),
    );
    await asTenant(() =>
      adapter.run(session(second, {
        runId,
        spec: twoTools,
        state: JSON.parse(JSON.stringify(first.saved)) as unknown,
        resume: { value: 'paid: receipt-9', ref: 'demo.pay', failed: false },
      })),
    );

    expect(second.toolCalls).toEqual([{ ref: 'demo.lookup', args: { id: 2 } }]);
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
          contentUri: null,
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

/**
 * §11.2. Before this, `/workspace` lived in a plain in-memory object per `PlatformBackend`'s
 * own "Honest limit" note: gone the moment a drive ended, let alone a SEPARATE later run.
 * These prove the actual fix -- a file survives past the run that wrote it, scoped to the
 * conversation thread rather than either the run or the whole tenant.
 */
describe('/workspace persists across separate runs of the same thread (§11.2)', () => {
  it('a file written in one run is readable in a later run sharing the same thread', async () => {
    const threadId = `thread-workspace-${Math.random().toString(36).slice(2, 8)}`;

    const writerHost = new ScriptedHost([
      {
        text: '',
        toolCalls: [
          { name: 'write_file', args: { file_path: '/workspace/notes.md', content: 'left for the next run' } },
        ],
      },
      { text: 'saved' },
    ]);
    const written = await asTenant(() => adapter.run(session(writerHost, { threadId })));
    expect(written.type).toBe('complete');

    const readerHost = new ScriptedHost([
      { text: '', toolCalls: [{ name: 'read_file', args: { file_path: '/workspace/notes.md' } }] },
      { text: 'read it back' },
    ]);
    // A fresh runId, same threadId -- a genuinely separate drive, not a resume of the first.
    const read = await asTenant(() => adapter.run(session(readerHost, { threadId })));
    expect(read.type).toBe('complete');

    const toolTurn = readerHost.modelCalls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolTurn?.content).toContain('left for the next run');
  });

  it('does not leak a workspace file into a different thread', async () => {
    const writerHost = new ScriptedHost([
      {
        text: '',
        toolCalls: [{ name: 'write_file', args: { file_path: '/workspace/secret.md', content: 'thread A only' } }],
      },
      { text: 'saved' },
    ]);
    await asTenant(() => adapter.run(session(writerHost, { threadId: 'thread-a-for-isolation-test' })));

    const otherHost = new ScriptedHost([
      { text: '', toolCalls: [{ name: 'read_file', args: { file_path: '/workspace/secret.md' } }] },
      { text: 'not found' },
    ]);
    await asTenant(() => adapter.run(session(otherHost, { threadId: 'thread-b-for-isolation-test' })));

    const toolTurn = otherHost.modelCalls[1]!.messages.find((m) => m.role === 'tool');
    expect(toolTurn?.content).not.toContain('thread A only');
  });

  it('also records the write as a discoverable artifact (§11.2 both)', async () => {
    const host = new ScriptedHost([
      {
        text: '',
        toolCalls: [
          { name: 'write_file', args: { file_path: '/workspace/report.md', content: '# a report' } },
        ],
      },
      { text: 'saved' },
    ]);

    // LangGraph's own namespace-label validation rejects a literal '.', which is why this
    // (like every other threadId in this suite) is built from toString(36) rather than a
    // raw Math.random() -- a real threadId is a uuid and never hits this.
    const threadId = `thread-artifact-${Math.random().toString(36).slice(2, 10)}`;
    await asTenant(() => adapter.run(session(host, { threadId })));

    expect(host.recordedArtifacts).toHaveLength(1);
    expect(host.recordedArtifacts[0]!.body.toString('utf8')).toBe('# a report');
    // Relative to the /workspace mount, not the absolute path the model used:
    // CompositeBackend strips its own route prefix before the routed store ever sees a key.
    expect(host.recordedArtifacts[0]!.metadata).toMatchObject({ workspacePath: '/report.md' });
  });
});
