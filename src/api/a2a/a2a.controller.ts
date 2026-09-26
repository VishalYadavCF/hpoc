import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Inject } from '@nestjs/common';
import { DB, POOL } from '../../platform/persistence/tokens.js';
import type pg from 'pg';
import { withTenantConnection } from '../../platform/persistence/tenant-connection.js';
import type { Db, Tx } from '../../platform/persistence/database.js';
import { sql } from 'kysely';
import { PeerService } from '../../domain/peer/peer.service.js';
import { RunService } from '../../domain/run-engine/run.service.js';
import { RunStreamService } from '../streaming/run-stream.service.js';
import { AgentService } from '../../domain/agent/agent.service.js';
import { QueueService } from '../../domain/queue/queue.service.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';
import type {
  PeerTaskState,
  RunStatus,
} from '../../platform/persistence/schema.types.js';
import { Doc } from '../openapi/api-doc.decorator.js';
import { ApiTags } from '@nestjs/swagger';

/** The inverse of the local transport's mapping, at the protocol edge (§13.4). */
const A2A_STATE: Record<RunStatus, string> = {
  queued: 'submitted',
  running: 'working',
  tool_execution: 'working',
  checkpointed: 'working',
  waiting: 'input-required',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'canceled',
  dead_letter: 'failed',
};

const rpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).default(null),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

/** JSON-RPC error codes: the standard range, plus A2A's task-specific ones. */
const RPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
} as const;

/**
 * The inbound A2A surface (§13.4, §20).
 *
 * Sits OUTSIDE `/v1` because it is a protocol adapter, not the platform's own API, and it
 * deliberately owns no state: `message/send` creates a run, `tasks/get` projects a run
 * row, and the stream is the existing SSE endpoint. §13.4's requirement that all active
 * streams for a task see the same events in the same order, and that task lifecycle is
 * independent of stream lifecycle, is satisfied by the append-only event log with per-run
 * sequence numbers — not by anything written here.
 *
 * Authentication is peer-name plus registration: a caller must present `x-a2a-peer`
 * naming a peer we registered, and the peer's `inbound_trust` decides whether we believe
 * what it says about tenancy. §15.4 requires inbound context to be subject to a trust
 * policy rather than accepted because it arrived.
 */
@ApiTags('a2a')
@Controller()
export class A2aController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(POOL) private readonly pool: pg.Pool,
    private readonly peers: PeerService,
    private readonly runs: RunService,
    private readonly agents: AgentService,
    private readonly queue: QueueService,
    private readonly uow: UnitOfWork,
    private readonly stream: RunStreamService,
  ) {}

  /**
   * Card discovery.
   *
   * With no `agent` parameter this describes the RUNTIME rather than any one agent:
   * publishing a default agent's card at a well-known path would make one agent
   * accidentally canonical, and which one would depend on registration order.
   */
  @Doc({
    summary: 'The well-known agent card',
  })
  @Get('.well-known/agent-card.json')
  async wellKnown(
    @Req() req: Request,
    @Query('agent') agent?: string,
  ): Promise<unknown> {
    if (!agent) {
      return {
        protocolVersion: '0.3.0',
        name: process.env['A2A_PROVIDER_NAME'] ?? 'general-agent-platform',
        description:
          'Agent cards are per-agent. Pass ?agent=<name>, or GET /a2a/v1/agents/{name}/card.',
        url: `${baseUrl(req)}/a2a/v1`,
        capabilities: {
          streaming: true,
          pushNotifications: true,
          stateTransitionHistory: true,
        },
      };
    }
    const peer = await this.requirePeer(req);
    return this.inPeerOrg(peer, () =>
      this.peers.cardFor(peer.orgId, agent, baseUrl(req)),
    );
  }

  @Doc({
    summary: 'Read one agent\'s card',
  })
  @Get('a2a/v1/agents/:name/card')
  async card(
    @Req() req: Request,
    @Param('name') name: string,
  ): Promise<unknown> {
    const peer = await this.requirePeer(req);
    return this.inPeerOrg(peer, () =>
      this.peers.cardFor(peer.orgId, name, baseUrl(req)),
    );
  }

  /**
   * One agent's card, at the path shape agentorchestratorsvc's registry is written in.
   *
   * Its `agent.registry.base-urls` is a list of per-agent card URLs of the form
   * `http://host/<agent>/.well-known/agent.json` -- the agent as a leading path segment, and
   * `agent.json`, the pre-0.3.0 name for what 0.3.0 calls `agent-card.json`. Serving that
   * shape means registering an hpoc agent there is one line of config and no code on a
   * service that is already in production.
   *
   * Same card, same exposure rule, same signature as the two routes above.
   */
  @Doc({
    summary: 'One agent\'s card, at the pre-0.3.0 well-known path',
  })
  @Get(':name/.well-known/agent.json')
  async legacyWellKnown(
    @Req() req: Request,
    @Param('name') name: string,
  ): Promise<unknown> {
    const peer = await this.requirePeer(req);
    return this.inPeerOrg(peer, () =>
      this.peers.cardFor(peer.orgId, name, baseUrl(req)),
    );
  }

  /** The JSON-RPC entrypoint. */
  @Doc({
    summary: 'A2A JSON-RPC endpoint',
    description:
      'Another trust domain (§13.4). A peer\'s failure is contained by default rather than fatal to the caller.',
    body: rpcRequest,
  })
  @Post('a2a/v1')
  async rpc(
    @Req() req: Request,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    return this.dispatch(req, body, res, null);
  }

  /**
   * The same JSON-RPC surface, addressed to ONE agent by path.
   *
   * This is the URL an agent's card advertises. agentorchestratorsvc -- the production
   * A2A client this surface has to satisfy unchanged -- routes a call by POSTing to the
   * card's `url` and sends no agent name in the body: its `metadata` carries merchant and
   * channel context, not a target. So the target has to live in the address, the way it
   * does for every agent that client already calls (`/onboarding-agent/a2a`,
   * `/payout-agent/a2a`). `metadata.agent` still works on the shared endpoint above.
   */
  @Doc({
    summary: 'A2A JSON-RPC endpoint for one agent',
    body: rpcRequest,
  })
  @Post('a2a/v1/agents/:name')
  async rpcForAgent(
    @Req() req: Request,
    @Param('name') name: string,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    return this.dispatch(req, body, res, name);
  }

  private async dispatch(
    req: Request,
    body: unknown,
    res: Response,
    /** Set when the agent came from the path, which then wins over anything in the body. */
    pathAgent: string | null,
  ): Promise<void> {
    const parsed = rpcRequest.safeParse(body);
    if (!parsed.success) {
      // JSON-RPC errors are HTTP 200 with an error member. Returning a 4xx would make a
      // transport failure and a protocol failure indistinguishable to the caller.
      res
        .status(200)
        .json(rpcError(null, RPC.invalidRequest, 'Invalid JSON-RPC request'));
      return;
    }
    const { id, method, params } = parsed.data;

    try {
      const peer = await this.requirePeer(req);
      // Everything past authentication is that peer's tenant's data, so it runs on a
      // connection pinned to their org (§5.2). Resolution itself could not be -- see
      // requirePeer.
      // Set by a `message`-mode send: the run to wait on once the pinned scope below has ended.
      const deferred: { run?: { runId: string; threadId: string } } = {};
      await this.inPeerOrg(peer, async () => {
        switch (method) {
          case 'message/send': {
            const sent = await this.send(peer, params, pathAgent);
            if ('wait' in sent) {
              deferred.run = sent.wait;
              return;
            }
            res.status(200).json(rpcResult(id, sent.reply));
            return;
          }
          case 'tasks/get':
            res
              .status(200)
              .json(rpcResult(id, await this.getTask(peer, params)));
            return;
          case 'tasks/cancel':
            res
              .status(200)
              .json(rpcResult(id, await this.cancelTask(peer, params)));
            return;
          case 'tasks/pushNotificationConfig/set':
            res
              .status(200)
              .json(rpcResult(id, await this.setPush(peer, params)));
            return;
          case 'tasks/resubscribe':
            // Deliberately not a no-op and not an error: resubscription IS the SSE endpoint,
            // and pointing at it is more useful than pretending this method does the work.
            res.status(200).json(
              rpcResult(id, {
                id: String(params['id'] ?? ''),
                streamUrl: `${baseUrl(req)}/a2a/v1/tasks/${String(params['id'] ?? '')}/stream`,
                note: 'Resubscribe by connecting to streamUrl with Last-Event-ID to replay then tail.',
              }),
            );
            return;
          default:
            res
              .status(200)
              .json(
                rpcError(id, RPC.methodNotFound, `Unknown method ${method}`),
              );
            return;
        }
      });

      // Waited OUTSIDE the pin. A sync reply can take tens of seconds, and holding the request's
      // pinned connection for all of it would let a handful of slow runs exhaust the pool and
      // stall every other request. Each poll pins briefly instead.
      if (deferred.run) {
        const reply = await this.awaitAsMessage(peer, deferred.run.runId, deferred.run.threadId, params);
        res.status(200).json(rpcResult(id, reply));
      }
    } catch (e) {
      if (e instanceof PlatformError) {
        const code =
          e.code === 'not_found'
            ? RPC.taskNotFound
            : e.code === 'capability_denied'
              ? RPC.invalidRequest
              : e.code === 'invalid_transition'
                ? RPC.taskNotCancelable
                : RPC.internal;
        res.status(200).json(rpcError(id, code, e.message));
        return;
      }
      res.status(200).json(rpcError(id, RPC.internal, 'Internal error'));
    }
  }

  /**
   * Task subscription.
   *
   * The same SSE machinery every other consumer uses, with the same `Last-Event-ID`
   * replay-then-tail. Closing one stream affects no other because a stream is only a
   * reader of the log, and the task keeps running because the task is a run.
   */
  @Doc({
    summary: 'Stream a peer task\'s events',
  })
  @Get('a2a/v1/tasks/:taskId/stream')
  async streamTask(
    @Req() req: Request,
    @Param('taskId') taskId: string,
    @Res() res: Response,
    @Headers('last-event-id') lastEventId?: string,
  ): Promise<void> {
    const peer = await this.requirePeer(req);
    const run = await this.inPeerOrg(peer, () =>
      this.db
        .selectFrom('runs')
        .select(['id'])
        .where('id', '=', taskId)
        .where('org_id', '=', peer.orgId)
        .where(startedBy(peer))
        .executeTakeFirst(),
    );
    if (!run) throw new PlatformError('not_found', `Task ${taskId} not found`);
    await this.stream.attach(taskId, res, Number(lastEventId ?? 0) || 0);
  }

  // -------------------------------------------------------------------------

  private async send(
    peer: InboundPeer,
    params: Record<string, unknown>,
    pathAgent: string | null = null,
  ): Promise<{ reply: unknown } | { wait: { runId: string; threadId: string } }> {
    const message = (params['message'] ?? {}) as {
      parts?: { text?: string }[];
      contextId?: string;
    };
    const metadata = (params['metadata'] ?? {}) as Record<string, unknown>;
    const text = (message.parts ?? []).map((p) => p?.text ?? '').join('');

    const agentName = pathAgent ?? String(metadata['agent'] ?? params['agent'] ?? '');
    if (!agentName) {
      throw new PlatformError(
        'capability_denied',
        'Name the target agent in the path (/a2a/v1/agents/{name}) or in metadata.agent',
      );
    }

    const agent = await this.db
      .selectFrom('agents')
      .select(['id', 'org_id', 'namespace_id', 'expose_as_peer', 'archived_at'])
      .where('org_id', '=', peer.orgId)
      .where('name', '=', agentName)
      .executeTakeFirst();
    if (!agent || agent.archived_at !== null || !agent.expose_as_peer) {
      // Same 404 whether it does not exist or is not exposed: distinguishing them lets an
      // unauthenticated caller enumerate our unexposed agents.
      throw new PlatformError('not_found', `Agent "${agentName}" not found`);
    }

    // §15.4: inbound context is subject to the peer's trust policy. A peer trusted only
    // for itself cannot assert whose tenant this is — it gets its own scope, and that is
    // the difference between a delegation chain and a claim.
    const tenantRef =
      peer.inboundTrust === 'delegated_identity' &&
      typeof metadata['tenantRef'] === 'string'
        ? metadata['tenantRef']
        : `peer:${peer.name}`;

    // Inbound A2A traffic is routed by deployment the same as any other agent invocation
    // (§15.5); shadow-firing is not wired here yet -- see run-loop/RunService for that.
    const { versionId } = await this.agents.currentVersionId(agent.id);

    // Effectively-once per caller request. agentorchestratorsvc RETRIES `message/send` on a read
    // timeout, and says in its own client that "agents whose work is not idempotent should key on
    // the subtask id in params.id, which is stable across these attempts". Without this a slow
    // run plus one retry is two runs, and an agent whose tool creates a workflow creates two.
    // Scoped by peer so two callers reusing an id cannot collide on each other's runs.
    const idempotencyKey =
      typeof params['id'] === 'string' && params['id'] ? `a2a:${peer.id}:${params['id']}` : null;

    const task = await this.uow.run(async (tx) => {
      if (idempotencyKey) {
        const prior = await tx
          .selectFrom('runs')
          .select(['id', 'thread_id'])
          .where('namespace_id', '=', agent.namespace_id)
          .where('tenant_ref', '=', tenantRef)
          .where('idempotency_key', '=', idempotencyKey)
          .executeTakeFirst();
        // Re-attach rather than restart: the retry waits on the run the first attempt started.
        //
        // INCLUDING a run that failed, deliberately. The client retries only when it received
        // no reply at all, so a retry is a request for the answer it missed -- not a request to
        // do the work again. Starting a fresh run after a failure it never saw would re-execute
        // tools whose first attempt may have landed, which is the duplicate this key exists to
        // prevent. New work arrives under a new subtask id.
        if (prior) return { runId: prior.id, threadId: prior.thread_id };
      }

      // The peer's OWN tenant is registered where the run lands. Without a `tenants` row every
      // run a peer starts is unreadable through /v1 -- ContextMiddleware refuses an unregistered
      // tenant -- so an operator could not inspect a single inbound run. Only `peer:<name>`: a
      // tenant a delegated_identity peer merely ASSERTS is never created on its say-so.
      if (tenantRef === `peer:${peer.name}`) {
        await tx
          .insertInto('tenants')
          .values({
            org_id: agent.org_id,
            namespace_id: agent.namespace_id,
            tenant_ref: tenantRef,
            display_name: `A2A peer ${peer.name}`,
          })
          .onConflict((oc) => oc.columns(['namespace_id', 'tenant_ref']).doNothing())
          .execute();
      }

      const threadId = await this.threadFor(tx, peer, agent, tenantRef, message.contextId);

      const run = await tx
        .insertInto('runs')
        .values({
          idempotency_key: idempotencyKey,
          thread_id: threadId,
          agent_version_id: versionId,
          org_id: agent.org_id,
          namespace_id: agent.namespace_id,
          tenant_ref: tenantRef,
          status: 'queued',
          durability: 'strict',
          initiator: 'peer',
          caller_principal_id: peer.principalId,
          input: JSON.stringify(text || null),
          // The inbound depth is what the caller CLAIMS. It is carried so our own limits
          // still bite on a chain that started elsewhere, and it is clamped so a peer
          // cannot buy itself extra depth by understating it.
          delegation_depth: Math.max(
            0,
            Number(metadata['delegationDepth'] ?? 0),
          ),
          delegation_chain: JSON.stringify([
            { peerId: peer.id, inbound: true },
          ]),
        })
        // Two attempts with the same key racing past the select above: the loser waits on
        // the winner's transaction, then does nothing instead of raising a unique violation
        // that would reach the caller as an internal error. It re-attaches below instead.
        // The WHERE matches runs_idempotency_uq, which is partial, so Postgres can infer it.
        .onConflict((oc) =>
          oc
            .columns(['namespace_id', 'tenant_ref', 'idempotency_key'])
            .where('idempotency_key', 'is not', null)
            .doNothing(),
        )
        .returning(['id', 'thread_id'])
        .executeTakeFirst();

      if (!run) {
        const winner = await tx
          .selectFrom('runs')
          .select(['id', 'thread_id'])
          .where('namespace_id', '=', agent.namespace_id)
          .where('tenant_ref', '=', tenantRef)
          .where('idempotency_key', '=', idempotencyKey)
          .executeTakeFirstOrThrow();
        return { runId: winner.id, threadId: winner.thread_id };
      }

      // Enqueued only by the attempt that inserted. A re-attaching retry must not queue the
      // run a second time.
      await this.queue.enqueue(tx, run.id);
      return { runId: run.id, threadId: run.thread_id };
    });

    // A `message`-mode caller is answered after the run settles, and that wait happens in
    // dispatch() once the pinned connection is released -- not here, inside it.
    if (peer.replyMode === 'message') return { wait: task };
    return {
      reply: {
        id: task.runId,
        contextId: task.threadId,
        kind: 'task',
        status: { state: 'submitted' },
      },
    };
  }

  /**
   * The thread a caller's `contextId` names.
   *
   * An hpoc thread id -- what `tasks/get` hands back as `contextId`, so what hpoc's own peers
   * send -- is used as-is. Anything else is the CALLER's correlation handle, not ours: the
   * production orchestrator puts its own session id there. Used directly it is a foreign key
   * into `threads` that does not exist, and the insert fails. Mapped through `external_ref` it
   * becomes one hpoc thread per caller session, so every subtask of one conversation shares
   * the thread its memory and artifacts are scoped to.
   */
  private async threadFor(
    tx: Tx,
    peer: InboundPeer,
    agent: { org_id: string; namespace_id: string },
    tenantRef: string,
    contextId: string | undefined,
  ): Promise<string> {
    if (contextId && UUID.test(contextId)) {
      // Matched on namespace AND tenant, not just org: a thread id is not a capability, and a
      // caller that learned one must not be able to attach its run to another tenant's thread
      // and read the memory and artifacts scoped to it. A miss falls through to the
      // external-ref path rather than failing, since a UUID-shaped session id is legitimate.
      const own = await tx
        .selectFrom('threads')
        .select('id')
        .where('id', '=', contextId)
        .where('org_id', '=', agent.org_id)
        .where('namespace_id', '=', agent.namespace_id)
        .where('tenant_ref', '=', tenantRef)
        .executeTakeFirst();
      if (own) return own.id;
    }

    if (!contextId) {
      const fresh = await tx
        .insertInto('threads')
        .values({ org_id: agent.org_id, namespace_id: agent.namespace_id, tenant_ref: tenantRef })
        .returning('id')
        .executeTakeFirstOrThrow();
      return fresh.id;
    }

    // Qualified by peer and tenant because `external_ref` is unique per NAMESPACE only. A bare
    // session id would let two tenants -- or two callers -- that happen to use the same one land
    // on one thread, whose tenant is whichever arrived first. Upserted so two subtasks of one
    // session arriving together still land on ONE thread rather than racing into two.
    const thread = await tx
      .insertInto('threads')
      .values({
        org_id: agent.org_id,
        namespace_id: agent.namespace_id,
        tenant_ref: tenantRef,
        external_ref: `a2a:${peer.id}:${tenantRef}:${contextId}`,
      })
      .onConflict((oc) =>
        oc.columns(['namespace_id', 'external_ref']).doUpdateSet({ updated_at: sql`now()` }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    return thread.id;
  }

  /**
   * Waits for the run and answers in the `message` dialect (peers.reply_mode, 0032).
   *
   * agentorchestratorsvc never polls `tasks/get`. It reads ONE reply: `result.kind` must be
   * "message", `result.status` goes through `TaskStatus.valueOf(status.toUpperCase())` against its
   * own enum, and the answer is the concatenated text of `result.parts`. A2A's own state names
   * (`working`, `submitted`, `input-required`) are not in that enum and parse as FAILED, so the
   * mapping below uses its names, not A2A's.
   *
   * A run still going at the deadline answers `processing`, which the orchestrator parks until a
   * webhook arrives on /api/v1/orchestrator/async/webhook. hpoc does not deliver that webhook yet,
   * so the wait is sized to outlast an ordinary run. Should a client retry anyway, it re-attaches
   * to the same run through the idempotency key and waits again.
   */
  private async awaitAsMessage(
    peer: InboundPeer,
    runId: string,
    threadId: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // 120s by default. agentorchestratorsvc's GenericHttpClient sets no read timeout -- a plain
    // RestTemplate waits indefinitely -- so the binding limit is ours, and hitting it strands the
    // subtask as `processing` until a webhook hpoc does not yet send. The wait holds no database
    // connection (see dispatch), so a generous ceiling costs only an open request.
    const waitMs = Number(process.env['A2A_SYNC_WAIT_MS'] ?? 120_000);
    const deadline = Date.now() + waitMs;
    const reply = (status: string, text: string) => ({
      kind: 'message',
      messageId: runId,
      role: 'agent',
      status,
      // Echoed so the orchestrator's stored message lines up with the subtask it sent.
      ...(typeof params['id'] === 'string' ? { taskId: params['id'] } : {}),
      ...(typeof params['sessionId'] === 'string' ? { sessionId: params['sessionId'] } : {}),
      contextId: threadId,
      parts: [{ kind: 'text', text }],
      // Surfaces as the orchestrator's responseMetadata: the handle from its record to ours.
      metadata: { hpocRunId: runId },
    });

    for (;;) {
      // Pinned for this one read and released before the sleep (§5.2 still applies per poll).
      const run = await this.inPeerOrg(peer, () =>
        this.db
          .selectFrom('runs')
          .select(['status', 'output', 'error'])
          .where('id', '=', runId)
          .executeTakeFirstOrThrow(),
      );

      switch (run.status) {
        case 'completed':
          return reply('completed', textOf(run.output));
        case 'failed':
        case 'dead_letter':
        case 'cancelled':
          return reply('failed', errorText(run.error) ?? `Run ${run.status}`);
        case 'waiting':
          // A suspended run is waiting on a human or another agent -- the orchestrator's
          // INPUT_REQUIRED, not a failure and not an answer.
          return reply('input_required', textOf(run.output) || 'The agent is waiting for input.');
      }

      if (Date.now() >= deadline) {
        return reply('processing', 'The agent is still working on this request.');
      }
      await new Promise((r) => setTimeout(r, SYNC_POLL_MS));
    }
  }

  private async getTask(
    peer: InboundPeer,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = String(params['id'] ?? '');
    const run = await this.db
      .selectFrom('runs')
      .select(['id', 'thread_id', 'status', 'output', 'error'])
      .where('id', '=', id)
      .where('org_id', '=', peer.orgId)
        .where(startedBy(peer))
      .executeTakeFirst();
    if (!run) throw new PlatformError('not_found', `Task ${id} not found`);

    return {
      id: run.id,
      contextId: run.thread_id,
      kind: 'task',
      status: { state: A2A_STATE[run.status] },
      ...(run.status === 'completed'
        ? {
            artifacts: [
              {
                artifactId: run.id,
                parts: [{ kind: 'data', data: run.output }],
              },
            ],
          }
        : {}),
      ...(run.error ? { error: run.error } : {}),
    };
  }

  private async cancelTask(
    peer: InboundPeer,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = String(params['id'] ?? '');
    const run = await this.db
      .selectFrom('runs')
      .select(['id', 'status'])
      .where('id', '=', id)
      .where('org_id', '=', peer.orgId)
        .where(startedBy(peer))
      .executeTakeFirst();
    if (!run) throw new PlatformError('not_found', `Task ${id} not found`);
    if (
      ['completed', 'failed', 'cancelled', 'dead_letter'].includes(run.status)
    ) {
      throw new PlatformError(
        'invalid_transition',
        `Task ${id} is ${run.status} and cannot be cancelled`,
      );
    }
    await this.runs.cancel(id);
    return { id, status: { state: 'canceled' } };
  }

  /**
   * Push notification config.
   *
   * A2A's push notifications are §12.1's async webhook transport under another name, so
   * this records a destination and the existing outbox delivers it. A second delivery path
   * would mean a second retry policy and a second set of dead letters for one failure.
   */
  private async setPush(
    peer: InboundPeer,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = String(params['taskId'] ?? params['id'] ?? '');
    const config = (params['pushNotificationConfig'] ?? {}) as {
      url?: string;
      token?: string;
    };
    if (!config.url)
      throw new PlatformError(
        'capability_denied',
        'pushNotificationConfig.url is required',
      );

    const run = await this.db
      .selectFrom('runs')
      .select('id')
      .where('id', '=', id)
      .where('org_id', '=', peer.orgId)
        .where(startedBy(peer))
      .executeTakeFirst();
    if (!run) throw new PlatformError('not_found', `Task ${id} not found`);

    await this.db
      .insertInto('a2a_push_configs')
      .values({
        org_id: peer.orgId,
        run_id: id,
        url: config.url,
        // A REFERENCE, never the token itself (§16.3). Storing the bearer here would put
        // a live credential in the control plane's own tables.
        token_ref: config.token ? `inline:${config.token.slice(0, 8)}…` : null,
      })
      .onConflict((oc) => oc.column('run_id').doUpdateSet({ url: config.url }))
      .execute();

    return { taskId: id, pushNotificationConfig: { url: config.url } };
  }

  /** Resolves and authorises the calling peer (§15.4). */
  /**
   * §5.2 RLS bootstrap. Resolving WHICH tenant is calling has to happen before a
   * connection can be pinned to that tenant, exactly as ContextMiddleware resolves a
   * namespace before it can pin one. These two reads therefore run under `bypass`, and
   * everything the resolved peer then does is pinned to its org by the caller.
   */
  private requirePeer(req: Request): Promise<InboundPeer> {
    return withTenantConnection(this.pool, { bypass: true }, () =>
      this.resolvePeer(req),
    );
  }

  /** Runs `fn` on a connection pinned to the peer's org (§5.2). */
  private inPeerOrg<T>(peer: InboundPeer, fn: () => Promise<T>): Promise<T> {
    return withTenantConnection(this.pool, { orgId: peer.orgId }, fn);
  }

  private async resolvePeer(req: Request): Promise<InboundPeer> {
    // A caller that names itself is resolved as itself. One that does not falls back to
    // A2A_DEFAULT_PEER -- which exists because agentorchestratorsvc, the production A2A
    // client, sends no identifying header on any call, card or RPC.
    //
    // This is NOT "no authentication". The default still has to be a registered, ACTIVE
    // peer row, so an anonymous call lands in one named org, is attributed to that org's
    // service principal, and inherits that peer's `inbound_trust` -- `self` by default,
    // meaning an anonymous caller cannot assert whose tenant it is. Unset, anonymous calls
    // are refused exactly as before; opting in is an explicit deployment decision.
    const name = req.header('x-a2a-peer') ?? process.env['A2A_DEFAULT_PEER'];
    if (!name) {
      throw new PlatformError(
        'capability_denied',
        'x-a2a-peer header is required',
        {
          hint: 'Inbound A2A callers must be registered peers, or A2A_DEFAULT_PEER must name one',
        },
      );
    }
    const row = await this.db
      .selectFrom('peers')
      .select(['id', 'org_id', 'name', 'status', 'inbound_trust', 'reply_mode'])
      .where('name', '=', name)
      .executeTakeFirst();
    if (!row || row.status !== 'active') {
      throw new PlatformError(
        'capability_denied',
        `Unknown or inactive peer "${name}"`,
      );
    }

    // Every inbound run needs an accountable principal. The peer's own service identity is
    // it -- attributing the run to the human the peer *claims* is behind it would make an
    // unverified header the basis of our audit trail.
    const principal = await this.db
      .selectFrom('principals')
      .select('id')
      .where('org_id', '=', row.org_id)
      .where('kind', '=', 'service')
      .orderBy('created_at')
      .executeTakeFirst();
    if (!principal) {
      throw new PlatformError(
        'capability_denied',
        'No service principal available for inbound peer runs',
      );
    }

    return {
      id: row.id,
      name: row.name,
      orgId: row.org_id,
      inboundTrust: row.inbound_trust,
      replyMode: row.reply_mode,
      principalId: principal.id,
    };
  }
}

interface InboundPeer {
  id: string;
  name: string;
  orgId: string;
  inboundTrust: 'self' | 'delegated_identity';
  /** How this caller expects `message/send` answered (peers.reply_mode, 0032). */
  replyMode: 'task' | 'message';
  principalId: string;
}

/**
 * Restricts a `runs` query to the runs THIS peer started over A2A.
 *
 * Every task operation -- `tasks/get`, `tasks/cancel`, push config, the SSE stream -- used to be
 * scoped by org alone. That was already too wide (any registered peer could read or cancel any
 * run in the org given its id, A2A-born or not), and A2A_DEFAULT_PEER made it anonymous: whoever
 * held a run id could read an ai-agent-v2 run's output or cancel it. A peer's authority over a
 * task comes from having created it, so that is what is checked. `send` writes exactly this shape
 * into `delegation_chain`, which is what makes the containment test sound.
 */
const startedBy = (peer: InboundPeer) =>
  sql<boolean>`initiator = 'peer' AND delegation_chain @> ${JSON.stringify([{ peerId: peer.id }])}::jsonb`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Short enough that a finished run is answered promptly, long enough not to hammer the row. */
const SYNC_POLL_MS = 250;

/** The answer a caller reads: the run's text, or the whole output when there is no text. */
const textOf = (output: unknown): string => {
  if (output === null || output === undefined) return '';
  const text = (output as { text?: unknown }).text;
  return typeof text === 'string' ? text : JSON.stringify(output);
};

const errorText = (error: unknown): string | null => {
  if (!error) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : JSON.stringify(error);
};

const baseUrl = (req: Request): string =>
  process.env['PUBLIC_BASE_URL'] ??
  `${req.protocol}://${req.get('host') ?? 'localhost'}`;

const rpcResult = (id: string | number | null, result: unknown) => ({
  jsonrpc: '2.0',
  id,
  result,
});
const rpcError = (
  id: string | number | null,
  code: number,
  message: string,
) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});
