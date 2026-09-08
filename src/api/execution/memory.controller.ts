import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { MemoryEngine } from '../../domain/memory/memory.engine.js';
import { PlatformError, NotFound } from '../../domain/errors/platform.errors.js';
import { requireContext } from '../../platform/context/platform-context.js';

const TIERS = ['working', 'conversational', 'semantic', 'episodic', 'procedural', 'external'] as const;
const SCOPES = ['org', 'tenant', 'user', 'agent', 'thread', 'run'] as const;

const amendBody = z.object({
  /** Retrieval weight. Raising it promotes a record without editing what it says. */
  salience: z.number().min(0).max(1).optional(),
  /** §6.4: trust is a retrieval-time filter, so flipping it changes what agents see. */
  trusted: z.boolean().optional(),
  expiresAt: z.string().datetime().nullish(),
}).refine((b) => b.salience !== undefined || b.trusted !== undefined || b.expiresAt !== undefined, {
  message: 'nothing to amend — supply salience, trusted or expiresAt',
});

const storeBody = z.object({
  tier: z.enum(TIERS),
  scope: z.enum(SCOPES),
  threadId: z.string().uuid().nullish(),
  agentId: z.string().uuid().nullish(),
  userId: z.string().uuid().nullish(),
  runId: z.string().uuid().nullish(),
  content: z.string().max(100_000).nullish(),
  structured: z.record(z.string(), z.unknown()).nullish(),
  provenance: z.enum(['user_input', 'model_output', 'tool_output', 'peer_result', 'artifact', 'consolidated']),
  trusted: z.boolean().optional(),
  salience: z.number().min(0).max(100).optional(),
  ttlSeconds: z.number().int().positive().nullish(),
  /** Contribute to the namespace's shared pool. Refused unless a policy allows it. */
  share: z.boolean().optional(),
});

const searchBody = z.object({
  text: z.string().max(4_000).optional(),
  tiers: z.array(z.enum(TIERS)).optional(),
  threadId: z.string().uuid().nullish(),
  agentId: z.string().uuid().nullish(),
  trustedOnly: z.boolean().optional(),
  includeShared: z.boolean().optional(),
  limit: z.number().int().positive().max(50).optional(),
});

const consolidateBody = z.object({
  tier: z.enum(TIERS),
  scope: z.enum(SCOPES),
  threadId: z.string().uuid().nullish(),
  agentId: z.string().uuid().nullish(),
  minRecords: z.number().int().positive().max(200).optional(),
  maxChars: z.number().int().positive().max(20_000).optional(),
});

@Controller('v1/memory')
export class MemoryController {
  constructor(private readonly memory: MemoryEngine) {}

  /** Which adapter is behind each seam — useful when a swap is in flight. */
  @Get('engine')
  engine(): unknown {
    return { adapters: this.memory.describe() };
  }

  @Post()
  async store(@Body() body: unknown): Promise<unknown> {
    const parsed = storeBody.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error);
    const ctx = requireContext();
    const d = parsed.data;

    const id = await this.memory.store_({
      orgId: ctx.orgId,
      namespaceId: ctx.namespaceId,
      tenantRef: ctx.tenantRef,
      tier: d.tier,
      scopeRef: {
        scope: d.scope,
        threadId: d.threadId ?? null,
        agentId: d.agentId ?? null,
        userId: d.userId ?? null,
        runId: d.runId ?? null,
      },
      content: d.content ?? null,
      structured: d.structured ?? null,
      provenance: d.provenance,
      trusted: d.trusted,
      salience: d.salience,
      ttlSeconds: d.ttlSeconds ?? null,
      share: d.share,
    });
    return { id };
  }

  @Post('search')
  async search(@Body() body: unknown): Promise<unknown> {
    const parsed = searchBody.safeParse(body ?? {});
    if (!parsed.success) throw badRequest(parsed.error);
    const ctx = requireContext();
    const d = parsed.data;

    const results = await this.memory.recall({
      orgId: ctx.orgId,
      namespaceId: ctx.namespaceId,
      tenantRef: ctx.tenantRef,
      text: d.text,
      tiers: d.tiers,
      scopeRef: { threadId: d.threadId ?? undefined, agentId: d.agentId ?? undefined },
      trustedOnly: d.trustedOnly,
      includeShared: d.includeShared,
      limit: d.limit,
    });

    return {
      results: results.map((r) => ({
        id: r.id, tier: r.tier, scope: r.scope, content: r.content,
        // §6.4: provenance travels with the result, so a caller can tell first-party
        // knowledge from hearsay at the point of use rather than trusting it blindly.
        provenance: r.provenance, trusted: r.trusted,
        // A shared row names the tenant it came from, so a reader can weigh it (§15.3).
        shared: r.shared ?? false, sourceTenantRef: r.sourceTenantRef ?? null,
        score: Number(r.score.toFixed(4)), salience: r.salience, accessCount: r.accessCount,
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * Lists what EXISTS at a scope, newest first — not what is most relevant.
   *
   * Deliberately not `recall`: an operator auditing what the platform remembers about a
   * tenant needs everything at a scope, and a relevance ranking would silently omit the
   * record they came to find.
   */
  @Get()
  async list(
    @Query('tier') tier?: string,
    @Query('scope') scope?: string,
    @Query('threadId') threadId?: string,
    @Query('agentId') agentId?: string,
    @Query('runId') runId?: string,
    @Query('userId') userId?: string,
    @Query('trustedOnly') trustedOnly?: string,
    @Query('includeShared') includeShared?: string,
    @Query('includeSuperseded') includeSuperseded?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    const ctx = requireContext();
    const tiers = tier ? tier.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    const scopes = scope ? scope.split(',').map((t) => t.trim()).filter(Boolean) : undefined;

    // Validated rather than cast through. An unrecognised tier would otherwise reach the
    // store as a value no row can match, and the caller would read an empty list as
    // "nothing is remembered" instead of "you asked for a tier that does not exist".
    for (const t of tiers ?? []) {
      if (!(TIERS as readonly string[]).includes(t)) {
        throw new PlatformError('admission_rejected', `Unknown tier "${t}"`, { valid: TIERS });
      }
    }
    for (const t of scopes ?? []) {
      if (!(SCOPES as readonly string[]).includes(t)) {
        throw new PlatformError('admission_rejected', `Unknown scope "${t}"`, { valid: SCOPES });
      }
    }

    const records = await this.memory.list({
      orgId: ctx.orgId,
      namespaceId: ctx.namespaceId,
      tenantRef: ctx.tenantRef,
      ...(tiers ? { tiers: tiers as never[] } : {}),
      ...(scopes ? { scopes: scopes as never[] } : {}),
      ...(threadId || agentId || runId || userId
        ? {
            scopeRef: {
              ...(threadId ? { threadId } : {}),
              ...(agentId ? { agentId } : {}),
              ...(runId ? { runId } : {}),
              ...(userId ? { userId } : {}),
            },
          }
        : {}),
      trustedOnly: trustedOnly === 'true',
      includeShared: includeShared === 'true',
      includeSuperseded: includeSuperseded === 'true',
      limit: Math.min(Math.max(Number(limit) || 100, 1), 500),
    });

    return { records, count: records.length };
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<unknown> {
    const ctx = requireContext();
    const record = await this.memory.get(id);
    // Tenant-scoped: another tenant's record is indistinguishable from a missing one.
    if (!record || record.orgId !== ctx.orgId || record.tenantRef !== ctx.tenantRef) {
      throw new NotFound('memory record', id);
    }
    return record;
  }

  @Get(':id/lineage')
  async lineage(@Param('id') id: string, @Query('depth') depth?: string): Promise<unknown> {
    await this.get(id);
    return { edges: await this.memory.provenanceOf(id, Number(depth ?? 3) || 3) };
  }

  @Post('consolidate')
  async consolidate(@Body() body: unknown): Promise<unknown> {
    const parsed = consolidateBody.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error);
    const ctx = requireContext();
    const d = parsed.data;

    const result = await this.memory.consolidate({
      orgId: ctx.orgId,
      namespaceId: ctx.namespaceId,
      tenantRef: ctx.tenantRef,
      tier: d.tier,
      scopeRef: { scope: d.scope, threadId: d.threadId ?? null, agentId: d.agentId ?? null },
      minRecords: d.minRecords,
      maxChars: d.maxChars,
    });
    return result ?? { consolidated: false, reason: 'not enough records to consolidate' };
  }

  @Delete(':id')
  async forget(@Param('id') id: string): Promise<unknown> {
    await this.get(id);
    await this.memory.forget(id);
    return { forgotten: true };
  }

  /** Bulk erasure by scope — the path a data-deletion request actually uses. */
  @Delete()
  async forgetScope(@Query('threadId') threadId?: string, @Query('tier') tier?: string): Promise<unknown> {
    const ctx = requireContext();
    if (!threadId) {
      throw new PlatformError('admission_rejected', 'A scope is required; refusing to delete a whole tenant', {
        required: 'threadId',
      });
    }
    const deleted = await this.memory.forgetScope({
      orgId: ctx.orgId,
      namespaceId: ctx.namespaceId,
      tenantRef: ctx.tenantRef,
      tiers: tier ? [tier as never] : undefined,
      scopeRef: { threadId },
    });
    return { deleted };
  }

  /**
   * Amends a record's retrieval metadata.
   *
   * `content` is not amendable, and the omission is the design: a semantic record's
   * embedding was computed from its text, so editing the text in place leaves a vector
   * pointing at what it used to say — findable by the old meaning, unfindable by the new
   * one. Correcting a memory is superseding it, which keeps both the correction and what
   * it replaced (§6.4).
   */
  @Patch(':id')
  async amend(@Param('id') id: string, @Body() body: unknown): Promise<unknown> {
    // Named explicitly, because "nothing to amend" is a true but unhelpful answer to
    // someone who passed `content` and needs to know why editing text is not on offer.
    if (body !== null && typeof body === 'object' && 'content' in body) {
      throw new PlatformError(
        'admission_rejected',
        'A record\'s content cannot be amended in place',
        {
          reason:
            'Its embedding was computed from that text, so editing it leaves a vector ' +
            'pointing at what the record used to say — retrievable by the old meaning and ' +
            'unfindable by the new one.',
          hint: 'Store a new record that supersedes this one (§6.4), keeping both.',
        },
      );
    }
    const parsed = amendBody.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error);

    const ctx = requireContext();
    const existing = await this.memory.get(id);
    // Tenant-scoped, and 404 rather than 403 for the same reason a run is: telling a
    // caller that a record exists but is not theirs is an enumeration oracle.
    if (!existing || existing.namespaceId !== ctx.namespaceId || existing.tenantRef !== ctx.tenantRef) {
      throw new NotFound('memory record', id);
    }

    return this.memory.amend(id, {
      ...(parsed.data.salience !== undefined ? { salience: parsed.data.salience } : {}),
      ...(parsed.data.trusted !== undefined ? { trusted: parsed.data.trusted } : {}),
      ...(parsed.data.expiresAt !== undefined
        ? { expiresAt: parsed.data.expiresAt === null ? null : new Date(parsed.data.expiresAt) }
        : {}),
    });
  }
}

const badRequest = (error: z.ZodError): PlatformError =>
  new PlatformError('admission_rejected', 'Malformed request body', {
    issues: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  });
