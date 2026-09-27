import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CompositeBackend,
  StoreBackend,
  createDeepAgent,
  createFilesystemMiddleware,
  createHarnessProfile,
  createMemoryMiddleware,
  createSkillsMiddleware,
  createSummarizationMiddleware,
} from 'deepagents';
import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { ToolStrategy, createMiddleware } from 'langchain';
import { Command, interrupt } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type {
  FrameworkAdapter,
  RunHost,
  RunOutcome,
  RunSession,
  SkillHandle,
} from '../../../domain/ports/framework-adapter.port.js';
import type { SubAgent } from 'deepagents';
import { requireContext } from '../../../platform/context/platform-context.js';
import { OBJECT_STORE, type ObjectStore } from '../../../domain/ports/object-store.port.js';
import { PostgresCheckpointSaver } from './postgres.checkpoint-saver.js';
import { ObjectStoreAgentStore } from './object-store-agent-store.js';
import { ArtifactRecordingStore } from './artifact-recording.store.js';
import { ReadOnlyStore } from './read-only.store.js';
import { HostChatModel } from './host-chat-model.js';
import { PlatformBackend, skillDocument, slug } from './platform.backend.js';

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

  constructor(
    @Inject(PostgresCheckpointSaver) private readonly checkpointer: PostgresCheckpointSaver,
    @Inject(ObjectStoreAgentStore) private readonly agentStore: ObjectStoreAgentStore,
    @Inject(OBJECT_STORE) private readonly objectStore: ObjectStore,
  ) {}

  async run(session: RunSession): Promise<RunOutcome> {
    const { spec, host } = session;

    // What earlier drives of this run already settled. See `ReplayLedger` for why a
    // resumed super-step would otherwise repeat calls that had nothing to do with the wait.
    const ledger = new ReplayLedger(session.state, session.resume);

    // Skills, recalled memory and retrieved knowledge, projected as files the framework's
    // own middleware reads. See `PlatformBackend` for why a filesystem, and for what
    // stays above it.
    const backend = new PlatformBackend(spec);

    // `/workspace` is the one path `PlatformBackend` does NOT keep in-memory-only anymore:
    // routed to a MinIO-backed `BaseStore`, namespaced per conversation thread rather than
    // per run, so a scratch file survives both a worker crash mid-drive AND the run that
    // wrote it finishing -- the actual bug this exists to fix (see `PlatformBackend`'s own
    // "Honest limit" note, written when this was still deferred work). `/memory` and
    // `/knowledge` stay on `backend` unchanged below: those are resolved fresh from
    // Postgres every run, so persisting them would be wrong, not merely unnecessary.
    const ctx = requireContext();
    const workspaceStore = new ArtifactRecordingStore(this.agentStore, host);
    const workspaceBackend = new StoreBackend({
      store: workspaceStore,
      namespace: [ctx.orgId, ctx.namespaceId, ctx.tenantRef, 'threads', session.threadId, 'workspace'],
    });

    // `/skills` also routes here, but namespaced per NAMESPACE rather than per thread --
    // skill content is immutable per version and shared by every run in this namespace,
    // not scoped to one conversation. `seedSkills` below keys each one by name@version and
    // skips the write once it is already present, so an already-seeded skill costs one
    // existence check per run rather than a re-upload of unchanged bytes.
    //
    // TWO backends share this namespace, not one: seeding writes through the unwrapped
    // store, and the route the model actually reaches is wrapped in `ReadOnlyStore`. A
    // generic `StoreBackend` has no per-path write guard the way `PlatformBackend`'s old
    // in-memory map did -- without this, `edit_file` on a skill would silently succeed and
    // corrupt the cached body every future run in the namespace reads back (§17.2: a skill
    // is a governed, versioned artifact, and this is the property that made that true when
    // skills lived on an in-memory map with its own `readOnly: Set<string>` guard).
    const skillsNamespace = [ctx.orgId, ctx.namespaceId, 'skills'];
    const skillsSeedBackend = new StoreBackend({ store: this.agentStore, namespace: skillsNamespace });
    await this.seedSkills(spec.skills, skillsSeedBackend);
    const skillsBackend = new StoreBackend({
      store: new ReadOnlyStore(this.agentStore),
      namespace: skillsNamespace,
    });

    // Trailing slash on both route keys, deliberately: `CompositeBackend.getBackendAndKey`
    // strips the registered prefix with a plain `substring`, and a prefix with no trailing
    // slash leaves the `/` before the next segment in the stripped key -- which then gets
    // a SECOND `/` prepended, handing the routed backend `//report.md` for a write to
    // `/workspace/report.md`. Registering `/workspace/`/`/skills/` consumes that slash as
    // part of the prefix instead, so the routed backend sees the single-slash path its own
    // `write`/`read` calls (seedSkills below, StoreBackend's write() for /workspace) agree
    // with. Confirmed both ways against the library directly before choosing this fix.
    const compositeBackend = new CompositeBackend(backend, {
      '/workspace/': workspaceBackend,
      '/skills/': skillsBackend,
    });

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
    const exclusions = excludedToolsMiddleware(profile.excludedTools, compositeBackend);

    const agent = createDeepAgent({
      model: new HostChatModel(host, [...profile.excludedTools]),
      tools: boundTools,
      // Named in-process helpers, reached through the `task` tool. Each gets a fresh
      // context window and its own prompt; all of them share this run's model, ledger,
      // budget and step ceiling, because that is what makes them helpers rather than
      // agents. A registered sub-agent -- own version, own policy, own budget -- is
      // `delegate_to_<alias>` instead, and is a separate run.
      subagents: [
        ...inlineSubAgentsFor(session, backend, boundTools, exclusions),
        ...registeredInlineFor(session, backend, ledger),
      ],
      systemPrompt: {
        base: spec.systemPrompt ?? undefined,
        ...(profile.systemPromptSuffix ? { suffix: profile.systemPromptSuffix } : {}),
      },
      // The composite, not the raw `backend`: `/workspace` and `/skills` both route to
      // MinIO now. `/memory`/`/knowledge` still resolve through `PlatformBackend` directly
      // -- unlike skills, those are never read lazily by a tool call, so there is nothing
      // for a route to intercept, and the memory/summarization middleware below keep using
      // `backend` accordingly.
      backend: compositeBackend,
      middleware: [
        // §17.2 tools.deny, enforced rather than only hidden. See `excludedToolsMiddleware`.
        ...exclusions,
        // Progressive disclosure: names and descriptions go in the prompt, bodies are
        // read on demand -- by the model, via `read_file` through THIS run's composite, not
        // by this middleware fetching them upfront. `backend.skillSources()`/`skillPath()`
        // still answer from `PlatformBackend`'s own (content-free) view of which names are
        // pinned; only the discovery/read backend needs to be the composite, since that is
        // what actually reaches the MinIO-backed `/skills/` route seeded above.
        ...(backend.skillSources().length
          ? [createSkillsMiddleware({ backend: compositeBackend, sources: backend.skillSources() })]
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
      //
      // Prior thread turns (§3) go in front of the input only on a FIRST drive. Any graph
      // state already saved under this run -- a resume, or a re-drive after a crash --
      // holds them from the first drive, and prepending again would double every turn.
      const input = session.resume
        ? new Command({ resume: session.resume.value })
        : {
            messages: [
              ...(await this.priorTurns(session, config)),
              new HumanMessage(renderInput(session)),
            ],
          };

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

  private async priorTurns(
    session: RunSession,
    config: { configurable: { thread_id: string } },
  ): Promise<BaseMessage[]> {
    const history = session.history ?? [];
    if (history.length === 0) return [];
    if (await this.checkpointer.getTuple({ configurable: config.configurable })) return [];
    return history.map((t) =>
      t.role === 'user' ? new HumanMessage(t.content) : new AIMessage(t.content),
    );
  }

  /**
   * Ensures every pinned skill's body is present in the MinIO-backed `/skills` store,
   * keyed by name@slug so it agrees with `PlatformBackend.skillPath`/`skillSources`.
   *
   * Skipped once a skill is already there: content is immutable per version (§17.2), so
   * after the first run anywhere in this namespace ever uses a given version, every later
   * run pays one existence check rather than a re-render or re-upload of unchanged bytes.
   * Legacy (JSON-authored) skills render through `skillDocument`, the same text
   * `PlatformBackend` used to seed directly; an uploaded skill's bytes are fetched once
   * from its `contentUri` and stored as-is -- it is already a complete file.
   */
  private async seedSkills(skills: SkillHandle[], skillsBackend: StoreBackend): Promise<void> {
    await Promise.all(
      skills.map(async (skill) => {
        const path = `/${slug(skill.name)}/SKILL.md`;
        const existing = await skillsBackend.read(path);
        if (!existing.error) return;
        const content =
          skill.contentUri !== null
            ? (await this.objectStore.get(skill.contentUri)).toString('utf8')
            : skillDocument(skill);
        await skillsBackend.write(path, content);
      }),
    );
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
            args,
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

    const delegates = spec.subAgents
      // An `inline` binding is reached through `task`, not through a delegation handle.
      // Offering both would let the model pick a semantics it has no way to reason about,
      // and the two differ in retries, budget and whether a run exists to inspect.
      .filter((a) => a.mode === 'run')
      .map((a) =>
      tool(
        async (args: { input?: unknown }, runtime: { toolCallId?: string }) =>
          settle(
            ledger,
            host,
            a.alias,
            runtime?.toolCallId,
            args,
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
            args,
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
  exclusions: SubAgent['middleware'] = [],
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
      // Nor its middleware: a helper is this agent, under this agent's policy, and would
      // otherwise get DeepAgents' default file and todo tools back.
      ...(exclusions?.length ? { middleware: exclusions } : {}),
    };
  });
}

/**
 * Registered sub-agents bound with `mode: 'inline'`, as DeepAgents sub-agents.
 *
 * This is the opt-in that lets a real, registry-governed agent reason INSIDE its caller's
 * run instead of as a separate one. Everything it uses is its own: its pinned system
 * prompt, its own bound tools, its own model and residency class, its own skills. What it
 * shares is the run — the same lease, step ceiling, cancellation signal and
 * `runs.cost_micros`.
 *
 * The scoped host is what makes that true rather than aspirational. `host.forSubAgent`
 * returns a `RunHost` bound to the child's version, so its model call goes through the
 * child's model and its tool calls resolve against the child's bindings — and every step
 * row it writes carries `agent_version_id`, so the spend is attributable afterwards.
 *
 * ## What `inline` gives up, stated plainly
 *
 * No run row means no retries, no dead-lettering, and nothing an operator can inspect or
 * resume on its own. A failure returns into the caller's reasoning (§13.5 containment)
 * rather than becoming a run someone can go and look at. That is the trade the author
 * makes by writing `mode: 'inline'`, and it is why `run` remains the default.
 */
function registeredInlineFor(
  session: RunSession,
  backend: PlatformBackend,
  ledger: ReplayLedger,
): SubAgent[] {
  const agents: SubAgent[] = [];

  for (const binding of session.spec.subAgents) {
    if (binding.mode !== 'inline' || !binding.inline) continue;

    // A host scoped to the CHILD. Null would mean the platform could not resolve it, and
    // the platform has already downgraded that case to `run`, so this is defensive.
    const childHost = session.host.forSubAgent(binding.alias);
    if (!childHost) continue;

    const child = binding.inline;
    agents.push({
      name: handleName('agent', binding.alias),
      description:
        binding.description ?? `The "${binding.alias}" agent. Hand it a self-contained task.`,
      // The child's OWN prompt, from its own pinned prompt version. Handing it the
      // caller's would be running a different agent under its name.
      systemPrompt: child.systemPrompt ?? `You are the "${binding.alias}" agent.`,
      // The child's OWN model, reached through a host scoped to the child's version -- so
      // the residency gate, cost ledger and cache policy that apply are the child's.
      model: new HostChatModel(childHost),
      // The child's OWN tools, executed through the child's host, so its capability grants
      // apply rather than the caller's. This is the part that would be wrong if the child
      // simply borrowed the caller's tool list.
      tools: child.tools.map((t) =>
        tool(
          async (args: Record<string, unknown>, runtime: { toolCallId?: string }) =>
            settle(
              ledger,
              childHost,
              t.ref,
              runtime?.toolCallId,
              args,
              () => childHost.callTool(t.ref, args),
              `tool ${t.ref} (${binding.alias})`,
            ),
          {
            name: t.ref,
            description: t.description ?? `Invoke ${t.ref}`,
            schema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
          },
        ),
      ) as unknown as StructuredTool[],
      // The child's own pinned skills, under its own prefix. DeepAgents sub-agents do not
      // inherit the parent's, and a child running without the procedures its author
      // pinned to it fails by producing plausible answers.
      ...(child.skills.length
        ? { skills: backend.seedSubAgentSkills(binding.alias, child.skills) }
        : {}),
    });
  }
  return agents;
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
 * ## An id is only a replay when it can be one
 *
 * Model-minted ids are not guaranteed unique across a run -- the provider mints them, not
 * us. Answered on id alone, a reused id got the FIRST call's recorded answer: no dispatch,
 * no tool_call step, and a model re-sending a corrected call (`dryRun: false`) was handed
 * the dry run's result until the recursion limit. So a recorded answer is returned only
 *
 *  - for a call settled on an EARLIER drive: LangGraph re-executes a super-step only on
 *    resume, never within a drive (no retry policy is configured), so a hit on a call
 *    settled during this drive is a reused id, not a replay; and
 *  - when the call asks for the same tool with the same arguments it did then -- a
 *    replayed call comes from the same checkpointed message, so it always does.
 *
 * Anything else is a new call and is dispatched. A snapshot written before `requests`
 * existed is matched on id alone, as it was, so a run suspended across the upgrade
 * resumes exactly as it would have.
 *
 * ## Why not rely on the platform's idempotency key
 *
 * `tool_invocations.idempotency_key` is rendered from `{runId, stepId}` and a replay gets
 * a fresh step, so the key differs and the dedupe does not fire. That mechanism is about
 * retrying ONE step; this is about not re-entering a step that already finished.
 */
class ReplayLedger {
  private readonly settled: Map<string, string>;
  /** What each settled call asked for (`requestKey`), so a reused id is not taken for a replay. */
  private readonly requests: Map<string, string>;
  /** Ids settled on an earlier drive: the only calls a replayed super-step can re-execute. */
  private readonly replayable: ReadonlySet<string>;
  private readonly resume: { value: unknown; ref: string | null } | null;
  private resumeTaken = false;

  constructor(state: unknown, resume: { value: unknown; ref: string | null } | null) {
    const saved = state as { settled?: Record<string, string>; requests?: Record<string, string> } | null;
    this.settled = new Map(Object.entries(saved?.settled ?? {}));
    this.requests = new Map(Object.entries(saved?.requests ?? {}));
    this.replayable = new Set(this.settled.keys());
    this.resume = resume;
  }

  /** What this exact call returned on an earlier drive, if it completed then. */
  recall(callId: string | undefined, ref: string, args: unknown): string | undefined {
    if (!callId || !this.replayable.has(callId)) return undefined;
    const asked = this.requests.get(callId);
    if (asked !== undefined && asked !== requestKey(ref, args)) return undefined;
    return this.settled.get(callId);
  }

  record(callId: string | undefined, ref: string, args: unknown, output: string): string {
    if (callId) {
      this.settled.set(callId, output);
      this.requests.set(callId, requestKey(ref, args));
    }
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
  snapshot(): { settled: Record<string, string>; requests: Record<string, string> } {
    return { settled: Object.fromEntries(this.settled), requests: Object.fromEntries(this.requests) };
  }
}

/** A call's tool and arguments, key-order independent. */
const requestKey = (ref: string, args: unknown): string => `${ref}\u0000${JSON.stringify(sortedKeys(args))}`;

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortedKeys(v)]),
  );
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
  args: unknown,
  invoke: () => Promise<Awaited<ReturnType<RunHost['callTool']>>>,
  what: string,
): Promise<string> {
  // Already done on an earlier drive. Returning the recorded answer is what keeps a
  // replayed super-step from repeating the calls that had nothing to do with the wait.
  const done = ledger.recall(callId, ref, args);
  if (done !== undefined) return done;

  // This is the call the platform suspended on, and it has since settled it. Reaching the
  // host here would execute the approved payment a second time.
  if (ledger.claimsResume(ref)) return ledger.record(callId, ref, args, render(ledger.takeResume()));

  const outcome = await invoke();
  if (outcome.kind === 'ok') return ledger.record(callId, ref, args, render(outcome.output));
  if (outcome.kind === 'error') return ledger.record(callId, ref, args, `error: ${outcome.message}`);

  // Recorded BEFORE interrupting, because `interrupt()` does not return -- it throws a
  // control signal that unwinds the graph. Saving afterwards would save nothing.
  host.saveState(ledger.snapshot());
  return render(interrupt({ reason: outcome.reason, ref: outcome.ref, what }));
}

const render = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value ?? null);

/** DeepAgents' built-in filesystem tools (1.11.1 `FILESYSTEM_TOOL_NAMES`, not exported). */
const FILESYSTEM_TOOLS = ['ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'execute'];

/**
 * §17.2 `tools.deny`, applied to DeepAgents' OWN tools, which never reach `host.callTool`.
 *
 * Hiding a tool's schema from the provider (`HostChatModel.bindTools`) was all this did, and
 * it is not a deny: the middleware stayed installed, its prompt still described the tool,
 * and a model that named it anyway -- `glob`, in a relay-dsl eval whose policy denied it --
 * had it executed, with no step recorded. DeepAgents' own `excludedTools` cannot be used:
 * it is read only from the process-global profile registry (see the harness comment in
 * `run`), and even there it only filters the schemas too.
 *
 * So, per run:
 *
 *  - Middleware whose tools are denied is REPLACED, not wrapped. DeepAgents merges a custom
 *    middleware with a built-in's name into that built-in's slot (`mergeMiddlewareStack`),
 *    in the main agent and in the general-purpose sub-agent alike. The filesystem one is
 *    rebuilt with only the allowed tools, and its prompt lists only those; it cannot be
 *    narrowed without `read_file` (the library throws), so when that is denied it goes
 *    entirely -- as do the todo and `task` middleware when their tool is denied. Nothing
 *    denied is installed, and nothing denied is described.
 *  - Whatever is still reachable by name is refused with an explicit tool error, so the
 *    model is told rather than silently served. That covers a future built-in this list
 *    does not know about.
 */
function excludedToolsMiddleware(
  excluded: ReadonlySet<string>,
  backend: CompositeBackend,
): NonNullable<SubAgent['middleware']> {
  if (excluded.size === 0) return [];
  const replaced = [];

  const allowedFs = FILESYSTEM_TOOLS.filter((name) => !excluded.has(name));
  if (allowedFs.length < FILESYSTEM_TOOLS.length) {
    replaced.push(
      allowedFs.includes('read_file')
        ? createFilesystemMiddleware({ backend, tools: allowedFs as never })
        : createMiddleware({ name: 'FilesystemMiddleware' }),
    );
  }
  if (excluded.has('write_todos')) replaced.push(createMiddleware({ name: 'todoListMiddleware' }));
  if (excluded.has('task')) replaced.push(createMiddleware({ name: 'subAgentMiddleware' }));

  const refuse = createMiddleware({
    name: 'hpocExcludedToolsMiddleware',
    wrapModelCall: (request, handler) =>
      handler({ ...request, tools: request.tools.filter((t) => !excluded.has(String(t.name))) }),
    wrapToolCall: (request, handler) => {
      const { name, id } = request.toolCall;
      if (!excluded.has(name)) return handler(request);
      return new ToolMessage({
        content: `Tool '${name}' is not available in this agent`,
        tool_call_id: id ?? '',
        name,
        status: 'error',
      });
    },
  });
  return [...replaced, refuse] as NonNullable<SubAgent['middleware']>;
}

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
