import { Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import { sql } from 'kysely';
import { DB, POOL } from '../../platform/persistence/tokens.js';
import type { Db, Tx } from '../../platform/persistence/database.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import { withTenantConnection } from '../../platform/persistence/tenant-connection.js';
import { runInContext } from '../../platform/context/platform-context.js';
import { Metrics } from '../../platform/observability/metrics.js';
import { newId } from '../../platform/ids.js';
import { EventLog } from '../event-log/event-log.service.js';
import { EventType } from '../event-log/taxonomy.js';
import { QueueService, type Lease } from '../queue/queue.service.js';
import {
  CheckpointService,
  type CheckpointState,
  type PendingAction,
  type PendingDelegation,
  type PendingPeerCall,
} from '../checkpoint/checkpoint.service.js';
import { AgentVersionService, type ResolvedVersion } from '../registry/agent-version.service.js';
import { ModelGateway } from '../model-gateway/model-gateway.service.js';
import { ToolRuntime, type ToolBinding } from '../tool-runtime/tool-runtime.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { MemoryEngine } from '../memory/memory.engine.js';
import { ArtifactService } from '../artifact/artifact.service.js';
import { ContextEngine } from '../context/context.engine.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { PEER_TRANSPORT, type PeerTransport } from '../ports/peer-transport.port.js';
import { AgentService } from '../agent/agent.service.js';
import type { MemoryTier } from '../ports/memory.port.js';
import { IndeterminateSideEffect, LeaseLost } from '../errors/platform.errors.js';
import { BudgetService, type BudgetScope } from '../governance/budget.service.js';
import {
  FRAMEWORK_ADAPTER,
  type FrameworkAdapter,
  type HostModelRequest,
  type HostModelResult,
  type HostToolOutcome,
  type RunHost,
} from '../ports/framework-adapter.port.js';

/**
 * What a step produced, in the platform's own vocabulary.
 *
 * Local rather than exported on the port: since the framework drives the loop, no adapter
 * ever sees one of these. They exist so the resume paths -- which settle a step the
 * framework is no longer waiting inside -- can hand a value back without inventing a
 * shape per call site.
 */
interface Observation {
  kind: 'model_result' | 'tool_result' | 'tool_error' | 'delegation_result' | 'delegation_error' | 'none';
  content?: unknown;
}

/**
 * Raised by the host when the platform has decided this run stops now.
 *
 * Thrown AND paired with an aborted signal, deliberately. A framework's tool node
 * typically converts a thrown error into a message and keeps reasoning, so the throw
 * alone would be absorbed; the signal is what stops the next model call. Whichever the
 * framework honours, `drive()` re-checks `host.stopped` after `run()` returns and fails
 * the run itself -- so ignoring both only wastes the framework's time, never the
 * platform's ceiling.
 */
class RunStopped extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'RunStopped';
  }
}

/**
 * Above this, a step's output goes to the artifact store instead of into the row, the
 * event and every SSE frame that replays it.
 */
const OFFLOAD_THRESHOLD_BYTES = 32 * 1024;

/** §4.6. Enforced at dispatch; the CHECK constraint only covers rows already stored. */
const MAX_DELEGATION_DEPTH = 8;

interface RunRow {
  id: string;
  thread_id: string;
  agent_version_id: string;
  org_id: string;
  namespace_id: string;
  tenant_ref: string;
  status: string;
  started_at: Date | null;
  caller_principal_id: string;
  on_behalf_of_principal_id: string | null;
  authorizing_human_id: string | null;
  input: unknown;
  delivery: unknown;
  parent_run_id: string | null;
  root_run_id: string | null;
  delegation_depth: number;
  delegation_chain: unknown;
  step_count: number;
  cost_micros: string;
  max_cost_micros: string | null;
  trace_id: string | null;
  correlation_id: string | null;
}

@Injectable()
export class RunLoop {
  private readonly log = new Logger(RunLoop.name);
  private readonly adapters: Map<string, FrameworkAdapter>;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(FRAMEWORK_ADAPTER) adapters: FrameworkAdapter[],
    private readonly uow: UnitOfWork,
    private readonly queue: QueueService,
    private readonly events: EventLog,
    private readonly checkpoints: CheckpointService,
    private readonly versions: AgentVersionService,
    private readonly gateway: ModelGateway,
    private readonly tools: ToolRuntime,
    private readonly outbox: OutboxService,
    private readonly memory: MemoryEngine,
    private readonly artifacts: ArtifactService,
    private readonly agents: AgentService,
    private readonly context: ContextEngine,
    private readonly knowledge: KnowledgeService,
    @Inject(PEER_TRANSPORT) private readonly peers: PeerTransport,
    private readonly metrics: Metrics,
    private readonly budgets: BudgetService,
  ) {
    this.adapters = new Map(adapters.map((a) => [a.id, a]));
    metrics.describe('model_call_duration_ms', 'Model call latency by provider');
    metrics.describe('tool_call_duration_ms', 'Tool call latency by tool and origin');
    metrics.describe('run_duration_ms', 'End-to-end run duration');
    metrics.describe('model_tokens', 'Tokens per model call');
  }

  /** Drives one leased run to a suspension point or a terminal state. */
  async execute(lease: Lease): Promise<void> {
    // §5.2 RLS bootstrap, and the same chicken-and-egg ContextMiddleware has: the pin
    // needs an org, and the org is inside the run row we have not read yet. A worker is a
    // platform-internal dispatcher -- it claims whatever the queue hands it, across every
    // tenant -- so the two reads that resolve WHICH tenant run under `bypass`, in their
    // own short-lived pin that is released before the drive begins.
    const bootstrap = await withTenantConnection(this.pool, { bypass: true }, async () => {
      const found = await this.loadRun(lease.runId);
      if (!found) return null;
      return { run: found, version: await this.versions.load(this.db, found.agent_version_id) };
    });
    if (!bootstrap) return;
    const { run, version } = bootstrap;

    const adapter = this.adapters.get(version.framework);
    if (!adapter) {
      // Pinned to the run's own org, not left on bypass: failing a run is a write to that
      // tenant's rows, and it should be subject to the same policy as any other.
      await withTenantConnection(this.pool, { orgId: run.org_id }, () =>
        this.fail(run, version, lease, `No framework adapter "${version.framework}"`),
      );
      return;
    }

    // §5.2 RLS: one connection pinned for the whole drive, scoped to this run's org, so
    // every query the drive issues -- not only the ones already inside an explicit
    // transaction -- is subject to the tenant policy.
    await withTenantConnection(this.pool, { orgId: run.org_id }, () =>
      runInContext(
        {
          orgId: run.org_id,
          namespaceId: run.namespace_id,
          tenantRef: run.tenant_ref,
          callerPrincipalId: run.caller_principal_id,
          onBehalfOfPrincipalId: run.on_behalf_of_principal_id,
          authorizingHumanId: run.authorizing_human_id,
          delegationChain: [],
          traceId: run.trace_id ?? newId(),
          correlationId: run.correlation_id ?? newId(),
          runId: run.id,
          lease: { owner: lease.owner, epoch: lease.epoch },
        },
        async () => {
          try {
            // Before anything else on a resumed run: §4.5's recovery rule. A non-idempotent
            // invocation left `running` by a crash has an unknown outcome, and we neither
            // retry it nor assume it succeeded.
            await this.tools.assertNoIndeterminateInvocations(run.id);
            await this.drive(run, version, adapter, lease);
          } catch (e) {
            if (e instanceof LeaseLost) {
              // Another worker owns this run now. Abandon locally: do not retry, do not
              // roll forward, do not touch the run's rows.
              this.log.warn(`lease lost for run ${run.id}; abandoning`);
              this.metrics.increment('run_lease_lost_total');
              return;
            }
            if (e instanceof IndeterminateSideEffect) {
              await this.fail(run, version, lease, e.message, { code: e.code, ...e.detail });
              return;
            }
            await this.fail(run, version, lease, (e as Error).message);
          }
        },
      ),
    );
  }

  private async drive(
    run: RunRow,
    version: ResolvedVersion,
    adapter: FrameworkAdapter,
    lease: Lease,
  ): Promise<void> {
    const bindings = await this.tools.bindingsFor(version.id);
    const subAgents = await this.subAgentsFor(version);
    const restored = await this.checkpoints.latest(this.db, run.id);

    // Recalled ONCE at run start, not per step. Recall is a network and index round trip;
    // doing it every step would multiply cost by step count for context that rarely
    // changes mid-run.
    const recalled = await this.recall(run, version);
    // Same reasoning as recall: once per run, not per step. A corpus does not change
    // mid-run, so re-searching it every step buys nothing and costs an embed plus an ANN
    // query each time.
    const knowledge = await this.searchKnowledge(run, version);

    await this.transition(
      run, version, lease,
      restored ? EventType.RunResumed : EventType.RunStarted,
      { resumedFromStep: restored?.stepSeq ?? null },
    );

    // A run resumed from a suspension must FINISH the thing it was suspended on before
    // the framework is asked to reason again. Each of these settles the open step and
    // yields the value the framework has been blocked waiting for.
    let resume: { value: unknown; ref: string | null; failed: boolean } | null = null;

    if (restored?.pendingAction) {
      const resolved = await this.resumePendingAction(
        run, version, lease, restored.pendingAction, bindings,
      );
      if (resolved.kind === 'halt') return;
      resume = {
        value: resolved.observation.content,
        ref: restored.pendingAction.toolRef,
        failed: resolved.observation.kind === 'tool_error',
      };
    }

    // §4.6: a resumed parent reconciles children that settled while it was down. The
    // child's outcome is read from its row, so a parent that crashed mid-delegation and a
    // parent that was merely suspended take the same path.
    if (restored?.pendingDelegation) {
      const resolved = await this.resumeDelegation(run, version, lease, restored.pendingDelegation);
      if (resolved.kind === 'halt') return;
      resume = {
        value: resolved.observation.content,
        ref: restored.pendingDelegation.alias,
        failed: resolved.observation.kind === 'delegation_error',
      };
    }

    // A peer task settles the same way, through a different reader. A LOCAL peer's
    // completion re-enqueues this parent exactly as a sub-agent's does; a REMOTE one has
    // nobody in this runtime to do that, so the resume path polls the transport.
    if (restored?.pendingPeerCall) {
      const resolved = await this.resumePeerCall(run, version, lease, restored.pendingPeerCall);
      if (resolved.kind === 'halt') return;
      resume = {
        value: resolved.observation.content,
        ref: restored.pendingPeerCall.alias,
        failed: resolved.observation.kind === 'delegation_error',
      };
    }

    const host = this.makeHost(run, version, lease, bindings, subAgents, restored?.stepSeq ?? 0);

    const outcome = await adapter.run({
      runId: run.id,
      spec: {
        modelRef: version.modelId,
        systemPrompt: version.systemPrompt,
        tools: bindings.map((b) => ({
          ref: b.ref,
          description: b.description,
          inputSchema: b.inputSchema,
        })),
        maxSteps: version.maxSteps,
        recalled,
        skills: version.skills.map((sk) => ({
          name: sk.name,
          version: sk.version,
          whenToUse: sk.whenToUse,
          instructions: sk.instructions,
        })),
        knowledge,
        subAgents: subAgents.map((a) => ({ alias: a.alias, description: a.description })),
        peers: version.peers.map((p) => ({ alias: p.alias, description: null })),
        harness: version.harness,
        responseSchema: version.responseSchema,
        context: { compaction: version.context.compaction, maxChars: version.context.maxChars },
      },
      input: run.input,
      state: restored?.adapterState ?? null,
      resume,
      signal: host.signal,
      host,
    });

    // Checked BEFORE the outcome, and unconditionally. A framework that swallowed the
    // stop -- absorbed the throw into a tool message, ignored the signal, then answered
    // anyway -- must not be able to turn an exceeded budget into a completed run. The
    // platform's ceiling is decided here, not by how gracefully the framework exits.
    if (host.stopped) {
      await this.fail(run, version, lease, host.stopped);
      return;
    }
    if (host.suspended) {
      // The host already wrote the interaction or the child run, moved the run to
      // `waiting` and left the queue. Whatever the framework returned afterwards is
      // stale; returning here is what stops it overwriting a suspension with an answer.
      return;
    }
    if (outcome.type === 'suspended') return;
    if (outcome.type === 'fail') {
      await this.fail(run, version, lease, outcome.message);
      return;
    }
    await this.complete(run, version, lease, outcome.output, host.stepSeq);
  }

  /**
   * Builds the platform's side of the framework boundary for ONE run.
   *
   * Every method here is a step the framework asked for and the platform performed: same
   * transaction, same fencing, same effect contract, same step row and same events the
   * old `advance()` dispatch produced. What moved is who decides the ORDER -- which is the
   * whole of the change, and none of the guarantees.
   */
  private makeHost(
    run: RunRow,
    version: ResolvedVersion,
    lease: Lease,
    bindings: ToolBinding[],
    subAgents: { alias: string; sub_agent_id: string }[],
    fromStep: number,
  ) {
    const controller = new AbortController();
    const host = {
      signal: controller.signal,
      stepSeq: fromStep,
      costMicros: Number(run.cost_micros),
      /** Set once the platform has decided the run must end; the reason it will fail with. */
      stopped: null as string | null,
      /** Set once a step has parked the run in `waiting`; nothing further may be written. */
      suspended: false,
      /**
       * The framework's own opaque state, written into the next checkpoint.
       *
       * Never inspected. §0.3 keeps framework shapes out of the persisted model, and the
       * moment the platform branches on a field in here it has a second framework
       * contract it did not mean to sign.
       */
      frameworkState: null as unknown,

      stop: (reason: string): never => {
        host.stopped ??= reason;
        controller.abort();
        throw new RunStopped(reason);
      },

      /**
       * The checks that used to sit at the top of the drive loop.
       *
       * They did not become weaker by moving: the framework cannot reach a model or a tool
       * except through the two methods below, and both call this first. A framework that
       * loops without doing either spends nothing, which is the only case this no longer
       * catches -- and there is nothing to catch.
       */
      guard: async (): Promise<void> => {
        if (host.stopped) throw new RunStopped(host.stopped);
        if (host.stepSeq >= version.maxSteps) {
          host.stop(`Exceeded maxSteps (${version.maxSteps})`);
        }
        if (version.maxCostMicros !== null && host.costMicros >= Number(version.maxCostMicros)) {
          host.stop(`Exceeded maxCost (${version.maxCostMicros} micros)`);
        }
        // §5.2: the per-version ceiling above is this run's own budget; these are the
        // tenancy levels ABOVE it. Checked every step, not only at admission, because
        // spend a namespace never anticipated can accrue mid-run long after the run was
        // admitted.
        try {
          await this.budgets.checkNotExceeded(run.org_id, this.budgetScopes(run));
        } catch (e) {
          host.stop((e as Error).message);
        }
      },

      /** Runs one step inside its own transaction, fenced, and settles the bookkeeping. */
      step: async <T>(
        fn: (tx: Tx, stepSeq: number) => Promise<{ result: T; costMicros: number; seq: number | null }>,
      ): Promise<T> => {
        await host.guard();
        const stepSeq = host.stepSeq + 1;
        const out = await this.uow.run(async (tx) => {
          // Fencing, in the same transaction as every durable write that follows.
          await this.queue.assertHeld(tx, lease);
          return fn(tx, stepSeq);
        });
        host.stepSeq = stepSeq;
        host.costMicros += out.costMicros;
        // Recorded after the step's own transaction committed: a budget is a governance
        // ceiling (§5.2), not the ledger of record for the spend itself -- `runs.cost_micros`
        // is, and that already committed. Losing this increment to a crash under-counts a
        // ceiling rather than losing money.
        await this.budgets.record(run.org_id, this.budgetScopes(run), out.costMicros);
        if (out.seq !== null) await this.events.notify(this.db, run.id, out.seq);
        return out.result;
      },
    };

    // Assigned onto `host` rather than returned as a second object. `Object.assign` copies
    // PRIMITIVES BY VALUE, so a merged pair would give the caller a frozen snapshot of
    // `stepSeq`, `stopped` and `suspended` taken before the run began -- and the stop check
    // in `drive()` would then read `null` forever, turning an exceeded budget into a
    // completed run. One object, one identity.
    const api: Omit<RunHost, never> = {
      saveState: (state) => {
        host.frameworkState = state;
      },

      callModel: (request: HostModelRequest) =>
        host.step(async (tx, stepSeq) => {
          const r = await this.runModelStep(
            tx, run, version, lease, stepSeq, request, bindings, host.frameworkState,
          );
          return { result: r.result, costMicros: r.costMicros, seq: r.seq };
        }),

      callTool: (toolRef, args) =>
        host.step(async (tx, stepSeq) => {
          const r = await this.runToolStep(
            tx, run, version, lease, stepSeq, { toolRef, args }, bindings, host.frameworkState,
          );
          if (r.kind === 'halt') host.suspended = true;
          return {
            result:
              r.kind === 'halt'
                ? ({ kind: 'suspended', reason: 'approval', ref: toolRef } as HostToolOutcome)
                : r.outcome,
            costMicros: 0,
            seq: r.kind === 'halt' ? null : r.seq,
          };
        }),

      delegate: (alias, input) =>
        host.step(async (tx, stepSeq) => {
          const r = await this.runDelegationStep(
            tx, run, version, lease, stepSeq, { alias, input }, subAgents, host.frameworkState,
          );
          if (r.kind === 'halt') host.suspended = true;
          return {
            result:
              r.kind === 'halt'
                ? ({ kind: 'suspended', reason: 'delegation', ref: alias } as HostToolOutcome)
                : ({ kind: 'error', message: String(r.observation.content) } as HostToolOutcome),
            costMicros: 0,
            seq: r.kind === 'halt' ? null : r.seq,
          };
        }),

      peerCall: (alias, input) =>
        host.step(async (tx, stepSeq) => {
          const r = await this.runPeerCallStep(
            tx, run, version, lease, stepSeq, { alias, input }, host.frameworkState,
          );
          if (r.kind === 'halt') host.suspended = true;
          return {
            result:
              r.kind === 'halt'
                ? ({ kind: 'suspended', reason: 'peer_call', ref: alias } as HostToolOutcome)
                : ({ kind: 'error', message: String(r.observation.content) } as HostToolOutcome),
            costMicros: 0,
            seq: r.kind === 'halt' ? null : r.seq,
          };
        }),
    };

    Object.assign(host, api);
    return host as typeof host & RunHost;
  }

  /**
   * Executes the action a resolved Interaction authorised, or records the refusal.
   *
   * The step row already exists -- it was opened before the gate -- so this settles that
   * row rather than opening a second one for the same call.
   */
  private async resumePendingAction(
    run: RunRow,
    version: ResolvedVersion,
    lease: Lease,
    pending: PendingAction,
    bindings: ToolBinding[],
  ): Promise<{ kind: 'continue'; observation: Observation } | { kind: 'halt' }> {
    const interaction = await this.db
      .selectFrom('interactions')
      .select(['status', 'response'])
      .where('id', '=', pending.interactionId)
      .executeTakeFirst();

    if (!interaction || interaction.status === 'pending') {
      // Nothing to act on yet. Release rather than spin: the responder's answer is what
      // re-enqueues this run.
      await this.uow.run((tx) => this.queue.dequeue(tx, run.id));
      return { kind: 'halt' };
    }

    const approved =
      interaction.status === 'resolved' &&
      (interaction.response as { approved?: boolean } | null)?.approved === true;

    const binding = bindings.find((b) => b.ref === pending.toolRef);
    if (!binding) {
      await this.fail(run, version, lease, `Tool "${pending.toolRef}" is no longer bound`);
      return { kind: 'halt' };
    }

    return this.uow.run(async (tx) => {
      await this.queue.assertHeld(tx, lease);

      if (!approved) {
        await tx
          .updateTable('steps')
          .set({
            status: 'cancelled',
            error: JSON.stringify({ message: 'Approval was not granted' }),
            ended_at: sql`now()`,
          })
          .where('id', '=', pending.stepId)
          .execute();
        const seq = await this.events.append(tx, {
          ...this.envelope(run, version),
          stepId: pending.stepId,
          type: EventType.ToolFailed,
          payload: { toolRef: pending.toolRef, message: 'approval denied' },
        });
        await this.events.notify(this.db, run.id, seq);
        // The refusal is fed back as an observation rather than failing the run: the
        // agent may have another way forward, and a denied approval is a normal outcome.
        return { kind: 'continue' as const, observation: { kind: 'tool_error' as const, content: 'approval denied' } };
      }

      const outcome = await this.tools.execute({
        tx,
        binding,
        stepId: pending.stepId,
        runId: run.id,
        threadId: run.thread_id,
        orgId: run.org_id,
        namespaceId: run.namespace_id,
        tenantRef: run.tenant_ref,
        agentWorkloadId: version.workloadIdentityId,
        onBehalfOf: run.on_behalf_of_principal_id,
        toolArgs: pending.args,
        replaying: false,
        approved: true,
      });

      if (outcome.kind === 'failed') {
        const seq = await this.failStep(tx, run, version, pending.stepId, outcome.error.message);
        await this.events.notify(this.db, run.id, seq);
        return { kind: 'continue' as const, observation: { kind: 'tool_error' as const, content: outcome.error.message } };
      }

      const output = outcome.kind === 'completed' ? outcome.output : null;
      await tx
        .updateTable('steps')
        .set({ status: 'succeeded', output: JSON.stringify({ output }), ended_at: sql`now()` })
        .where('id', '=', pending.stepId)
        .execute();
      const seq = await this.events.append(tx, {
        ...this.envelope(run, version),
        stepId: pending.stepId,
        type: EventType.ToolCompleted,
        payload: { toolRef: binding.ref, output, afterApproval: true },
      });
      await this.events.notify(this.db, run.id, seq);
      return { kind: 'continue' as const, observation: { kind: 'tool_result' as const, content: output } };
    });
  }

  /**
   * §7 context offloading, and §11.2's rule that large content does not belong in Postgres.
   *
   * A step whose output exceeds the threshold is written to the artifact store and the row
   * keeps a reference. Without this a single large tool result -- a repo listing, a page of
   * search hits -- is copied into `steps.output`, into the event payload, and into every
   * SSE frame that replays it.
   *
   * The threshold is a size, not a type: what matters is how much of the run row and the
   * event log one step is allowed to occupy.
   */
  private async offloadIfLarge(
    tx: Tx,
    run: RunRow,
    stepId: string,
    value: unknown,
  ): Promise<{ inline: unknown; artifactId: string | null }> {
    const serialised = JSON.stringify(value ?? null);
    if (serialised.length <= OFFLOAD_THRESHOLD_BYTES) {
      return { inline: value, artifactId: null };
    }
    try {
      const artifact = await this.artifacts.write(
        {
          body: Buffer.from(serialised, 'utf8'),
          mediaType: 'application/json',
          threadId: run.thread_id,
          runId: run.id,
          stepId,
          metadata: { offloadedFrom: 'step.output' },
        },
        tx,
      );
      return {
        // A summary stays inline so a reader of the step, the event or the stream can see
        // WHAT was offloaded without fetching it.
        inline: {
          offloaded: true,
          artifactId: artifact.id,
          sizeBytes: artifact.sizeBytes,
          preview: serialised.slice(0, 512),
        },
        artifactId: artifact.id,
      };
    } catch (e) {
      // Offloading is an optimisation. Failing the step because the object store is
      // unavailable would trade a large row for a lost run.
      this.log.warn(`could not offload step ${stepId}: ${(e as Error).message}`);
      return { inline: value, artifactId: null };
    }
  }

  /** §5.2's Org → Namespace → Tenant hierarchy, in the order a caller should see them fail. */
  private budgetScopes(run: RunRow): BudgetScope[] {
    return [
      { level: 'org', scopeRef: run.org_id },
      { level: 'namespace', scopeRef: run.namespace_id },
      { level: 'tenant', scopeRef: run.tenant_ref },
    ];
  }

  private async recall(run: RunRow, version: ResolvedVersion) {
    if (!version.memory.enabled) return [];
    try {
      const text = typeof run.input === 'string' ? run.input : JSON.stringify(run.input ?? '');
      const hits = await this.memory.recall({
        orgId: run.org_id,
        namespaceId: run.namespace_id,
        tenantRef: run.tenant_ref,
        text,
        tiers: version.memory.tiers as MemoryTier[],
        scopeRef: { threadId: run.thread_id },
        limit: version.memory.recallLimit,
      });
      const assembled = await this.context.assemble(
        hits.map((h) => ({
          tier: h.tier,
          content: h.content,
          provenance: h.provenance,
          trusted: h.trusted,
          score: h.score,
        })),
        { maxChars: version.context.maxChars, reserveForAnswer: version.context.reserveForAnswer },
        { compaction: version.context.compaction, eviction: version.context.eviction },
      );
      if (assembled.droppedCount > 0 || assembled.compacted) {
        // Reported, not silent. §0.5 says the harm of over-eager compaction is invisible
        // without measurement, so the measurement has to exist.
        this.metrics.increment('context_evicted_total', undefined, assembled.droppedCount);
        if (assembled.compacted) this.metrics.increment('context_compacted_total');
      }
      return assembled.recalled;
    } catch (e) {
      // Memory is a compensating mechanism (§0.5), not a dependency. A recall failure
      // degrades the answer; it must not fail a run that would otherwise succeed.
      this.log.warn(`recall failed for run ${run.id}: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Retrieval over the version's collections, direct and skill-borne.
   *
   * Degrades exactly like recall does and for the same reason (§0.5): a knowledge base is
   * a compensating mechanism, so an index that is down should produce a worse answer, not
   * a failed run. The distinction from recall is only in where the text came from -- which
   * is why the result travels in its own field rather than being merged into `recalled`.
   */
  private async searchKnowledge(run: RunRow, version: ResolvedVersion) {
    if (version.knowledge.collectionIds.length === 0) return [];
    try {
      const text = typeof run.input === 'string' ? run.input : JSON.stringify(run.input ?? '');
      const hits = await this.knowledge.search({
        collectionIds: version.knowledge.collectionIds,
        text,
        limit: version.knowledge.recallLimit,
      });
      this.metrics.increment('knowledge_hits_total', undefined, hits.length);
      return hits.map((h) => ({
        collectionId: h.collectionId,
        documentId: h.documentId,
        content: h.content,
        score: h.score,
      }));
    } catch (e) {
      this.log.warn(`knowledge search failed for run ${run.id}: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * §6.3 transcript fidelity, as a write rule.
   *
   * Only a COMPLETED run writes conversational and episodic memory, because only then did
   * the user actually receive something. Writing on every generation is what makes an
   * agent later reference things it never said.
   */
  private async remember(run: RunRow, version: ResolvedVersion, output: Record<string, unknown>): Promise<void> {
    if (!version.memory.enabled) return;
    const ttl = version.memory.retentionSeconds;
    const common = {
      orgId: run.org_id,
      namespaceId: run.namespace_id,
      tenantRef: run.tenant_ref,
      sourceRunId: run.id,
      ttlSeconds: ttl,
    };

    try {
      if (version.memory.tiers.includes('conversational')) {
        const input = typeof run.input === 'string' ? run.input : JSON.stringify(run.input ?? '');
        if (input) {
          await this.memory.store_({
            ...common,
            tier: 'conversational',
            scopeRef: { scope: 'thread', threadId: run.thread_id },
            content: input,
            provenance: 'user_input',
            delivered: true,
          });
        }
        const text = typeof output['text'] === 'string' ? output['text'] : null;
        if (text) {
          await this.memory.store_({
            ...common,
            tier: 'conversational',
            scopeRef: { scope: 'thread', threadId: run.thread_id },
            content: text,
            provenance: 'model_output',
            delivered: true,
          });
        }
      }

      if (version.memory.tiers.includes('episodic')) {
        await this.memory.store_({
          ...common,
          tier: 'episodic',
          scopeRef: { scope: 'thread', threadId: run.thread_id },
          content: typeof output['text'] === 'string' ? output['text'] : JSON.stringify(output),
          structured: { runId: run.id, steps: run.step_count, outcome: 'completed' },
          provenance: 'model_output',
          delivered: true,
          derivedFrom: [{ kind: 'run', id: run.id }],
        });
      }
    } catch (e) {
      this.log.warn(`could not record memory for run ${run.id}: ${(e as Error).message}`);
    }
  }

  /**
   * Bound sub-agents, in the order the SPEC declared them.
   *
   * The binding table has no ordinal, so a plain select returns them in whatever order the
   * planner produces -- which for a pipeline silently reorders the stages. The spec is
   * stored immutably on the version and IS the declaration order, so it is the ordering
   * key rather than anything in the join table.
   */
  private async subAgentsFor(version: ResolvedVersion) {
    const bound = await this.db
      .selectFrom('agent_version_sub_agents as sa')
      .innerJoin('agents as a', 'a.id', 'sa.sub_agent_id')
      // `description` is what the model reads to choose between six sub-agents. It was
      // never selected before because the old adapter had nowhere to put it -- the model
      // saw an alias and nothing else, and picking the right one of six by name alone is
      // exactly the guessing that produces a plausible wrong answer.
      .select(['sa.alias', 'sa.sub_agent_id', 'a.name', 'a.description'])
      .where('sa.agent_version_id', '=', version.id)
      .execute();

    const byAlias = new Map(bound.map((b) => [b.alias, b]));
    const ordered = version.subAgents
      .map((alias) => byAlias.get(alias))
      .filter((b): b is (typeof bound)[number] => b !== undefined);

    // Anything bound but not named in the spec still runs last rather than vanishing --
    // a binding the spec forgot is a bug worth seeing, not one worth hiding.
    const named = new Set(ordered.map((b) => b.alias));
    return [...ordered, ...bound.filter((b) => !named.has(b.alias))];
  }

  /**
   * Spawns a child run and suspends the parent.
   *
   * The child is a separate run with its own lease, checkpoints and retries -- §13.3's
   * sub-agent, not a tool. The parent releases its lease and leaves the queue, so a
   * delegation that takes an hour does not hold a worker slot for an hour.
   */
  private async runDelegationStep(
    tx: Tx,
    run: RunRow,
    version: ResolvedVersion,
    lease: Lease,
    stepSeq: number,
    action: { alias: string; input: unknown },
    subAgents: { alias: string; sub_agent_id: string }[],
    frameworkState: unknown = null,
  ): Promise<{ kind: 'halt' } | { kind: 'continue'; observation: Observation; seq: number }> {
    const step = await this.openStep(tx, run, stepSeq, 'delegation', {
      alias: action.alias,
      input: action.input,
    });

    const target = subAgents.find((a) => a.alias === action.alias);
    if (!target) {
      const seq = await this.failStep(tx, run, version, step.id, `No sub-agent "${action.alias}" is bound`);
      return {
        kind: 'continue',
        observation: { kind: 'delegation_error', content: `unknown sub-agent ${action.alias}` },
        seq,
      };
    }

    // §4.6 depth limit, enforced at DISPATCH. The CHECK constraint only covers what is
    // already stored; without this a cycle would be created one valid row at a time.
    const depth = run.delegation_depth + 1;
    if (depth > MAX_DELEGATION_DEPTH) {
      const seq = await this.failStep(
        tx, run, version, step.id,
        `Delegation depth ${depth} exceeds the limit of ${MAX_DELEGATION_DEPTH}`,
      );
      return {
        kind: 'continue',
        observation: { kind: 'delegation_error', content: 'delegation depth exceeded' },
        seq,
      };
    }

    // Cycle detection: an agent already on this chain must not be re-entered.
    const chain = (run.delegation_chain as { agentId?: string }[] | null) ?? [];
    if (chain.some((hop) => hop.agentId === target.sub_agent_id)) {
      const seq = await this.failStep(
        tx, run, version, step.id,
        `Sub-agent "${action.alias}" is already on this delegation chain`,
      );
      return {
        kind: 'continue',
        observation: { kind: 'delegation_error', content: 'delegation cycle refused' },
        seq,
      };
    }

    // Sub-agent dispatch is routed by deployment too (§15.5), but never shadow-fired:
    // shadowing every hop of a delegation tree would multiply runs combinatorially with
    // depth, for a comparison that belongs at the top-level entry point that chose to
    // route traffic here in the first place.
    const { versionId: childVersionId } = await this.agents.currentVersionId(target.sub_agent_id);

    const child = await tx
      .insertInto('runs')
      .values({
        thread_id: run.thread_id,
        agent_version_id: childVersionId,
        org_id: run.org_id,
        namespace_id: run.namespace_id,
        tenant_ref: run.tenant_ref,
        status: 'queued',
        durability: version.durability,
        initiator: 'sub_agent',
        parent_run_id: run.id,
        root_run_id: run.root_run_id ?? run.id,
        delegation_depth: depth,
        // §0.1: the chain accumulates, so the originating human survives every hop.
        delegation_chain: JSON.stringify([
          ...chain,
          { runId: run.id, agentVersionId: version.id, agentId: target.sub_agent_id },
        ]),
        caller_principal_id: run.caller_principal_id,
        on_behalf_of_principal_id: run.on_behalf_of_principal_id,
        authorizing_human_id: run.authorizing_human_id,
        input: JSON.stringify(action.input ?? null),
        // §13.5: the child spends the ORIGINATING tenant's ceiling, not its own.
        max_cost_micros: run.max_cost_micros,
        trace_id: run.trace_id,
        correlation_id: run.correlation_id,
        causation_id: run.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await this.queue.enqueue(tx, child.id);
    await this.events.append(tx, {
      ...this.envelope(run, version),
      stepId: step.id,
      type: EventType.RunWaiting,
      payload: { reason: 'delegation', alias: action.alias, childRunId: child.id, depth },
    });

    await this.checkpoints.write(tx, {
      runId: run.id,
      stepSeq,
      durability: version.durability,
      state: {
        adapterState: frameworkState,
        lastObservation: null,
        stepSeq,
        pendingDelegation: { stepId: step.id, alias: action.alias, childRunId: child.id },
      },
    });

    await tx.updateTable('runs').set({ status: 'waiting' }).where('id', '=', run.id).execute();
    // The parent leaves the queue: a delegation that takes an hour must not hold a worker.
    await this.queue.dequeue(tx, run.id);

    return { kind: 'halt' };
  }

  /**
   * Calls an A2A peer (§13.4).
   *
   * Structurally the same shape as a delegation -- open a step, dispatch, suspend, leave
   * the queue -- and semantically different in the three ways §13.3 lists: the callee gets
   * its own thread, its failure is contained by default, and it may not be in this
   * runtime. The transport hides only the last of those.
   */
  private async runPeerCallStep(
    tx: Tx,
    run: RunRow,
    version: ResolvedVersion,
    lease: Lease,
    stepSeq: number,
    action: { alias: string; input: unknown },
    frameworkState: unknown = null,
  ): Promise<{ kind: 'halt' } | { kind: 'continue'; observation: Observation; seq: number }> {
    const step = await this.openStep(tx, run, stepSeq, 'peer_call', {
      alias: action.alias,
      input: action.input,
    });

    const bound = version.peers.find((p) => p.alias === action.alias);
    if (!bound) {
      const seq = await this.failStep(tx, run, version, step.id, `No peer "${action.alias}" is bound`);
      return {
        kind: 'continue',
        observation: { kind: 'delegation_error', content: `unknown peer ${action.alias}` },
        seq,
      };
    }

    // §13.5 depth and cycle limits apply ACROSS the boundary too. A peer that calls back
    // into us is the cycle most likely to happen by accident, because neither team can see
    // the other's spec -- so the chain is checked on peer id as well as agent id.
    const depth = run.delegation_depth + 1;
    if (depth > MAX_DELEGATION_DEPTH) {
      const seq = await this.failStep(
        tx, run, version, step.id,
        `Delegation depth ${depth} exceeds the limit of ${MAX_DELEGATION_DEPTH}`,
      );
      return {
        kind: 'continue',
        observation: { kind: 'delegation_error', content: 'delegation depth exceeded' },
        seq,
      };
    }
    const chain = (run.delegation_chain as { peerId?: string }[] | null) ?? [];
    if (chain.some((hop) => hop.peerId === bound.peerId)) {
      const seq = await this.failStep(
        tx, run, version, step.id,
        `Peer "${action.alias}" is already on this delegation chain`,
      );
      return {
        kind: 'continue',
        observation: { kind: 'delegation_error', content: 'peer cycle refused' },
        seq,
      };
    }

    const peer = await tx
      .selectFrom('peers')
      .select(['id', 'name', 'binding', 'local_agent_id', 'endpoint_url', 'timeout_ms', 'failure_mode', 'status'])
      .where('id', '=', bound.peerId)
      .executeTakeFirstOrThrow();

    if (peer.status !== 'active') {
      const seq = await this.failStep(tx, run, version, step.id, `Peer "${peer.name}" is ${peer.status}`);
      return {
        kind: 'continue',
        observation: { kind: 'delegation_error', content: `peer ${peer.name} is ${peer.status}` },
        seq,
      };
    }

    const target = {
      id: peer.id,
      name: peer.name,
      binding: peer.binding,
      localAgentId: peer.local_agent_id,
      endpointUrl: peer.endpoint_url,
      timeoutMs: peer.timeout_ms,
    };

    let task;
    try {
      task = await this.peers.send({
        tx,
        peer: target,
        caller: {
          runId: run.id,
          stepId: step.id,
          orgId: run.org_id,
          namespaceId: run.namespace_id,
          tenantRef: run.tenant_ref,
          traceId: run.trace_id,
          callerPrincipalId: run.caller_principal_id,
          onBehalfOfPrincipalId: run.on_behalf_of_principal_id,
          authorizingHumanId: run.authorizing_human_id,
          maxCostMicros: run.max_cost_micros,
          delegationDepth: run.delegation_depth,
          delegationChain: run.delegation_chain,
        },
        input: action.input,
      });
    } catch (e) {
      // A dispatch that never happened is contained here rather than failing the run: the
      // peer's unavailability is information the caller's reasoning loop can act on, and
      // §13.5 makes containment the default.
      const seq = await this.failStep(tx, run, version, step.id, (e as Error).message);
      return {
        kind: 'continue',
        observation: { kind: 'delegation_error', content: (e as Error).message },
        seq,
      };
    }

    await tx
      .insertInto('peer_tasks')
      .values({
        org_id: run.org_id,
        run_id: run.id,
        step_id: step.id,
        peer_id: peer.id,
        binding: peer.binding,
        child_run_id: peer.binding === 'local' ? task.taskId : null,
        remote_task_id: peer.binding === 'remote' ? task.taskId : null,
        remote_context_id: task.contextId,
        state: task.state,
        last_observed_at: new Date(),
      })
      // One dispatch per step (see the UNIQUE on step_id). A retried step reuses its task
      // rather than minting a second one -- dispatching twice across a boundary we cannot
      // compensate is the §8.3 failure in its least recoverable form.
      .onConflict((oc) => oc.column('step_id').doNothing())
      .execute();

    await this.events.append(tx, {
      ...this.envelope(run, version),
      stepId: step.id,
      type: EventType.PeerTaskCreated,
      payload: {
        alias: action.alias,
        peer: peer.name,
        taskId: task.taskId,
        contextId: task.contextId,
        // Recorded because it is operationally load-bearing during an incident, and
        // because the conformance suite asserts everything ELSE is identical across it.
        binding: peer.binding,
        depth,
      },
    });

    await this.checkpoints.write(tx, {
      runId: run.id,
      stepSeq,
      durability: version.durability,
      state: {
        adapterState: frameworkState,
        lastObservation: null,
        stepSeq,
        pendingPeerCall: {
          stepId: step.id,
          alias: action.alias,
          peerId: peer.id,
          taskId: task.taskId,
        },
      },
    });

    await tx.updateTable('runs').set({ status: 'waiting' }).where('id', '=', run.id).execute();
    await this.queue.dequeue(tx, run.id);
    return { kind: 'halt' };
  }

  /**
   * Reads a peer task's outcome and feeds it back.
   *
   * The one place the two bindings genuinely differ in the run loop: a local task's
   * completion re-enqueues this parent through the same path a sub-agent uses, while a
   * remote task has nobody here to do that, so this asks the transport. Both then take
   * exactly the same containment and observation path below -- which is what makes
   * §13.4's conformance claim testable rather than aspirational.
   */
  private async resumePeerCall(
    run: RunRow,
    version: ResolvedVersion,
    lease: Lease,
    pending: PendingPeerCall,
  ): Promise<{ kind: 'continue'; observation: Observation } | { kind: 'halt' }> {
    const peer = await this.db
      .selectFrom('peers')
      .select(['id', 'name', 'binding', 'local_agent_id', 'endpoint_url', 'timeout_ms', 'failure_mode'])
      .where('id', '=', pending.peerId)
      .executeTakeFirstOrThrow();

    const target = {
      id: peer.id,
      name: peer.name,
      binding: peer.binding,
      localAgentId: peer.local_agent_id,
      endpointUrl: peer.endpoint_url,
      timeoutMs: peer.timeout_ms,
    };

    let task;
    try {
      task = await this.peers.get(target, pending.taskId);
    } catch (e) {
      // An unreadable task is not a settled one. Failing the step here would report a
      // peer's outcome we never observed; the run stays suspended and the next resume
      // asks again.
      this.log.warn(`peer task ${pending.taskId} unreadable: ${(e as Error).message}`);
      await this.uow.run((tx) => this.queue.dequeue(tx, run.id));
      return { kind: 'halt' };
    }

    if (!['completed', 'failed', 'cancelled'].includes(task.state)) {
      await this.uow.run(async (tx) => {
        await tx
          .updateTable('peer_tasks')
          .set({ state: task.state, last_observed_at: new Date() })
          .where('step_id', '=', pending.stepId)
          .execute();
        await this.queue.dequeue(tx, run.id);
      });
      return { kind: 'halt' };
    }

    return this.uow.run(async (tx) => {
      await this.queue.assertHeld(tx, lease);
      const succeeded = task.state === 'completed';

      await tx
        .updateTable('peer_tasks')
        .set({
          state: task.state,
          error: task.error ? JSON.stringify(task.error) : null,
          last_observed_at: new Date(),
        })
        .where('step_id', '=', pending.stepId)
        .execute();

      await tx
        .updateTable('steps')
        .set({
          status: succeeded ? 'succeeded' : 'failed',
          output: JSON.stringify({ taskId: pending.taskId, output: task.output }),
          error: succeeded ? null : JSON.stringify(task.error),
          ended_at: sql`now()`,
          // Computed in the DATABASE from the two stored timestamps, not from Date.now().
          // A peer call spans a suspension that may outlive the process, so the resuming
          // worker has no in-memory start to subtract -- and mixing a Postgres `started_at`
          // with a Node `now` is what produced negative durations before.
          latency_ms: sql<number>`(EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int`,
        })
        .where('id', '=', pending.stepId)
        .execute();

      const seq = await this.events.append(tx, {
        ...this.envelope(run, version),
        stepId: pending.stepId,
        type: succeeded ? EventType.PeerTaskCompleted : EventType.PeerTaskFailed,
        payload: {
          alias: pending.alias,
          peer: peer.name,
          taskId: pending.taskId,
          state: task.state,
        },
      });
      await this.events.notify(this.db, run.id, seq);

      // §13.5: containment is the DEFAULT and propagation is opt-in, per peer. A peer is
      // another team's service, so its failure is normally information to reason about --
      // but a caller whose work is meaningless without it can declare that, and then a
      // peer failure ends this run rather than being swallowed into a plausible answer.
      if (!succeeded && peer.failure_mode === 'propagate') {
        return {
          kind: 'continue' as const,
          observation: {
            kind: 'delegation_error' as const,
            content: { propagated: true, peer: peer.name, error: task.error },
          },
        };
      }

      return {
        kind: 'continue' as const,
        observation: succeeded
          ? { kind: 'delegation_result' as const, content: task.output }
          : { kind: 'delegation_error' as const, content: task.error },
      };
    });
  }

  /** Reads the child's outcome and feeds it back to the parent's adapter. */
  private async resumeDelegation(
    run: RunRow,
    version: ResolvedVersion,
    lease: Lease,
    pending: PendingDelegation,
  ): Promise<{ kind: 'continue'; observation: Observation } | { kind: 'halt' }> {
    const child = await this.db
      .selectFrom('runs')
      .select(['status', 'output', 'error', 'cost_micros'])
      .where('id', '=', pending.childRunId)
      .executeTakeFirst();

    if (!child || !['completed', 'failed', 'cancelled', 'dead_letter'].includes(child.status)) {
      // Still running. Leave the queue rather than spin: the child's completion is what
      // re-enqueues this parent.
      await this.uow.run((tx) => this.queue.dequeue(tx, run.id));
      return { kind: 'halt' };
    }

    return this.uow.run(async (tx) => {
      await this.queue.assertHeld(tx, lease);
      const succeeded = child.status === 'completed';

      await tx
        .updateTable('steps')
        .set({
          status: succeeded ? 'succeeded' : 'failed',
          output: JSON.stringify({ childRunId: pending.childRunId, output: child.output }),
          error: succeeded ? null : JSON.stringify(child.error),
          ended_at: sql`now()`,
        })
        .where('id', '=', pending.stepId)
        .execute();

      // §13.5: failure is CONTAINED by default. A sub-agent shares the caller's trust
      // domain, so its failure is reported to the parent's reasoning loop rather than
      // silently discarded -- but it does not by itself kill the parent.
      const seq = await this.events.append(tx, {
        ...this.envelope(run, version),
        stepId: pending.stepId,
        type: succeeded ? EventType.StepCompleted : EventType.StepFailed,
        payload: { alias: pending.alias, childRunId: pending.childRunId, status: child.status },
      });
      await this.events.notify(this.db, run.id, seq);

      return {
        kind: 'continue' as const,
        observation: succeeded
          ? { kind: 'delegation_result' as const, content: child.output }
          : { kind: 'delegation_error' as const, content: child.error },
      };
    });
  }

  private async runModelStep(
    tx: Tx,
    run: RunRow,
    version: ResolvedVersion,
    lease: Lease,
    stepSeq: number,
    request: HostModelRequest,
    bindings: ToolBinding[] = [],
    frameworkState: unknown = null,
  ): Promise<{ result: HostModelResult; costMicros: number; seq: number }> {
    const startedAt = Date.now();
    // The LAST turn is what the step row records as its input. The full transcript is
    // already reconstructible from the preceding steps, and copying it into every step
    // would make `steps.input` grow quadratically in the length of the run.
    const asked = request.messages[request.messages.length - 1]?.content ?? '';
    const step = await this.openStep(tx, run, stepSeq, 'model_call', {
      prompt: asked,
      turns: request.messages.length,
    });

    const result = await this.gateway.complete({
      tx,
      modelId: version.modelId,
      agentDataClass: version.dataClass,
      request: {
        prompt: asked,
        messages: request.messages,
        systemPrompt: request.systemPrompt ?? version.systemPrompt,
        // Native tool schemas, so the model asks for a tool through the provider's own
        // mechanism rather than by emitting text a parser has to interpret.
        //
        // The framework's own declaration wins when it made one: it knows about tools the
        // platform does not (planning, scratch filesystem), and advertising only the
        // bound set would leave those permanently invisible to the model. Advertising is
        // not authorisation -- `runToolStep` still refuses anything unbound.
        ...(request.tools?.length
          ? { tools: request.tools }
          : bindings.length > 0
            ? {
                tools: bindings.map((b) => ({
                  name: b.ref,
                  description: b.description ?? `Invoke ${b.ref}`,
                  parameters: (b.inputSchema as Record<string, unknown>) ?? { type: 'object' },
                })),
              }
            : {}),
      },
      orgId: run.org_id,
      runId: run.id,
      stepId: step.id,
      workloadIdentityId: version.workloadIdentityId,
      onBehalfOfPrincipalId: run.on_behalf_of_principal_id,
      tenantRef: run.tenant_ref,
      cache: version.cache,
    });

    await tx
      .updateTable('steps')
      .set({
        status: 'succeeded',
        model_id: result.modelId,
        fallback_from_model_id: result.fellBackFromModelId,
        // Which prompt this call actually ran under (§17.2). Recorded per step, not per
        // run: it is what lets an eval or a regression hunt attribute a change in
        // behaviour to a prompt version rather than guessing from timestamps.
        prompt_version_id: version.promptVersionId,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_micros: String(result.costMicros),
        output: JSON.stringify({ text: result.text }),
        ended_at: sql`now()`,
        latency_ms: Date.now() - startedAt,
      })
      .where('id', '=', step.id)
      .execute();

    await this.gateway.recordUsage(tx, {
      orgId: run.org_id,
      namespaceId: run.namespace_id,
      tenantRef: run.tenant_ref,
      agentVersionId: version.id,
      runId: run.id,
      stepId: step.id,
      modelId: result.modelId,
      provider: result.provider,
      result,
    });

    // A run that silently switched models must be diagnosable (§9), so the fallback is
    // its own event rather than a field someone has to know to look for.
    if (result.fellBackFromModelId) {
      await this.events.append(tx, {
        ...this.envelope(run, version),
        stepId: step.id,
        type: EventType.ModelFallback,
        payload: { from: result.fellBackFromModelId, to: result.modelId },
      });
    }

    if (version.cache.modelResponses) {
      // Recorded either way. A consumer must be able to tell a cached turn from a fresh
      // one when reading the log, and §15.1 has both event types for exactly this.
      await this.events.append(tx, {
        ...this.envelope(run, version),
        stepId: step.id,
        type: result.cached ? EventType.CacheHit : EventType.CacheMiss,
        payload: { kind: 'model_response', model: result.provider },
      });
    }

    const seq = await this.events.append(tx, {
      ...this.envelope(run, version),
      stepId: step.id,
      type: EventType.ModelCompleted,
      payload: {
        text: result.text,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
    });

    await this.settleStep(tx, run, version, lease, stepSeq, frameworkState, {
      kind: 'model_result',
      content: result.text,
    }, result.costMicros);

    return {
      result: {
        text: result.text,
        // Tool calls travel WITH the text. A framework reading only the text would see an
        // empty answer and finish, silently dropping the request the model just made.
        toolCalls: (result.toolCalls ?? []).map((c, i) => ({
          // An id is REQUIRED downstream: every vendor pairs a tool result to its request
          // by id, so one synthesised here beats one invented per provider adapter.
          id: c.id ?? `call_${stepSeq}_${i}`,
          name: c.name,
          args: c.args,
        })),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
      costMicros: result.costMicros,
      seq,
    };
  }

  private async runToolStep(
    tx: Tx,
    run: RunRow,
    version: ResolvedVersion,
    lease: Lease,
    stepSeq: number,
    action: { toolRef: string; args: Record<string, unknown> },
    bindings: ToolBinding[],
    frameworkState: unknown = null,
  ): Promise<
    | { kind: 'continue'; outcome: HostToolOutcome; seq: number }
    | { kind: 'halt' }
  > {
    const startedAt = Date.now();
    const binding = bindings.find((b) => b.ref === action.toolRef);
    const step = await this.openStep(tx, run, stepSeq, 'tool_call', {
      toolRef: action.toolRef,
      args: action.args,
    });

    if (!binding) {
      // Not a silent skip. A model told a tool exists must not find it quietly absent,
      // and §17.5 forbids narrowing capability without saying so.
      const seq = await this.failStep(
        tx, run, version, step.id, `Tool "${action.toolRef}" is not bound to this agent version`,
      );
      return {
        kind: 'continue',
        outcome: { kind: 'error', message: `unknown tool ${action.toolRef}` },
        seq,
      };
    }

    await this.events.append(tx, {
      ...this.envelope(run, version),
      stepId: step.id,
      type: EventType.ToolCalled,
      payload: { toolRef: binding.ref, effects: binding.effects },
    });

    const outcome = await this.tools.execute({
      tx,
      binding,
      stepId: step.id,
      runId: run.id,
      threadId: run.thread_id,
      orgId: run.org_id,
      namespaceId: run.namespace_id,
      tenantRef: run.tenant_ref,
      agentWorkloadId: version.workloadIdentityId,
      onBehalfOf: run.on_behalf_of_principal_id,
      toolArgs: action.args,
      replaying: false,
    });

    if (outcome.kind === 'needs_approval') {
      // The run suspends into `waiting` -- the single suspension state §4.1 uses for
      // human interaction, peer delegation and external waits alike.
      await this.suspendForApproval(
        tx, run, version, step.id, binding.ref, stepSeq, action.args, frameworkState,
      );
      await this.queue.dequeue(tx, run.id);
      return { kind: 'halt' };
    }

    if (outcome.kind === 'failed') {
      const seq = await this.failStep(tx, run, version, step.id, outcome.error.message);
      return {
        kind: 'continue',
        outcome: { kind: 'error', message: outcome.error.message },
        seq,
      };
    }

    this.metrics.observe('tool_call_duration_ms', Date.now() - startedAt, {
      tool: binding.ref,
      origin: binding.origin,
    });
    const offloaded = await this.offloadIfLarge(tx, run, step.id, outcome.output);
    await tx
      .updateTable('steps')
      .set({
        status: 'succeeded',
        output: JSON.stringify({ output: offloaded.inline }),
        output_artifact_id: offloaded.artifactId,
        ended_at: sql`now()`,
        latency_ms: Date.now() - startedAt,
      })
      .where('id', '=', step.id)
      .execute();

    // A cache hit still writes the invocation and still emits this event carrying the
    // output. §10: a hit and a miss must produce identical replayable history.
    if (outcome.cached) {
      await this.events.append(tx, {
        ...this.envelope(run, version),
        stepId: step.id,
        type: EventType.CacheHit,
        payload: { toolRef: binding.ref },
      });
    }

    const seq = await this.events.append(tx, {
      ...this.envelope(run, version),
      stepId: step.id,
      type: EventType.ToolCompleted,
      // The event carries the same inline form as the step, so replay reconstructs
      // identical state whether the payload was offloaded or not.
      payload: { toolRef: binding.ref, output: offloaded.inline, cached: outcome.cached },
    });

    await this.settleStep(tx, run, version, lease, stepSeq, frameworkState, {
      kind: 'tool_result',
      content: outcome.output,
    }, 0);

    return { kind: 'continue', outcome: { kind: 'ok', output: outcome.output }, seq };
  }

  private async openStep(
    tx: Tx,
    run: RunRow,
    seq: number,
    kind: 'model_call' | 'tool_call' | 'delegation' | 'peer_call',
    input: Record<string, unknown>,
  ) {
    return tx
      .insertInto('steps')
      .values({
        run_id: run.id,
        seq,
        kind,
        status: 'running',
        org_id: run.org_id,
        namespace_id: run.namespace_id,
        tenant_ref: run.tenant_ref,
        input: JSON.stringify(input),
        started_at: sql`now()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  private async failStep(
    tx: Tx,
    run: RunRow,
    version: ResolvedVersion,
    stepId: string,
    message: string,
  ): Promise<number> {
    await tx
      .updateTable('steps')
      .set({ status: 'failed', error: JSON.stringify({ message }), ended_at: sql`now()` })
      .where('id', '=', stepId)
      .execute();
    return this.events.append(tx, {
      ...this.envelope(run, version),
      stepId,
      type: EventType.ToolFailed,
      payload: { message },
    });
  }

  /** Checkpoint + counters, at every step boundary for `strict` (§4.3). */
  private async settleStep(
    tx: Tx,
    run: RunRow,
    version: ResolvedVersion,
    lease: Lease,
    stepSeq: number,
    frameworkState: unknown,
    observation: Observation,
    costMicros: number,
  ): Promise<void> {
    const state: CheckpointState = {
      adapterState: frameworkState,
      lastObservation: observation.content ?? null,
      stepSeq,
    };
    if (version.durability === 'strict') {
      await this.checkpoints.write(tx, {
        runId: run.id,
        stepSeq,
        durability: version.durability,
        state,
      });
    }
    await tx
      .updateTable('runs')
      .set((eb) => ({
        step_count: stepSeq,
        cost_micros: eb.val(String(Number(run.cost_micros) + costMicros)),
      }))
      .where('id', '=', run.id)
      .execute();
  }

  private async suspendForApproval(
    tx: Tx,
    run: RunRow,
    version: ResolvedVersion,
    stepId: string,
    toolRef: string,
    stepSeq: number,
    toolArgs: Record<string, unknown>,
    frameworkState: unknown,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const chain = (run.delegation_chain as { runId: string; principalId?: string }[] | null) ?? [];

    // §14.3. If a peer needs input, A called B, and a user called A, the request
    // propagates UP THE FULL CHAIN to whoever can answer, carrying the originating user
    // identity. A sub-agent five hops down has no responder of its own -- the person who
    // started the whole thing does.
    const originatingRunId = run.root_run_id ?? chain[0]?.runId ?? run.id;
    const responder =
      run.authorizing_human_id ?? run.on_behalf_of_principal_id ?? null;

    const interaction = await tx
      .insertInto('interactions')
      .values({
        run_id: run.id,
        thread_id: run.thread_id,
        step_id: stepId,
        org_id: run.org_id,
        namespace_id: run.namespace_id,
        tenant_ref: run.tenant_ref,
        kind: 'approval',
        prompt: JSON.stringify({
          toolRef,
          question: `Approve execution of ${toolRef}?`,
          // The asker is named, because at depth 3 "approve this refund" without saying
          // which agent asked is not an answerable question.
          raisedByRunId: run.id,
          delegationDepth: run.delegation_depth,
        }),
        originating_run_id: originatingRunId,
        originating_principal_id: responder,
        delegation_chain: JSON.stringify(chain),
        // Who may answer travels with the interaction, resolved from the top of the chain
        // rather than from the run that happened to raise it (§16.2).
        required_authorization: JSON.stringify(responder ? { principalId: responder } : {}),
        // An expired interaction is a defined run outcome, not a hang (§14.2).
        expires_at: expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await this.checkpoints.write(tx, {
      runId: run.id,
      stepSeq,
      durability: version.durability,
      state: {
        adapterState: frameworkState,
        lastObservation: null,
        stepSeq,
        pendingAction: {
          stepId,
          toolRef,
          args: toolArgs,
          interactionId: interaction.id,
        },
      },
    });

    await tx
      .updateTable('runs')
      .set({ status: 'waiting' })
      .where('id', '=', run.id)
      .execute();

    await this.events.append(tx, {
      ...this.envelope(run, version),
      stepId,
      type: EventType.InteractionCreated,
      payload: { interactionId: interaction.id, kind: 'approval', toolRef, expiresAt },
    });
  }

  private async transition(
    run: RunRow,
    version: ResolvedVersion,
    lease: Lease,
    type: (typeof EventType)[keyof typeof EventType],
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.uow.run(async (tx) => {
      await this.queue.assertHeld(tx, lease);
      await tx
        .updateTable('runs')
        .set({ status: 'running', started_at: sql`now()` })
        .where('id', '=', run.id)
        .execute();
      await this.events.append(tx, { ...this.envelope(run, version), type, payload });
    });
  }

  private async complete(
    run: RunRow,
    version: ResolvedVersion,
    lease: Lease,
    output: Record<string, unknown>,
    stepSeq: number,
  ): Promise<void> {
    const seq = await this.uow.run(async (tx) => {
      await this.queue.assertHeld(tx, lease);
      await tx
        .updateTable('runs')
        .set({ status: 'completed', output: JSON.stringify(output), ended_at: sql`now()`, step_count: stepSeq })
        .where('id', '=', run.id)
        .execute();
      const s = await this.events.append(tx, {
        ...this.envelope(run, version),
        type: EventType.RunCompleted,
        payload: { output },
      });
      await this.queueDelivery(tx, run, 'completed', { output });
      await this.queue.dequeue(tx, run.id);
      return s;
    });
    await this.events.notify(this.db, run.id, seq);
    await this.wakeParent(run);
    // After the terminal transaction: memory is not part of the run's durability
    // contract, and a memory write must never roll back a completed run.
    await this.remember(run, version, output);
    this.metrics.increment('runs_completed_total');
    if (run.started_at) {
      this.metrics.observe('run_duration_ms', Date.now() - new Date(run.started_at).getTime());
    }
  }

  private async fail(
    run: RunRow,
    version: ResolvedVersion,
    lease: Lease,
    message: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const seq = await this.uow.run(async (tx) => {
        await this.queue.assertHeld(tx, lease);
        await tx
          .updateTable('runs')
          .set({ status: 'failed', error: JSON.stringify({ message, ...detail }), ended_at: sql`now()` })
          .where('id', '=', run.id)
          .execute();
        const s = await this.events.append(tx, {
          ...this.envelope(run, version),
          type: EventType.RunFailed,
          payload: { message, ...detail },
        });
        await this.queueDelivery(tx, run, 'failed', { error: { message, ...detail } });
        await tx
          .insertInto('dead_letters')
          .values({
            run_id: run.id,
            reason: message.slice(0, 200),
            error: JSON.stringify({ message, ...detail }),
            attempts: lease.attempts,
            last_worker: lease.owner,
          })
          .execute();
        await this.queue.dequeue(tx, run.id);
        return s;
      });
      await this.events.notify(this.db, run.id, seq);
      await this.wakeParent(run);
      this.metrics.increment('runs_failed_total');
    } catch (e) {
      if (e instanceof LeaseLost) return;
      this.log.error(`could not record failure for run ${run.id}: ${(e as Error).message}`);
    }
  }

  /**
   * Written inside the terminal transaction, not after it. A crash between "the run
   * completed" and "the caller was told" is what the outbox exists to make impossible.
   */
  private async queueDelivery(
    tx: Tx,
    run: RunRow,
    status: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const delivery = run.delivery as { webhookUrl?: string } | null;
    if (!delivery?.webhookUrl) return;
    await this.outbox.enqueue(tx, {
      runId: run.id,
      destination: delivery.webhookUrl,
      idempotencyKey: `run:${run.id}:${status}`,
      payload: { runId: run.id, threadId: run.thread_id, status, ...body },
    });
  }

  /**
   * Returns a suspended parent to the queue once its child settles.
   *
   * Without this the parent waits for its own resume to be triggered by something else --
   * which for a delegation is nothing. §4.6 requires a resumed parent to reconcile
   * children that finished while it was down; this is the live half of the same rule.
   */
  async wakeParent(run: Pick<RunRow, 'id' | 'parent_run_id'>): Promise<void> {
    if (!run.parent_run_id) return;
    try {
      const parentId = run.parent_run_id;
      await this.uow.run(async (tx) => {
        const woken = await tx
          .updateTable('runs')
          .set({ status: 'queued' })
          .where('id', '=', parentId)
          .where('status', '=', 'waiting')
          .returning('id')
          .executeTakeFirst();
        // Only enqueue if this update actually moved it: two children settling at once
        // must not enqueue the parent twice.
        if (woken) await this.queue.enqueue(tx, parentId, { priority: 50 });
      });
      await this.queue.notifyReady(this.db, parentId);
    } catch (e) {
      this.log.error(`could not wake parent of ${run.id}: ${(e as Error).message}`);
    }
  }

  private envelope(run: RunRow, version: ResolvedVersion) {
    return {
      runId: run.id,
      threadId: run.thread_id,
      agentVersionId: version.id,
      orgId: run.org_id,
      namespaceId: run.namespace_id,
      tenantRef: run.tenant_ref,
    };
  }

  private async loadRun(runId: string): Promise<RunRow | null> {
    const row = await this.db
      .selectFrom('runs')
      .select([
        'id', 'thread_id', 'agent_version_id', 'org_id', 'namespace_id', 'tenant_ref',
        'status', 'started_at', 'caller_principal_id', 'on_behalf_of_principal_id', 'authorizing_human_id',
        'input', 'delivery', 'step_count', 'cost_micros', 'max_cost_micros',
        'trace_id', 'correlation_id', 'parent_run_id', 'root_run_id',
        'delegation_depth', 'delegation_chain',
      ])
      .where('id', '=', runId)
      .executeTakeFirst();
    return (row as RunRow | undefined) ?? null;
  }
}
