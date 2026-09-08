import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { QueueService } from '../queue/queue.service.js';
import { AgentService } from '../agent/agent.service.js';
import { PlatformError } from '../errors/platform.errors.js';
import type {
  PeerDispatch,
  PeerTask,
  PeerTransport,
} from '../ports/peer-transport.port.js';
import type { PeerTaskState, RunStatus } from '../../platform/persistence/schema.types.js';

/**
 * Maps run status onto A2A task state.
 *
 * This is the whole of §13.4's "task lifecycle states -> run status" mapping, and it is a
 * pure function rather than a stored column so the two cannot drift. `waiting` becomes
 * `input_required` because that is what waiting means to a caller: something outside this
 * runtime has to happen before it moves.
 */
const TASK_STATE: Record<RunStatus, PeerTaskState> = {
  queued: 'submitted',
  running: 'working',
  tool_execution: 'working',
  checkpointed: 'working',
  waiting: 'input_required',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  // A dead letter is a failure that stopped being retried. Reporting it as anything
  // softer would leave the caller waiting for a task nobody is working on.
  dead_letter: 'failed',
};

/**
 * The local A2A binding (§13.4).
 *
 * Lives in the DOMAIN, not in adapters, and that is not bookkeeping: this is the platform
 * dispatching into its own execution engine, which is domain behaviour. Only the remote
 * binding adapts to something outside, and only it is an adapter. Filing this under
 * adapters is what made it reach back into QueueService and AgentService across a module
 * boundary that does not run in that direction.
 *
 * Dispatches directly into the execution engine as a child run in the SAME event log. No
 * JSON-RPC and no HTTP round trip to ourselves -- a loopback request would add a hop, a
 * serialisation boundary and a second failure mode to a call that never leaves the process.
 *
 * What it does NOT do is share the caller's context. §13.3 makes peer memory isolated and
 * the trust domain separate, so the child gets its OWN thread even though it runs here.
 * Reusing the caller's thread would be the one-line "optimisation" that quietly turns a
 * peer into a sub-agent and makes the local and remote bindings behave differently.
 */
@Injectable()
export class LocalPeerTransport implements PeerTransport {
  readonly binding = 'local' as const;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly queue: QueueService,
    private readonly agents: AgentService,
  ) {}

  async send(dispatch: PeerDispatch): Promise<PeerTask> {
    const { tx, peer, caller } = dispatch;
    if (!peer.localAgentId) {
      throw new PlatformError('not_found', `Peer "${peer.name}" has no local agent bound`);
    }

    const agent = await tx
      .selectFrom('agents')
      .select(['id', 'org_id', 'namespace_id', 'expose_as_peer', 'archived_at'])
      .where('id', '=', peer.localAgentId)
      .executeTakeFirst();
    if (!agent || agent.archived_at !== null) {
      throw new PlatformError('not_found', `Peer "${peer.name}" points at a missing agent`);
    }
    // Exposure is checked on the LOCAL path too, not only at the HTTP edge. Otherwise
    // being in the same process would be a way past a control that a remote caller faces
    // -- and the bindings would stop being semantically identical (§13.4).
    if (!agent.expose_as_peer) {
      throw new PlatformError(
        'capability_denied',
        `Agent behind peer "${peer.name}" is not exposed as a peer`,
        { hint: 'Publish a version with a2a.exposeAsPeer = true' },
      );
    }

    // A local peer call is routed by deployment the same as any other invocation (§15.5);
    // shadow-firing is intentionally not wired for peer dispatch -- see the note on
    // run-loop's sub-agent delegation for why.
    const { versionId } = await this.agents.currentVersionId(agent.id);

    // §13.3: isolated memory. A peer gets its own thread, in its OWN namespace -- the
    // caller's tenancy travels, the caller's conversation does not.
    const contextId =
      dispatch.contextId ??
      (
        await tx
          .insertInto('threads')
          .values({
            org_id: agent.org_id,
            namespace_id: agent.namespace_id,
            tenant_ref: caller.tenantRef,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;

    const chain = (caller.delegationChain as unknown[] | null) ?? [];
    const child = await tx
      .insertInto('runs')
      .values({
        thread_id: contextId,
        agent_version_id: versionId,
        org_id: agent.org_id,
        namespace_id: agent.namespace_id,
        tenant_ref: caller.tenantRef,
        status: 'queued',
        durability: 'strict',
        initiator: 'peer',
        // The parent link is recorded even across the trust boundary: §15.3 lineage has to
        // answer "who asked for this" and a null parent would break the chain at exactly
        // the hop that most needs explaining.
        parent_run_id: caller.runId,
        root_run_id: caller.runId,
        delegation_depth: caller.delegationDepth + 1,
        // §0.1: the originating human survives every hop, peer hops included.
        delegation_chain: JSON.stringify([...chain, { runId: caller.runId, peerId: peer.id }]),
        caller_principal_id: caller.callerPrincipalId,
        on_behalf_of_principal_id: caller.onBehalfOfPrincipalId,
        authorizing_human_id: caller.authorizingHumanId,
        input: JSON.stringify(dispatch.input ?? null),
        // §13.5 budget propagation: the callee spends the ORIGINATING tenant's ceiling.
        max_cost_micros: caller.maxCostMicros,
        trace_id: caller.traceId,
        causation_id: caller.runId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await this.queue.enqueue(tx, child.id);
    return { taskId: child.id, contextId, state: 'submitted', output: null, error: null };
  }

  async get(_peer: PeerDispatch['peer'], taskId: string): Promise<PeerTask> {
    const run = await this.db
      .selectFrom('runs')
      .select(['id', 'thread_id', 'status', 'output', 'error'])
      .where('id', '=', taskId)
      .executeTakeFirst();
    if (!run) throw new PlatformError('not_found', `Task ${taskId} not found`);

    return {
      taskId: run.id,
      contextId: run.thread_id,
      state: TASK_STATE[run.status],
      output: run.output,
      error: run.error ? normaliseError(run.error) : null,
    };
  }

  /**
   * §13.5 cancellation propagation.
   *
   * Terminal runs are left alone rather than overwritten: a task that already completed
   * did complete, and reporting it as cancelled afterwards would make the caller's record
   * disagree with the callee's about work that actually happened. The `status in (...)`
   * clause is what makes this idempotent under a retried cancel.
   */
  async cancel(_peer: PeerDispatch['peer'], taskId: string): Promise<void> {
    await this.db
      .updateTable('runs')
      .set({ status: 'cancelled', ended_at: new Date() })
      .where('id', '=', taskId)
      .where('status', 'in', ['queued', 'running', 'tool_execution', 'checkpointed', 'waiting'])
      .execute();
    await this.db.deleteFrom('run_queue').where('run_id', '=', taskId).execute();
  }
}

/**
 * One error taxonomy across both bindings (§13.4 conformance).
 *
 * A caller that has to parse a different error shape depending on where the peer happens
 * to run has a topology dependency in its error handling -- the exact thing the binding
 * abstraction exists to remove.
 */
export function normaliseError(error: unknown): { code: string; message: string } {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  return {
    code: typeof e.code === 'string' ? e.code : 'internal',
    message: typeof e.message === 'string' ? e.message : String(error),
  };
}
