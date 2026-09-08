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
  instructions: string;
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
}

export interface RunSession {
  runId: string;
  spec: AgentSpecView;
  input: unknown;
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
   * The platform cannot enforce it from out here -- it does not know which of the
   * framework's calls were already made. What it CAN do is make the reason unmissable,
   * which is what this comment is for.
   */
  resume: { value: unknown; ref: string | null } | null;
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
