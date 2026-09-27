export const FRAMEWORK_ADAPTER = Symbol('FrameworkAdapter');

export interface ToolHandle {
  ref: string;
  description: string | null;
  inputSchema: unknown;
}

export interface RecalledMemory {
  tier: string;
  content: string | null;
  /** §6.4: kept at retrieval time so an adapter can weigh hearsay differently. */
  provenance: string;
  trusted: boolean;
  score: number;
}

/**
 * A pinned skill, handed to the adapter whole.
 *
 * `whenToUse` is separate from `instructions` because selection and execution have
 * different budgets: an agent holding twelve skills can afford twelve one-line hints in
 * context but not twelve full bodies, so an adapter that wants to choose before it reads
 * has something cheap to choose on.
 */
export interface SkillHandle {
  name: string;
  version: number;
  whenToUse: string | null;
  /**
   * Exactly one of instructions/contentUri is set (skill_versions_content_source_chk).
   * `instructions` is the JSON-authored body, resolved eagerly like everything else here.
   * `contentUri` is an uploaded body's `ObjectStore` URI, deliberately NOT resolved into
   * this view -- a framework adapter reads it lazily (see `PlatformBackend`'s `/skills`
   * routing), which is the whole reason an upload path exists instead of just being a
   * second way to fill `instructions`.
   */
  instructions: string | null;
  contentUri: string | null;
}

/** A chunk retrieved from an authored corpus, kept distinct from RecalledMemory. */
export interface KnowledgeSnippet {
  collectionId: string;
  documentId: string;
  content: string;
  score: number;
}

export interface SubAgentHandle {
  alias: string;
  description: string | null;
  /**
   * How this sub-agent executes (§13.3).
   *
   * `run` — a SEPARATE run. Own lifecycle, checkpoints, retries, budget ceiling and
   * dead-lettering; the caller suspends to `waiting` until it settles. The default, and
   * the only mode that gives the child everything a run row carries.
   *
   * `inline` — the child reasons INSIDE this run, with its own prompt, model and tools
   * resolved from its own version. Milliseconds instead of a queue round trip, and a
   * fresh context window. It gives up what lives on a run row: retries, dead-lettering,
   * and a run of its own to inspect or resume.
   */
  mode: 'run' | 'inline';
  /**
   * What the child's version resolved to. Present only for `inline`.
   *
   * Resolved by the PLATFORM, not by the framework: the child's system prompt comes from
   * its pinned prompt version, its tools from its own bindings, and its skills from its
   * own pins. A framework given a name and left to invent the rest would be running
   * something the registry never approved.
   */
  inline: InlineAgentView | null;
}

export interface InlineAgentView {
  agentVersionId: string;
  systemPrompt: string | null;
  /** The CHILD's bound tools, which may differ from the caller's in both directions. */
  tools: ToolHandle[];
  /** The child's own pinned skills. */
  skills: SkillHandle[];
}

/**
 * A peer this version may call (§13.4).
 *
 * Deliberately carries no binding. The adapter must not be able to tell whether a peer
 * runs in this process, or its reasoning would encode today's deployment topology — and
 * moving an agent out of the runtime would then change how the caller behaves, which is
 * the bug §13.4 warns is found during a migration at the worst possible moment.
 */
export interface PeerHandle {
  alias: string;
  description: string | null;
}

export interface InlineSubAgentHandle {
  name: string;
  description: string;
  prompt: string;
  /** A subset of the caller's tool refs; null means all of them. Narrows, never grants. */
  tools: string[] | null;
  /** Names of pinned skills this helper should see, out of the caller's own. */
  skills: string[];
}

export interface AgentSpecView {
  modelRef: string;
  systemPrompt: string | null;
  tools: ToolHandle[];
  maxSteps: number;
  /**
   * What memory recall surfaced for this run, or [] when the agent disabled it (§0.5).
   *
   * Passed to the adapter rather than injected into the prompt by the platform: what to
   * do with recalled context is the framework's decision, and a platform that silently
   * prepends it makes the mechanism's benefit impossible to measure.
   */
  recalled: RecalledMemory[];
  /**
   * Pinned skills, in spec order, or [] when the version has none.
   *
   * Passed to the adapter for the same reason `recalled` is: the platform does not
   * prepend them to the prompt itself. A skill's whole claim is that it improves the
   * agent, and §0.5 requires that claim to be measurable -- which it cannot be if the
   * platform injects the text unconditionally and no framework can decline it.
   */
  skills: SkillHandle[];
  /**
   * What knowledge search returned this step, kept SEPARATE from `recalled`.
   *
   * Merging them would erase the distinction the trace needs: "the agent remembered
   * something about this tenant" and "the agent looked something up in the manual" fail
   * in different ways and are fixed in different places.
   */
  knowledge: KnowledgeSnippet[];
  /** Sub-agents this version may delegate to — same namespace only (§13.3). */
  subAgents: SubAgentHandle[];
  /** Peers this version may call — another team, another trust domain (§13.3). */
  peers: PeerHandle[];
  /**
   * In-process helpers: the same agent thinking in a fresh context.
   *
   * Deliberately NOT in `subAgents`. One of those is a registered agent with its own
   * version, model, policy and budget, and it runs as a separate run. One of these has
   * none of that -- it is a prompt and a narrower tool list, sharing the caller's model,
   * ledger and step ceiling, and its whole value is a clean context window.
   *
   * A framework with no notion of in-process helpers ignores these correctly by doing
   * nothing: the work still gets done, just in the main transcript.
   */
  inlineSubAgents: InlineSubAgentHandle[];
  /**
   * How the platform's registries shape the FRAMEWORK's own surface (§17.2, §17.3).
   *
   * Everything above this describes what the platform resolved FOR the framework. This
   * describes limits ON it -- specifically on the tools and prompt scaffolding a framework
   * brings that the platform did not give it. Until frameworks were allowed to bring any,
   * there was nothing here to say.
   *
   * An adapter for a framework with no built-in tools ignores it correctly by doing
   * nothing, which is why it is advice rather than enforcement: the platform still refuses
   * anything unbound at `callTool`, so a framework that ignores an exclusion loses a tool
   * from its prompt, not a boundary from its sandbox.
   */
  harness: HarnessShapingView;
  /**
   * JSON Schema the final answer must satisfy, or null.
   *
   * Advice to the framework, not a validator the platform runs. A framework with a
   * provider-native structured-output mode should use it -- constrained decoding cannot
   * emit malformed JSON in the first place, which is strictly better than parsing and
   * rejecting after the tokens are already paid for.
   */
  responseSchema: Record<string, unknown> | null;
  /**
   * §7 context management, per-agent and individually disableable (§0.5).
   *
   * `compaction` reaches the framework because the framework now owns the transcript --
   * the platform can no longer summarise something it does not hold. Keeping the flag
   * meaningful matters more than where it is honoured: a mechanism that cannot be turned
   * off cannot be shown to help.
   */
  context: { compaction: boolean; maxChars: number };
}

export interface HarnessShapingView {
  /**
   * Framework-provided tool names the pinned policy denies.
   *
   * Not the same list admission enforced. A denied BOUND tool never reaches the run at
   * all -- it is simply not in `tools`. These are the names that matched nothing there,
   * kept because they may match something the framework contributes.
   */
  excludedTools: string[];
  /** Appended after the resolved system prompt, for per-model tuning. */
  systemPromptSuffix: string | null;
}

/** One turn of a conversation as the platform records it, framework-agnostic. */
export interface HostMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on an assistant turn that asked for tools. */
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  /** Present on a tool turn, matching the assistant turn's call id. */
  toolCallId?: string;
  /** Opaque provider state carried back from when this turn was produced. */
  providerMetadata?: Record<string, unknown>;
}

export interface HostModelRequest {
  /**
   * The full transcript, NOT a flattened string.
   *
   * Flattening loses which assistant turn asked for which tool, and every provider then
   * has to re-infer it from prose. That inference is where a correct tool call becomes a
   * hallucinated one, so the structure is carried end to end.
   */
  messages: HostMessage[];
  systemPrompt: string | null;
  /**
   * What the model may ask for on THIS call, when the framework wants to say.
   *
   * Omitted means "the tools bound to this agent version", which is what a framework with
   * no tools of its own wants. A framework that adds its own -- planning, a scratch
   * filesystem, a sub-agent handle -- must declare the full set here, or the model is
   * never told those exist and silently never uses them.
   *
   * Declaring a tool here does NOT grant permission to run it. Execution still goes
   * through `callTool`, which refuses anything not bound to the version (§17.5). The two
   * are separate on purpose: what the model can SEE and what the platform will DO are
   * different questions, and conflating them is how a framework grants itself capability.
   */
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
}

export interface HostModelResult {
  text: string;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  inputTokens: number;
  outputTokens: number;
  /** Opaque provider state the framework must keep on this turn and replay on the next. */
  providerMetadata?: Record<string, unknown>;
}

/**
 * What a tool call produced.
 *
 * `suspended` is not an error. A tool gated on human approval (§14) or a delegation to a
 * separate run (§13.3) cannot answer within this process, so the platform has recorded
 * the wait and the framework must stop -- and later be resumed with the answer.
 */
export type HostToolOutcome =
  | { kind: 'ok'; output: unknown }
  | { kind: 'error'; message: string }
  | { kind: 'suspended'; reason: 'approval' | 'delegation' | 'peer_call'; ref: string };

/**
 * Everything the platform will do on a framework's behalf (§2.1).
 *
 * This is the inversion that makes the migration work. The framework owns the reasoning
 * loop; every action that has a CONSEQUENCE -- spends money, touches a tenant's data,
 * calls another trust domain -- goes back through here, where the budget check, the lease
 * fence, the effect contract, the step row and the event log all still happen. Handing a
 * framework a raw HTTP client instead is what would lose them.
 */
export interface RunHost {
  /** A model call: residency gate, cost ledger, cache, fallback, step row, events (§9). */
  callModel(request: HostModelRequest): Promise<HostModelResult>;
  /** A bound tool: effect contract, idempotency, sandbox, step row, events (§4.5). */
  callTool(toolRef: string, args: Record<string, unknown>): Promise<HostToolOutcome>;
  /**
   * Delegate to a sub-agent (§13.3): a SEPARATE run with its own lifecycle, checkpoints
   * and retries. Always suspends -- the child does not run in this process.
   */
  delegate(alias: string, input: unknown): Promise<HostToolOutcome>;
  /**
   * Call an A2A peer (§13.4): a separate run in a separate trust domain, whose failure is
   * CONTAINED rather than fatal to the caller. Kept distinct from `delegate` because the
   * two differ in every column of §13.3's table.
   */
  peerCall(alias: string, input: unknown): Promise<HostToolOutcome>;
  /**
   * Hand the platform an opaque snapshot of the framework's own state, to be written with
   * the next checkpoint and returned as `RunSession.state` on resume.
   *
   * For a framework that has its own checkpointer this is dead weight -- LangGraph puts
   * its graph state in `langgraph_checkpoints` and resumes from there. It exists for one
   * that does not: without it, such a framework's only way to survive a suspension is to
   * re-execute from the top, and re-executing is exactly what must not happen after an
   * approval gate.
   *
   * Opaque by contract. §0.3 keeps framework shapes out of the persisted model, so the
   * platform stores this and never reads into it.
   */
  saveState(state: unknown): void;
  /**
   * Records agent-authored content as a first-class, API-discoverable artifact --
   * `GET /v1/artifacts`, downloadable, subject to retention and legal hold.
   *
   * Deliberately NOT routed through `callTool`: a `/workspace` file write is not a tool
   * call and, per `PlatformBackend`'s own note, produces no `steps` row -- it happens
   * inside DeepAgents' own filesystem middleware, which never reaches this host at all
   * except through this one narrow door. No budget check, no lease fencing, no effect
   * contract: there is nothing here for those to apply to, the same as `saveState`.
   *
   * Best-effort BY CONTRACT, not by accident: a caller must not let this failing take
   * down the write that already durably succeeded elsewhere. Implementations should not
   * throw for a recording failure; a framework adapter calling this should not treat a
   * rejection as fatal either.
   */
  recordArtifact(input: {
    body: Buffer;
    mediaType: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  /**
   * A host scoped to an `inline` sub-agent, or null when the alias is not one.
   *
   * Everything the returned host does is attributed to the CHILD's version: its model
   * call goes through the child's model with the child's residency class, its tool calls
   * resolve against the child's bindings, and every `steps` row it writes carries
   * `agent_version_id`. Without that last part the child's spend would land on the
   * caller's version and no cost report could tell a stage's regression from its
   * caller's.
   *
   * What it SHARES with the caller is the run: the same lease, the same step ceiling, the
   * same cancellation signal, the same `runs.cost_micros`. An in-process child that could
   * buy its own step budget would make the caller's ceiling meaningless.
   */
  forSubAgent(alias: string): RunHost | null;
}

export interface RunSession {
  runId: string;
  /**
   * The conversation this run belongs to. A conversation may span many runs; this is what
   * lets an adapter give a mechanism (persistent workspace storage, cross-run memory) a
   * lifetime longer than one drive without conflating it with `runId`, which the graph's
   * own `thread_id` (§4.2) is deliberately pinned to instead -- see
   * `DeepAgentsAdapter.run`'s comment on why those two must not be the same value.
   */
  threadId: string;
  spec: AgentSpecView;
  input: unknown;
  /**
   * Earlier DELIVERED turns of this run's thread, oldest first, bounded -- the same
   * projection `GET /v1/threads/:id/messages` returns (§3: a new turn resets execution,
   * not continuity). An adapter places these before `input` as prior user/assistant turns.
   *
   * Empty (or absent) on a resumed or checkpointed run: the framework's restored state
   * already holds them, and replaying them would put every prior turn in twice.
   */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /**
   * Non-null when this run is being resumed after a suspension. Carries the value the
   * framework was waiting for -- an approval decision, a child run's output.
   *
   * ## The rule this imposes, which is the sharpest edge on the whole port
   *
   * `run()` is called AGAIN from the top on a resume. An adapter that simply re-executes
   * its logic will call every tool it already called -- including the non-idempotent one
   * a human just approved. That is a duplicated side effect caused by the platform asking
   * politely, which is the worst kind.
   *
   * So an adapter MUST resume rather than replay. A framework with a checkpointer does
   * this natively (LangGraph: feed this value to `Command({ resume })` and the graph
   * continues at the interrupt, not at the start). A framework without one must branch on
   * this field before doing anything with an effect.
   *
   * `ref` names WHAT was waited on -- the tool ref, sub-agent alias or peer alias -- so an
   * adapter replaying several calls can tell which one this value answers. Null when the
   * platform could not attribute it.
   *
   * `failed` says whether the thing waited on SUCCEEDED. Stated rather than left to be
   * inferred from the payload: an adapter sniffing for an `error` key is guessing, and a
   * child agent whose legitimate output happens to contain that word would be read as a
   * failure. The platform knows the answer; making it say so is one boolean.
   *
   * The platform cannot enforce it from out here -- it does not know which of the
   * framework's calls were already made. What it CAN do is make the reason unmissable,
   * which is what this comment is for.
   */
  resume: { value: unknown; ref: string | null; failed: boolean } | null;
  /** Whatever the last `saveState()` recorded, or null on a fresh run. */
  state: unknown;
  /**
   * Tripped when the platform decides the run must stop NOW: cancelled, out of budget,
   * over maxSteps, or the lease moved to another worker.
   *
   * With the framework driving the loop, this is the only way the platform can interrupt
   * reasoning between steps. An adapter that ignores it will be abandoned mid-flight and
   * its work discarded, so honouring it is not optional.
   */
  signal: AbortSignal;
  host: RunHost;
}

export type RunOutcome =
  | { type: 'complete'; output: Record<string, unknown> }
  | { type: 'fail'; message: string }
  /**
   * The framework stopped at a suspension point the host reported. The platform has
   * already persisted the wait and moved the run to `waiting`; nothing more to do here.
   */
  | { type: 'suspended' };

/**
 * The framework boundary (§2.1).
 *
 * `run()` drives the whole reasoning loop, which is a REVERSAL of this port's first
 * shape. The original `advance()` returned one action at a time so the platform could
 * checkpoint and enforce budgets between steps -- but it also meant reimplementing, badly,
 * the message state machine, tool-call translation and planning that a real framework
 * already has. That reimplementation is what this port now refuses to require.
 *
 * The guarantees did not move out; they moved DOWN, into `RunHost`. Every consequential
 * action still passes through the platform, so the budget check, the lease fence, the
 * effect contract, the step row and the event log all still run -- inside the framework's
 * loop instead of around it. What the platform gave up is deciding WHEN the next model
 * call happens, which was never a thing it had an opinion about.
 *
 * §0.3 still requires a second implementation from the first release, and `EchoAdapter`
 * still ships alongside this interface: a port with one implementation is a guess.
 */
export interface FrameworkAdapter {
  readonly id: string;
  run(session: RunSession): Promise<RunOutcome>;
}
