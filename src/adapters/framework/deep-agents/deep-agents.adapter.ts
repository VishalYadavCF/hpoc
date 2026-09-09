import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  createDeepAgent,
  createHarnessProfile,
  createMemoryMiddleware,
  createSkillsMiddleware,
  createSummarizationMiddleware,
} from 'deepagents';
import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { ToolStrategy } from 'langchain';
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
import type { SubAgent } from 'deepagents';
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

    // What earlier drives of this run already settled. See `ReplayLedger` for why a
    // resumed super-step would otherwise repeat calls that had nothing to do with the wait.
    const ledger = new ReplayLedger(session.state, session.resume);

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

    // Concrete `StructuredTool`, not the interface: DeepAgents' SubAgent config wants the
    // class, and `tool()` returns one -- the widening happens only where it is inferred.
    const boundTools = this.toolsFor(session, ledger) as unknown as StructuredTool[];

    const agent = createDeepAgent({
      model: new HostChatModel(host, [...profile.excludedTools]),
      tools: boundTools,
      // Named in-process helpers, reached through the `task` tool. Each gets a fresh
      // context window and its own prompt; all of them share this run's model, ledger,
      // budget and step ceiling, because that is what makes them helpers rather than
      // agents. A registered sub-agent -- own version, own policy, own budget -- is
      // `delegate_to_<alias>` instead, and is a separate run.
      subagents: inlineSubAgentsFor(session, backend, boundTools),
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
        // Transcript compaction (§7). The platform's ContextEngine budgets RECALLED
        // MEMORY and always has; nothing has ever bounded the transcript itself, because
        // under the old adapter the transcript was rebuilt from scratch each step. Now
        // that the framework owns it across a whole run, an agent doing forty tool calls
        // grows its context until the provider refuses the request -- which reads as the
        // agent breaking on exactly the hard tasks it was bought for.
        //
        // Gated on the same `compaction` flag as memory compaction, because §0.5 requires
        // every compensating mechanism to be individually disableable: the harm of
        // over-eager summarisation is invisible unless it can be turned off and measured.
        ...(spec.context.compaction
          ? [
              createSummarizationMiddleware({
                backend,
                // Summarised through the SAME metered model. A summariser reaching a
                // provider directly would be unbilled, unbudgeted reasoning (§9).
                model: new HostChatModel(host),
                trigger: { type: 'fraction', value: 0.8 },
                keep: { type: 'messages', value: 20 },
              }),
            ]
          : []),
      ],
      // §4.2 durability, on our database. This is the whole reason the migration was
      // possible: LangGraph does not care whose Postgres it is.
      // Constrained decoding where the provider supports it, so a malformed answer is
      // unrepresentable rather than merely detected after it was paid for.
      // ToolStrategy rather than ProviderStrategy: it rides the tool-calling path every
      // vendor supports and that `HostChatModel` already forwards, so structured output
      // works on all three providers instead of only the one with a native mode.
      ...(spec.responseSchema
        ? { responseFormat: ToolStrategy.fromSchema(spec.responseSchema) }
        : {}),
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
  private toolsFor(session: RunSession, ledger: ReplayLedger) {
    const { spec, host } = session;

    const bound = spec.tools.map((t) =>
      tool(
        async (args: Record<string, unknown>, runtime: { toolCallId?: string }) =>
          settle(
            ledger,
            host,
            t.ref,
            runtime?.toolCallId,
            () => host.callTool(t.ref, args),
            `tool ${t.ref}`,
          ),
        {
          name: t.ref,
          description: t.description ?? `Invoke ${t.ref}`,
          schema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        },
      ),
    );

    const delegates = spec.subAgents.map((a) =>
      tool(
        async (args: { input?: unknown }, runtime: { toolCallId?: string }) =>
          settle(
            ledger,
            host,
            a.alias,
            runtime?.toolCallId,
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
        async (args: { input?: unknown }, runtime: { toolCallId?: string }) =>
          settle(
            ledger,
            host,
            p.alias,
            runtime?.toolCallId,
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
 * The spec's inline helpers, as DeepAgents sub-agents.
 *
 * Three things are deliberately inherited rather than configurable:
 *
 * - **The model.** A helper is the same agent thinking in a fresh context. Wanting a
 *   different model means wanting a different agent, which is a registered sub-agent with
 *   its own version -- and that runs as a separate run so its own policy and budget apply.
 * - **The host.** Every tool a helper calls is the parent's tool, executed through the
 *   parent's `callTool`, so it lands in the parent's `steps` and `tool_invocations`. A
 *   helper cannot reach anything the parent could not.
 * - **The step ceiling.** Its model calls count against the parent's `maxSteps`, which is
 *   the only reading that makes the ceiling mean anything -- otherwise an agent could buy
 *   unlimited reasoning by spawning helpers.
 *
 * `tools` NARROWS and never grants. A name the parent does not have is dropped here, and
 * would be refused at execution anyway, so the list is about focus rather than authority.
 */
function inlineSubAgentsFor(
  session: RunSession,
  backend: PlatformBackend,
  boundTools: StructuredTool[],
): SubAgent[] {
  return session.spec.inlineSubAgents.map((helper) => {
    const skills = helper.skills
      .map((name) => backend.skillPath(name))
      .filter((path): path is string => path !== undefined);

    return {
      name: helper.name,
      description: helper.description,
      systemPrompt: helper.prompt,
      // Omitting `tools` means "everything the parent has", which is DeepAgents' default.
      // An empty array after filtering is NOT the same thing and is preserved: a helper
      // declared with tools the parent lacks asked for none, and silently handing it all
      // of them would be the opposite of what the author wrote.
      ...(helper.tools === null
        ? {}
        : { tools: boundTools.filter((t) => helper.tools!.includes(t.name)) }),
      // Custom sub-agents do NOT inherit the main agent's skills, so a helper that must
      // follow a pinned procedure has to be handed the path explicitly.
      ...(skills.length ? { skills } : {}),
    };
  });
}

/**
 * What a resumed run already knows, so nothing with an effect is done twice.
 *
 * ## The problem this exists for
 *
 * LangGraph resumes by RE-EXECUTING the interrupted super-step from the top. If the model
 * asked for three tools in one turn and the second suspended for approval, then on resume
 * all three run again -- and the first and third have already happened. Both attempts
 * succeed, the duplicate is invisible, and it was caused by the approval gate that existed
 * to prevent exactly this.
 *
 * ## What it does
 *
 * Every settled call is recorded under its tool-call id -- the id the MODEL minted, which
 * is in the checkpointed graph state and therefore identical on replay. On resume, a
 * recorded call returns its recorded answer instead of reaching the platform at all.
 *
 * The id is the right key rather than name-plus-arguments: an agent that legitimately
 * calls the same tool twice with the same arguments (retry a flaky read, charge two
 * identical line items) has two distinct calls, and merging them would be the same bug
 * pointed the other way.
 *
 * ## Why not rely on the platform's idempotency key
 *
 * `tool_invocations.idempotency_key` is rendered from `{runId, stepId}` and a replay gets
 * a fresh step, so the key differs and the dedupe does not fire. That mechanism is about
 * retrying ONE step; this is about not re-entering a step that already finished.
 */
class ReplayLedger {
  private readonly settled: Map<string, string>;
  private readonly resume: { value: unknown; ref: string | null } | null;
  private resumeTaken = false;

  constructor(state: unknown, resume: { value: unknown; ref: string | null } | null) {
    const saved = (state as { settled?: Record<string, string> } | null)?.settled;
    this.settled = new Map(Object.entries(saved ?? {}));
    this.resume = resume;
  }

  /** What this exact call returned on an earlier drive, if it completed then. */
  recall(callId: string | undefined): string | undefined {
    return callId ? this.settled.get(callId) : undefined;
  }

  record(callId: string | undefined, output: string): string {
    if (callId) this.settled.set(callId, output);
    return output;
  }

  /**
   * True when this call is the one the platform suspended on and has now settled.
   *
   * Matched on ref rather than taken by whoever asks first: a run suspended on `demo.pay`
   * must not have its receipt handed to `demo.lookup` merely because that one replayed
   * sooner.
   */
  claimsResume(ref: string): boolean {
    if (!this.resume || this.resumeTaken) return false;
    return this.resume.ref === null || this.resume.ref === ref;
  }

  takeResume(): unknown {
    this.resumeTaken = true;
    return this.resume?.value;
  }

  /** The opaque snapshot handed to `host.saveState`, checkpointed with the suspension. */
  snapshot(): { settled: Record<string, string> } {
    return { settled: Object.fromEntries(this.settled) };
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
 * ## Resumption
 *
 * LangGraph resumes by RE-EXECUTING the interrupted super-step from the top, so every
 * call in it runs again -- both the one that suspended and the ones beside it. The
 * `ReplayLedger` above is what makes that safe; see its comment for why.
 *
 * ## Failure
 *
 * An `error` becomes ordinary tool output, not a throw: §13.5 contains failure by
 * default, and a failed tool is information the agent can act on.
 */
async function settle(
  ledger: ReplayLedger,
  host: RunHost,
  ref: string,
  callId: string | undefined,
  invoke: () => Promise<Awaited<ReturnType<RunHost['callTool']>>>,
  what: string,
): Promise<string> {
  // Already done on an earlier drive. Returning the recorded answer is what keeps a
  // replayed super-step from repeating the calls that had nothing to do with the wait.
  const done = ledger.recall(callId);
  if (done !== undefined) return done;

  // This is the call the platform suspended on, and it has since settled it. Reaching the
  // host here would execute the approved payment a second time.
  if (ledger.claimsResume(ref)) return ledger.record(callId, render(ledger.takeResume()));

  const outcome = await invoke();
  if (outcome.kind === 'ok') return ledger.record(callId, render(outcome.output));
  if (outcome.kind === 'error') return ledger.record(callId, `error: ${outcome.message}`);

  // Recorded BEFORE interrupting, because `interrupt()` does not return -- it throws a
  // control signal that unwinds the graph. Saving afterwards would save nothing.
  host.saveState(ledger.snapshot());
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
