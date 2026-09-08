import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { requireContext } from '../../platform/context/platform-context.js';
import { SkillService } from '../../domain/skills/skill.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';

const publishBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).nullish(),
  instructions: z.string().min(1).max(64_000),
  whenToUse: z.string().max(1_000).nullish(),
  tools: z.array(z.string().min(1)).max(32).default([]),
  collections: z.array(z.string().min(1)).max(16).default([]),
});

/**
 * The skill registry (§17.2-adjacent, §17.5 for why it is a registry at all).
 *
 * There is no PUT and no PATCH, and that is the design rather than an omission: a skill
 * version is immutable once published, so "editing" a skill is publishing the next
 * version. Agents already admitted against v3 keep running v3 until someone republishes
 * them, which sends the change back through admission where a widened tool set is
 * actually checked.
 */
@Controller('v1/skills')
export class SkillsController {
  constructor(private readonly skills: SkillService) {}

  @Get()
  async list(): Promise<unknown> {
    const ctx = requireContext();
    return { skills: await this.skills.list(ctx.namespaceId) };
  }

  @Post()
  async publish(@Body() body: unknown): Promise<unknown> {
    const parsed = publishBody.safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed skill', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const ctx = requireContext();
    return this.skills.publish({
      orgId: ctx.orgId,
      namespaceId: ctx.namespaceId,
      publishedBy: ctx.callerPrincipalId,
      ...parsed.data,
      description: parsed.data.description ?? null,
      whenToUse: parsed.data.whenToUse ?? null,
    });
  }

  @Get(':name/versions')
  async versions(@Param('name') name: string): Promise<unknown> {
    const ctx = requireContext();
    const versions = await this.skills.versions(ctx.namespaceId, name);
    if (versions.length === 0) throw new PlatformError('not_found', `Skill "${name}" not found`);
    return { name, versions };
  }

  /**
   * Deprecation makes a version unselectable by NAME without breaking agents pinned to
   * it. Cascading it into existing pins would be a deletion wearing a softer word, and
   * would take out running agents at a moment nobody chose.
   */
  @Delete(':name/versions/:version')
  async deprecate(
    @Param('name') name: string,
    @Param('version') version: string,
  ): Promise<unknown> {
    const ctx = requireContext();
    const n = Number(version);
    if (!Number.isInteger(n)) {
      throw new PlatformError('admission_rejected', `"${version}" is not a version number`);
    }
    await this.skills.deprecate(ctx.namespaceId, name, n);
    return {
      deprecated: `${name}@${n}`,
      note: 'Agents already pinned to this version keep running it; new specs cannot select it by name.',
    };
  }
}
