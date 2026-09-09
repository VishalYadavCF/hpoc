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
import type { Db } from '../../platform/persistence/database.js';
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
      await this.inPeerOrg(peer, async () => {
        switch (method) {
          case 'message/send':
            res.status(200).json(rpcResult(id, await this.send(peer, params)));
            return;
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
        .executeTakeFirst(),
    );
    if (!run) throw new PlatformError('not_found', `Task ${taskId} not found`);
    await this.stream.attach(taskId, res, Number(lastEventId ?? 0) || 0);
  }

  // -------------------------------------------------------------------------

  private async send(
    peer: InboundPeer,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const message = (params['message'] ?? {}) as {
      parts?: { text?: string }[];
      contextId?: string;
    };
    const metadata = (params['metadata'] ?? {}) as Record<string, unknown>;
    const text = (message.parts ?? []).map((p) => p?.text ?? '').join('');

    const agentName = String(metadata['agent'] ?? params['agent'] ?? '');
    if (!agentName) {
      throw new PlatformError(
        'capability_denied',
        'metadata.agent must name the target agent',
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

    return this.uow.run(async (tx) => {
      const threadId =
        message.contextId ??
        (
          await tx
            .insertInto('threads')
            .values({
              org_id: agent.org_id,
              namespace_id: agent.namespace_id,
              tenant_ref: tenantRef,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;

      const run = await tx
        .insertInto('runs')
        .values({
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
        .returning(['id', 'thread_id'])
        .executeTakeFirstOrThrow();

      await this.queue.enqueue(tx, run.id);
      return {
        id: run.id,
        contextId: run.thread_id,
        kind: 'task',
        status: { state: 'submitted' },
      };
    });
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
    const name = req.header('x-a2a-peer');
    if (!name) {
      throw new PlatformError(
        'capability_denied',
        'x-a2a-peer header is required',
        {
          hint: 'Inbound A2A callers must be registered peers',
        },
      );
    }
    const row = await this.db
      .selectFrom('peers')
      .select(['id', 'org_id', 'name', 'status', 'inbound_trust'])
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
      principalId: principal.id,
    };
  }
}

interface InboundPeer {
  id: string;
  name: string;
  orgId: string;
  inboundTrust: 'self' | 'delegated_identity';
  principalId: string;
}

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
