import { Body, Controller, Delete, Get, Inject, Post } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';

const policyBody = z.object({
  tiers: z.array(z.enum(['working', 'conversational', 'semantic', 'episodic', 'procedural', 'external'])).min(1),
  /** A named rule, recorded so "we stripped it" is a claim someone signed for. */
  redactionPolicy: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
});

/**
 * Cross-tenant memory sharing, decided by the consuming service (§6.2).
 *
 * The platform provides the mechanism and refuses to choose the policy: sharing data
 * derived from a service's own customers is a decision only that service can make. Off
 * for every namespace until someone here turns it on, and revocable without destroying
 * the corpus that was already contributed.
 */
@Controller('v1/memory/sharing')
export class MemorySharingController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async get(): Promise<unknown> {
    const ctx = requireContext();
    const policy = await this.db
      .selectFrom('memory_sharing_policies')
      .select((eb) => [
        'id', 'redaction_policy', 'enabled', 'approved_at', 'revoked_at',
        sql<string[]>`tiers::text[]`.as('tiers'),
      ])
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .executeTakeFirst();

    const shared = await this.db
      .selectFrom('memory_records')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('namespace_id', '=', ctx.namespaceId)
      .where('shared', '=', true)
      .executeTakeFirst();

    return {
      policy: policy ?? null,
      sharedRecords: Number(shared?.n ?? 0),
      note:
        'Off by default. Enabling it lets records written with share:true be read by ' +
        'every tenant in this namespace; revoking stops new reads without deleting what ' +
        'was already contributed.',
    };
  }

  @Post()
  async set(@Body() body: unknown): Promise<unknown> {
    const parsed = policyBody.safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed sharing policy', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const ctx = requireContext();
    return this.db
      .insertInto('memory_sharing_policies')
      .values({
        org_id: ctx.orgId,
        namespace_id: ctx.namespaceId,
        tiers: parsed.data.tiers,
        redaction_policy: parsed.data.redactionPolicy,
        enabled: parsed.data.enabled,
        approved_by: ctx.callerPrincipalId,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'namespace_id']).doUpdateSet({
          tiers: parsed.data.tiers,
          redaction_policy: parsed.data.redactionPolicy,
          enabled: parsed.data.enabled,
          approved_by: ctx.callerPrincipalId,
          revoked_at: null,
        }),
      )
      .returning((eb) => [
        'id', 'redaction_policy', 'enabled',
        sql<string[]>`tiers::text[]`.as('tiers'),
      ])
      .executeTakeFirstOrThrow();
  }

  @Delete()
  async revoke(): Promise<unknown> {
    const ctx = requireContext();
    // Revoke stops future reads; it does not delete contributed rows. Deleting them would
    // destroy a corpus other tenants may have built on, which is not what "stop sharing"
    // should mean.
    await this.db
      .updateTable('memory_sharing_policies')
      .set({ enabled: false, revoked_at: sql`now()` })
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .execute();
    return { enabled: false, note: 'Existing shared records are retained but no longer readable across tenants.' };
  }
}
