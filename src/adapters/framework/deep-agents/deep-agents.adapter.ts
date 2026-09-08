import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  createDeepAgent,
  createHarnessProfile,
  createMemoryMiddleware,
  createSkillsMiddleware,
} from 'deepagents';
import { tool } from '@langchain/core/tools';
import { Command, interrupt } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type {
  FrameworkAdapter,
  RunHost,
  RunOutcome,
  RunSession,
} from '../../../domain/ports/framework-adapter.port.js';
import { PostgresCheckpointSaver } from './postgres.checkpoint-saver.js';
import { HostChatModel } from './host-chat-model.js';
import { PlatformBackend } from './platform.backend.js';

/**
 * The real `deepagents` binding.
 *
 * ## What this replaced, and why
 *
 * The previous version of this file was a 244-line message state machine with a regex
 * tool-call parser and a hardcoded 20-call ceiling. It never called `createDeepAgent`.
 * It was written that way to keep the platform in charge of every step -- and the cost of
 * that was reimplementing, worse, the one thing the framework is for. Native tool calling
 * became `TOOL name {json}` parsed out of prose; planning, sub-agents, skills, filesystem
 * and summarization simply did not exist.
 *
 * So the loop moved. `createDeepAgent` reasons; every action with a CONSEQUENCE still goes
 * back through `RunHost`, where the budget check, the lease fence, the effect contract,
 * the step row and the event log all still happen. The platform gave up deciding when the
 * next model call is made, which it never had an opinion about, and kept everything it
 * was actually enforcing.
 *
 * ## Where each guarantee ended up
 *
 * | Guarantee            | Now enforced by                                     |
 * |----------------------|-----------------------------------------------------|
 * | residency, cost, cache, fallback | `HostChatModel` -> `host.callModel`     |
 * | effect contracts, idempotency    | tool wrapper -> `host.callTool`         |
 * | per-step budget, lease fencing   | `RunHost.step` around both              |
 * | maxSteps                         | `recursionLimit` AND the host's counter |
 * | cancellation                     | `session.signal` into `invoke`          |
 * | durability                       | `PostgresCheckpointSaver` (§4.2)        |
 * | suspension (§13.3, §14)          | LangGraph `interrupt()` + `Command`     |
 *
 * ## The one thing that is genuinely different
 *
 * DeepAgents' built-in middleware tools -- planning, the scratch filesystem -- execute
 * inside the graph and never reach `callTool`, so they produce no `steps` row. That is
 * correct for what they are: they mutate the agent's own working state and touch nothing
 * outside the process. Anything that leaves the process is a bound tool and is recorded.
 *
 * ## Two kinds of sub-agent, kept apart on purpose (§13.3)
 *
 * | | `task` (DeepAgents) | `delegate_to_<alias>` (ours) |
 * |---|---|---|
 * | Runs | in this process, this graph | a SEPARATE run |
 * | Lifecycle | none of its own | own checkpoints, retries, status |
 * | Agent version | none — the parent's | its own, with its own policy |
 * | Parent while it works | blocked in-process | suspended to `waiting`, off the queue |
 * | Failure | returns to the parent | contained or fatal per §13.5 |
 * | Costs | on the parent's steps and ledger | on its own, against the origin ceiling |
 *
 * They are not two implementations of one idea. `task` exists to keep a long sub-task out
 * of the main context window; delegation exists to hand work to an agent someone else
 * owns, versions and governs. Collapsing them -- in either direction -- would lose
 * something: as in-process sub-agents, our six-stage pipelines would silently stop having
 * per-stage policies and budgets; as separate runs, a two-second context-isolation
 * helper would cost a queue round trip and a checkpoint.
 *
 * So both are offered, and the model chooses by name. The names make the difference
 * legible: `task` is anonymous, `delegate_to_billing` is not.
 */
@Injectable()
export class DeepAgentsAdapter implements FrameworkAdapter {
  readonly id = 'deep-agents';
  private readonly log = new Logger(DeepAgentsAdapter.name);

  constructor(@Inject(PostgresCheckpointSaver) private readonly checkpointer: PostgresCheckpointSaver) {}

  async run(session: RunSession): Promise<RunOutcome> {
    const { spec, host } = session;

    // See `Resumption` on `settle` below. One slot, consumed by the first replayed call
    // that matches it, so the platform's already-settled work is not done a second time.
    const pending = session.resume ? new ResumeSlot(session.resume) : null;

    // Skills, recalled memory and retrieved knowledge, projected as files the framework's
    // own middleware reads. See `PlatformBackend` for why a filesystem, and for what
    // stays above it.
    const backend = new PlatformBackend(spec);

    // §17.2/§17.3 shaping, computed from the pinned policy and prompt. DeepAgents' own
    // vocabulary for this, built from OUR registries.
    //
    // Not registered through `registerHarnessProfile`: that registry is process-global and
    // keyed by model spec, so two tenants running different policies against the same
    // model would overwrite each other's -- silently, and in whichever order their runs
    // happened to start. The fields are applied at construction instead, which is
    // per-run and therefore per-tenant by construction.
    const profile = createHarnessProfile({
      excludedTools: spec.harness.excludedTools,
      ...(spec.harness.systemPromptSuffix
        ? { systemPromptSuffix: spec.harness.systemPromptSuffix }
        : {}),
    });

    const agent = createDeepAgent({
      model: new HostChatModel(host, [...profile.excludedTools]),
      tools: this.toolsFor(session, pending),
      systemPrompt: {
        base: spec.systemPrompt ?? undefined,
        ...(profile.systemPromptSuffix ? { suffix: profile.systemPromptSuffix } : {}),
      },
      backend,
      middleware: [
        // Progressive disclosure: names and descriptions go in the prompt, bodies are
        // read on demand. This is the behavioural change Phase 4 is for -- the platform
        // no longer concatenates every pinned skill's full text into every turn.
        ...(backend.skillSources().length
          ? [createSkillsMiddleware({ backend, sources: backend.skillSources() })]
          : []),
        // Memory and knowledge DO go in the prompt whole: unlike a skill, a recalled fact
        // is not a procedure the model can decide it does not need -- it cannot know that
        // without reading it, and a fact it never read is a fact it will contradict.
        ...(backend.memorySources().length
          ? [
              createMemoryMiddleware({
                backend,
                sources: backend.memorySources(),
                // Anthropic prompt caching on the memory block. Recalled context is
                // identical across every turn of a run, so paying for it once instead of
                // once per step is free money we were not taking.
                addCacheControl: true,
              }),
            ]
          : []),
      ],
      // §4.2 durability, on our database. This is the whole reason the migration was
      // possible: LangGraph does not care whose Postgres it is.
      checkpointer: this.checkpointer as BaseCheckpointSaver,
      name: `run-${session.runId}`,
    });

    // The graph's thread is the RUN, not the conversation thread. A conversation may span
    // many runs, and resuming graph state across them would replay another run's tool
    // calls into this one's ledger.
    const config = {
      configurable: { thread_id: session.runId },
      signal: session.signal,
      // A second ceiling on top of the host's own counter. This one stops the graph
      // cleanly; the host's stops it even if the framework ignores this. Doubled because
      // a super-step is a model call plus its tool calls, so the graph needs more
      // recursions than the platform counts steps.
      recursionLimit: Math.max(4, spec.maxSteps * 2),
    };

    try {
      // RESUME, NOT REPLAY. `Command` re-enters the graph at the interrupt that suspended
      // it, so the approved tool call finishes and nothing before it runs twice.
      const input = session.resume
        ? new Command({ resume: session.resume.value })
        : { messages: [new HumanMessage(renderInput(session))] };

      const result = (await agent.invoke(input, config)) as {
        messages?: BaseMessage[];
        structuredResponse?: unknown;
        __interrupt__?: unknown;
      };

      if (result.__interrupt__) {
        // The platform already recorded the wait and moved the run to `waiting`; the
        // graph state sits in `langgraph_checkpoints` until it is resumed.
        return { type: 'suspended' };
      }

      const messages = result.messages ?? [];
      const last = messages[messages.length - 1];
      return {
        type: 'complete',
        output: {
          adapter: this.id,
          text: textOf(last),
          ...(result.structuredResponse !== undefined
            ? { structured: result.structuredResponse }
            : {}),
          messageCount: messages.length,
        },
      };
    } catch (e) {
      // An aborted graph is the platform stopping the run, not the framework failing.
      // `drive()` already knows why and will fail the run with the real reason; saying
      // "aborted" here would overwrite "exceeded maxCost" with something useless.
      if (session.signal.aborted) return { type: 'suspended' };
      this.log.warn(`run ${session.runId} failed inside the graph: ${(e as Error).message}`);
      return { type: 'fail', message: (e as Error).message };
    }
  }

  /**
   * Bound tools, plus one handle per sub-agent and peer.
   *
   * Delegation and peer calls are exposed AS TOOLS to the model but are NOT tools to the
   * platform: each starts a separate run with its own lifecycle and suspends this one.
   * That distinction is §13.3's and it survives here because the host has three different
   * methods, not one -- the model picking a name is presentation; what the platform does
   * with it is semantics.
   */
  private toolsFor(session: RunSession, pending: ResumeSlot | null) {
    const { spec, host } = session;

    const bound = spec.tools.map((t) =>
      tool(
        async (args: Record<string, unknown>) =>
          settle(pending, t.ref, () => host.callTool(t.ref, args), `tool ${t.ref}`),
        {
          name: t.ref,
          description: t.description ?? `Invoke ${t.ref}`,
          schema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        },
      ),
    );

    const delegates = spec.subAgents.map((a) =>
      tool(
        async (args: { input?: unknown }) =>
          settle(
            pending,
            a.alias,
            () => host.delegate(a.alias, args.input ?? null),
            `delegation to ${a.alias}`,
          ),
        {
          name: handleName('delegate_to', a.alias),
          description:
            a.description ??
            `Delegate a sub-task to the "${a.alias}" agent and wait for its result.`,
          schema: {
            type: 'object',
            properties: { input: { description: `What "${a.alias}" should do.` } },
            required: ['input'],
          },
        },
      ),
    );

    const peers = spec.peers.map((p) =>
      tool(
        async (args: { input?: unknown }) =>
          settle(
            pending,
            p.alias,
            () => host.peerCall(p.alias, args.input ?? null),
            `peer call to ${p.alias}`,
          ),
        {
          name: handleName('call_peer', p.alias),
          description:
            p.description ?? `Ask the external agent "${p.alias}" and wait for its answer.`,
          schema: {
            type: 'object',
            properties: { input: { description: `What to ask "${p.alias}".` } },
            required: ['input'],
          },
        },
      ),
    );

    return [...bound, ...delegates, ...peers];
  }
}

/**
 * Holds the value a resumed run is carrying, to be claimed once by the call it answers.
 *
 * Single-use and ref-matched. A run suspended on `demo.pay` must not have its receipt
 * handed to `demo.lookup` merely because that one happened to replay first.
 */
class ResumeSlot {
  private taken = false;
  constructor(private readonly resume: { value: unknown; ref: string | null }) {}

  /** True when this call is the one the platform already settled. */
  claims(ref: string): boolean {
    if (this.taken) return false;
    return this.resume.ref === null || this.resume.ref === ref;
  }

  take(): unknown {
    this.taken = true;
    return this.resume.value;
  }
}

/**
 * Turns a host outcome into something the graph can carry on with.
 *
 * ## Suspension
 *
 * `suspended` becomes `interrupt()`, which is a CONTROL SIGNAL rather than an error:
 * LangGraph's tool node re-throws it instead of converting it to a message, the
 * checkpointer persists the graph exactly where it stopped, and the run leaves the queue.
 * That is how a 24-hour approval wait costs nothing while it waits.
 *
 * ## Resumption, and the trap in it
 *
 * LangGraph resumes a task by RE-EXECUTING it from the top, up to the `interrupt()` that
 * suspended it -- so everything before that call runs a second time. Left alone, that
 * means `host.callTool` fires again on resume, and the payment a human just approved is
 * sent twice. It is a quiet failure: both calls succeed, and the duplicate is caused by
 * the approval gate that existed to prevent exactly this.
 *
 * So the resumed value short-circuits the host entirely. The platform already executed
 * the approved call during `resumePendingAction` and handed back what it produced; this
 * returns that, and never reaches `interrupt()` at all.
 *
 * KNOWN LIMIT: if the model requested several tools in one turn and one of them
 * suspended, the others do re-execute on resume, because LangGraph replays the whole
 * super-step. Idempotent tools are deduplicated by their idempotency key (§4.5); a
 * non-idempotent one issued alongside an approval-gated one is not. Narrowing that needs
 * per-call write-ahead records, which is Phase 7's business, not a comment's.
 *
 * ## Failure
 *
 * An `error` becomes ordinary tool output, not a throw: §13.5 contains failure by
 * default, and a failed tool is information the agent can act on.
 */
async function settle(
  pending: ResumeSlot | null,
  ref: string,
  invoke: () => Promise<Awaited<ReturnType<RunHost['callTool']>>>,
  what: string,
): Promise<string> {
  if (pending?.claims(ref)) return render(pending.take());

  const outcome = await invoke();
  if (outcome.kind === 'ok') return render(outcome.output);
  if (outcome.kind === 'error') return `error: ${outcome.message}`;

  return render(interrupt({ reason: outcome.reason, ref: outcome.ref, what }));
}

const render = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value ?? null);

/**
 * A tool name a provider will accept.
 *
 * Every vendor constrains these to `[A-Za-z0-9_-]`, and an alias is author-chosen text.
 * Sanitising here rather than validating at registration keeps a legal alias from being
 * rejected for a reason that has nothing to do with the platform.
 */
function handleName(prefix: string, alias: string): string {
  return `${prefix}_${alias.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64);
}

function renderInput(session: RunSession): string {
  return typeof session.input === 'string' ? session.input : JSON.stringify(session.input ?? '');
}

function textOf(message: BaseMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => (typeof part === 'object' && part && 'text' in part ? String(part.text) : ''))
    .filter(Boolean)
    .join('');
}
