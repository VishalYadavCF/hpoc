import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { AgentService } from '../../domain/agent/agent.service.js';
import { TriggerService } from '../../domain/trigger/trigger.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';
import { RunService } from '../../domain/run-engine/run.service.js';
import { PeerService } from '../../domain/peer/peer.service.js';
import { requireContext } from '../../platform/context/platform-context.js';

const triggerBody = z
  .object({
    type: z.enum(['webhook', 'schedule', 'event']),
    webhookPath: z.string().min(1).max(100).optional(),
    cronExpression: z.string().min(1).max(100).optional(),
    eventSource: z.string().optional(),
    eventType: z.string().optional(),
    pinnedVersionId: z.string().uuid().nullish(),
    delivery: z.object({ webhookUrl: z.url() }).nullish(),
  })
  .refine((t) => t.type !== 'webhook' || Boolean(t.webhookPath), {
    message: 'a webhook trigger needs webhookPath',
  })
  .refine((t) => t.type !== 'schedule' || Boolean(t.cronExpression), {
    message: 'a schedule trigger needs cronExpression',
  })
  .refine((t) => t.type !== 'event' || Boolean(t.eventSource && t.eventType), {
    message: 'an event trigger needs eventSource and eventType',
  });

const replaceBody = z.object({
  owner: z.string().min(1).max(200).optional(),
  agent: z.unknown(),
  exposeAsPeer: z.boolean().optional(),
});

const agentRunBody = z.object({
  input: z.unknown().optional(),
  /** Pin a version. Omitted means the current one, resolved at request time. */
  version: z.number().int().positive().optional(),
  threadId: z.string().uuid().nullish(),
  idempotencyKey: z.string().min(1).max(200).nullish(),
  delivery: z.object({ webhookUrl: z.url() }).nullish(),
});

const publishBody = z.object({
  name: z.string().min(1).max(100),
  owner: z.string().min(1).max(200),
  agent: z.unknown(),
  exposeAsPeer: z.boolean().optional(),
});

@Controller('v1/agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentService,
    private readonly triggers: TriggerService,
    private readonly runs: RunService,
    private readonly peers: PeerService,
  ) {}

  /** Register, or publish a new immutable version of an existing agent (§17.4). */
  @Post()
  async publish(@Body() body: unknown): Promise<unknown> {
    const parsed = publishBody.safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed request body', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    return this.agents.publish({
      name: parsed.data.name,
      owner: parsed.data.owner,
      spec: parsed.data.agent,
      exposeAsPeer: parsed.data.exposeAsPeer,
    });
  }

  @Get()
  async list(): Promise<unknown> {
    return { agents: await this.agents.list() };
  }

  @Get(':name')
  async get(@Param('name') name: string): Promise<unknown> {
    return this.agents.get(name);
  }

  @Get(':name/triggers')
  async listTriggers(@Param('name') name: string): Promise<unknown> {
    const agent = await this.agents.get(name);
    return { triggers: await this.triggers.listForAgent(agent.id) };
  }

  @Post(':name/triggers')
  async attachTrigger(@Param('name') name: string, @Body() body: unknown): Promise<unknown> {
    const parsed = triggerBody.safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed trigger', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const agent = await this.agents.get(name);
    // The tenancy a fired run will execute under. Taken from the CALLER's context, so a
    // trigger cannot be attached for a tenant the caller could not otherwise reach.
    return this.triggers.attach({
      agentId: agent.id,
      tenantRef: requireContext().tenantRef,
      ...parsed.data,
    });
  }

  /**
   * Publishes a new version of an agent that MUST already exist.
   *
   * The one difference from POST is the missing-agent case, and that is the point: POST
   * creates-or-updates, so a typo in the name quietly registers a second agent. PUT says
   * "I expect this to exist" and gets a 404.
   */
  @Put(':name')
  async replace(@Param('name') name: string, @Body() body: unknown): Promise<unknown> {
    const parsed = replaceBody.safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed request body', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    return this.agents.replace({
      name,
      ...(parsed.data.owner ? { owner: parsed.data.owner } : {}),
      spec: parsed.data.agent,
      ...(parsed.data.exposeAsPeer !== undefined ? { exposeAsPeer: parsed.data.exposeAsPeer } : {}),
    });
  }

  /** Admission dry-run (§17.5). Returns every rejection at once, never a narrowed spec. */
  @Post(':name/validate')
  async validate(@Body() body: unknown): Promise<unknown> {
    const parsed = z.object({ agent: z.unknown() }).safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Body must contain an `agent` spec');
    }
    return this.agents.validate(parsed.data.agent);
  }

  @Get(':name/versions')
  async versions(@Param('name') name: string): Promise<unknown> {
    return { versions: await this.agents.listVersions(name) };
  }

  @Get(':name/versions/:version')
  async version(@Param('name') name: string, @Param('version') version: string): Promise<unknown> {
    const n = Number(version);
    if (!Number.isInteger(n)) {
      throw new PlatformError('admission_rejected', `"${version}" is not a version number`);
    }
    return this.agents.getVersion(name, n);
  }

  /** Observed state and conditions (§17.7) — deliberately separate from the desired spec. */
  @Get(':name/status')
  async status(@Param('name') name: string): Promise<unknown> {
    return this.agents.status(name);
  }

  /**
   * The signed Agent Card, derived from the spec (§13.6).
   *
   * The same card the A2A surface serves, exposed here so an operator can inspect what
   * peers see without authenticating as one. Derived on read, never stored — a stale
   * capability descriptor is worse than none, because callers act on it.
   */
  @Get(':name/card')
  async card(@Param('name') name: string): Promise<unknown> {
    const ctx = requireContext();
    return this.peers.cardFor(ctx.orgId, name, process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:3000');
  }

  /** Starts a run of a registered agent on its current version (§18.3). */
  @Post(':name/runs')
  async run(@Param('name') name: string, @Body() body: unknown): Promise<unknown> {
    const parsed = agentRunBody.safeParse(body ?? {});
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed run request', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const agent = await this.agents.get(name);
    // Pinned when asked for, otherwise the deployment-routed current version (§15.5) --
    // resolved HERE rather than deferred into the run, so the run records which version
    // it actually executed. "The latest" is not a version anyone can roll back to, and a
    // pinned request bypasses canary/shadow routing entirely: naming a version is asking
    // for exactly that version.
    const routed =
      parsed.data.version === undefined
        ? await this.agents.currentVersionId(agent.id)
        : { versionId: (await this.agents.getVersion(name, parsed.data.version)).id, shadowFromVersionId: null };

    return this.runs.createFromVersionWithShadow({
      agentVersionId: routed.versionId,
      shadowFromVersionId: routed.shadowFromVersionId,
      input: parsed.data.input,
      initiator: 'api',
      threadId: parsed.data.threadId ?? null,
      idempotencyKey: parsed.data.idempotencyKey ?? null,
      ...(parsed.data.delivery ? { delivery: parsed.data.delivery } : {}),
    });
  }

  /** Deprecate and archive (§17.4). Never deletes — history points at its versions. */
  @Delete(':name')
  async archive(@Param('name') name: string): Promise<unknown> {
    return this.agents.archive(name);
  }
}
