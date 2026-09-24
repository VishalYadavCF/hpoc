import { Body, Controller, Delete, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { requireContext } from '../../platform/context/platform-context.js';
import { SkillService } from '../../domain/skills/skill.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';
import { Doc } from '../openapi/api-doc.decorator.js';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';

const publishBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).nullish(),
  instructions: z.string().min(1).max(64_000),
  whenToUse: z.string().max(1_000).nullish(),
  tools: z.array(z.string().min(1)).max(32).default([]),
  collections: z.array(z.string().min(1)).max(16).default([]),
});

// multipart/form-data fields arrive as strings; tools/collections are JSON-encoded arrays
// within that string rather than repeated fields, so the shape does not depend on which
// array convention a given HTTP client happens to use for a form.
const uploadFields = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  whenToUse: z.string().max(1_000).optional(),
  tools: z.string().optional(),
  collections: z.string().optional(),
});
const stringArray = z.array(z.string().min(1));

/**
 * The skill registry (§17.2-adjacent, §17.5 for why it is a registry at all).
 *
 * There is no PUT and no PATCH, and that is the design rather than an omission: a skill
 * version is immutable once published, so "editing" a skill is publishing the next
 * version. Agents already admitted against v3 keep running v3 until someone republishes
 * them, which sends the change back through admission where a widened tool set is
 * actually checked.
 */
@ApiTags('skills')
@Controller('v1/skills')
export class SkillsController {
  constructor(private readonly skills: SkillService) {}

  @Doc({
    summary: 'List skills',
  })
  @Get()
  async list(): Promise<unknown> {
    const ctx = requireContext();
    return { skills: await this.skills.list(ctx.namespaceId) };
  }

  @Doc({
    summary: 'Publish a skill version',
    body: publishBody,
  })
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

  /**
   * The upload counterpart to `publish`: the body IS the skill's content -- a complete
   * SKILL.md, possibly with attachments referenced by relative path within it -- rather
   * than a JSON `instructions` string. Stored in object storage and streamed on demand by
   * a run that pins it (see `deep-agents.adapter.ts`'s `/skills` routing), never eagerly
   * loaded into every run that merely has it pinned.
   *
   * `content_uri` and `instructions` stay mutually exclusive (skill_versions_content_source_chk)
   * -- this endpoint and `publish` are two doors onto the same immutable-per-version model,
   * not two different kinds of skill.
   */
  @Doc({ summary: 'Publish a skill version from an uploaded file' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'name'],
      properties: {
        file: { type: 'string', format: 'binary' },
        name: { type: 'string' },
        description: { type: 'string' },
        whenToUse: { type: 'string' },
        tools: { type: 'string', description: 'JSON-encoded array of tool refs' },
        collections: { type: 'string', description: 'JSON-encoded array of collection names' },
      },
    },
  })
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async publishUpload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    const issues: string[] = [];
    if (!file || file.size === 0) issues.push('file: required, must not be empty');

    const parsedFields = uploadFields.safeParse(body);
    if (!parsedFields.success) {
      issues.push(...parsedFields.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    }

    const tools = parseJsonArray('tools', parsedFields.success ? parsedFields.data.tools : undefined, issues);
    const collections = parseJsonArray(
      'collections',
      parsedFields.success ? parsedFields.data.collections : undefined,
      issues,
    );

    if (issues.length > 0) throw new PlatformError('admission_rejected', 'Malformed skill upload', { issues });

    const ctx = requireContext();
    return this.skills.publish({
      orgId: ctx.orgId,
      namespaceId: ctx.namespaceId,
      publishedBy: ctx.callerPrincipalId,
      name: parsedFields.data!.name,
      description: parsedFields.data!.description ?? null,
      whenToUse: parsedFields.data!.whenToUse ?? null,
      tools,
      collections,
      content: file!.buffer,
      contentMediaType: file!.mimetype || 'text/markdown',
    });
  }

  @Doc({
    summary: 'List a skill\'s versions',
  })
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
  @Doc({
    summary: 'Deprecate a skill version',
  })
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

/** A multipart field holding a JSON-encoded string[], or the field's own default when unset. */
function parseJsonArray(field: string, raw: string | undefined, issues: string[]): string[] {
  if (raw === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    issues.push(`${field}: must be a JSON-encoded array of strings`);
    return [];
  }
  const parsed = stringArray.safeParse(value);
  if (!parsed.success) {
    issues.push(`${field}: must be a JSON-encoded array of strings`);
    return [];
  }
  return parsed.data;
}
