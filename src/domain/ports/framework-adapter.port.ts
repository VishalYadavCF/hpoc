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
}

/** What the previous step produced, fed back so the adapter can decide the next one. */
export interface Observation {
  kind: 'model_result' | 'tool_result' | 'tool_error' | 'delegation_result' | 'delegation_error' | 'none';
  content?: unknown;
}

export interface AdvanceInput {
  runId: string;
  spec: AgentSpecView;
  input: unknown;
  stepSeq: number;
  /** Adapter-owned, opaque to the platform, round-tripped through the checkpoint. */
  state: unknown;
  observation: Observation;
}

export type NextAction =
  | { type: 'model_call'; prompt: string; systemPrompt?: string | null }
  | { type: 'tool_call'; toolRef: string; args: Record<string, unknown> }
  /**
   * Delegate to a sub-agent. The child is a SEPARATE RUN with its own lifecycle,
   * checkpoints and retries; the parent suspends into `waiting` until it settles.
   *
   * Not a tool call: §13.3 makes a sub-agent share the caller's trust domain and fail the
   * parent, while a tool is an effect with a contract. Collapsing them would lose the
   * distinction the whole delegation section rests on.
   */
  | { type: 'delegate'; alias: string; input: unknown }
  /**
   * Call an A2A peer. A separate run in a separate trust domain (§13.3, §13.4).
   *
   * Distinct from `delegate` because the two differ in every column of §13.3's table: a
   * peer gets its own thread rather than sharing the caller's context, its failure is
   * CONTAINED by default rather than failing the parent, and it may not be in this
   * runtime at all. Collapsing them into one action would force the platform to guess
   * which set of semantics the adapter meant.
   */
  | { type: 'peer_call'; alias: string; input: unknown }
  | { type: 'complete'; output: Record<string, unknown> }
  | { type: 'fail'; message: string };

export interface AdvanceOutput {
  action: NextAction;
  /** Persisted in the next checkpoint, handed back on the following advance(). */
  state: unknown;
}

/**
 * The framework boundary (§2.1).
 *
 * `advance()` returns ONE step, never a whole run. That is the central choice here: it
 * is what lets the platform own checkpointing, cancellation, budget enforcement and the
 * event log while the framework owns reasoning. A framework that can only run to
 * completion is wrapped, with its callback stream translated into steps.
 *
 * §0.3 requires a second adapter from the first release. If writing one is hard, the
 * abstraction has already leaked -- so `EchoAdapter` ships alongside this interface, not
 * after it.
 */
export interface FrameworkAdapter {
  readonly id: string;
  advance(input: AdvanceInput): Promise<AdvanceOutput>;
}
