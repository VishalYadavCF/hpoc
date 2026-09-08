import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { PromptService } from '../../domain/prompt/prompt.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';

const publishBody = z.object({
  ref: z.string().min(1).max(200),
  owner: z.string().min(1).max(200),
  body: z.string().min(1).max(100_000),
});

const versionParam = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new PlatformError('admission_rejected', `"${value}" is not a version number`);
  }
  return n;
};

/**
 * The prompt registry (§17.2).
 *
 * No PUT and no PATCH: a version is immutable, so editing a prompt is publishing the next
 * one. Publishing identical text returns the existing version rather than minting another,
 * because prompt authoring is mostly re-saving and a registry that counted keystrokes as
 * versions would make "which version is running" meaningless.
 */
@Controller('v1/prompts')
export class PromptsController {
  constructor(private readonly prompts: PromptService) {}

  @Get()
  async list(): Promise<unknown> {
    return { prompts: await this.prompts.list() };
  }

  @Post()
  async publish(@Body() body: unknown): Promise<unknown> {
    const parsed = publishBody.safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed prompt', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    return this.prompts.publish(parsed.data);
  }

  @Get(':ref/versions')
  async versions(@Param('ref') ref: string): Promise<unknown> {
    return { ref, versions: await this.prompts.versions(ref) };
  }

  @Get(':ref/versions/:version')
  async version(@Param('ref') ref: string, @Param('version') version: string): Promise<unknown> {
    return this.prompts.version(ref, versionParam(version));
  }

  /**
   * Approval makes a version selectable by BARE NAME. Until then it can only be reached by
   * an explicit pin, so a draft is testable without being shippable by accident.
   */
  @Post(':ref/versions/:version/approve')
  async approve(@Param('ref') ref: string, @Param('version') version: string): Promise<unknown> {
    return this.prompts.approve(ref, versionParam(version));
  }

  /** Which agent versions pin this prompt version — "what am I about to change?" */
  @Get(':ref/versions/:version/usage')
  async usage(@Param('ref') ref: string, @Param('version') version: string): Promise<unknown> {
    const pinnedBy = await this.prompts.usage(ref, versionParam(version));
    return {
      ref,
      version: versionParam(version),
      pinnedBy,
      note:
        'Agents pin a version, so editing this prompt changes none of them until they ' +
        'republish and pass admission again.',
    };
  }
}
