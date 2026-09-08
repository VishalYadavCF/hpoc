import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { PolicyService } from '../../domain/policy/policy.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';

const publishBody = z.object({
  ref: z.string().min(1).max(200),
  owner: z.string().min(1).max(200),
  // Validated against the document schema inside the service, so the error shape is the
  // same whether a policy arrives over HTTP or from a test constructing the service.
  document: z.unknown(),
});

const versionParam = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new PlatformError('admission_rejected', `"${value}" is not a version number`);
  }
  return n;
};

/**
 * The policy registry (§17.3).
 *
 * Same surface as the prompt registry next door, for the same reasons: no PUT and no
 * PATCH, because a version is immutable and editing a policy is publishing the next one.
 * Republishing an identical document returns the existing version rather than minting
 * another.
 *
 * The difference from prompts is what publishing achieves. A policy is enforced at
 * admission, so tightening one refuses the next agent that violates it — and `usage`
 * answers the question that precedes any tightening: who is pinned to this, and therefore
 * who has to republish before the change reaches them.
 */
@Controller('v1/policies')
export class PoliciesController {
  constructor(private readonly policies: PolicyService) {}

  @Get()
  async list(): Promise<unknown> {
    return { policies: await this.policies.list() };
  }

  @Post()
  async publish(@Body() body: unknown): Promise<unknown> {
    const parsed = publishBody.safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed policy', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    return this.policies.publish(parsed.data);
  }

  @Get(':ref/versions')
  async versions(@Param('ref') ref: string): Promise<unknown> {
    return { ref, versions: await this.policies.versions(ref) };
  }

  @Get(':ref/versions/:version')
  async version(@Param('ref') ref: string, @Param('version') version: string): Promise<unknown> {
    return this.policies.version(ref, versionParam(version));
  }

  /** Approval makes a version selectable by BARE NAME; until then it needs an explicit pin. */
  @Post(':ref/versions/:version/approve')
  async approve(@Param('ref') ref: string, @Param('version') version: string): Promise<unknown> {
    return this.policies.approve(ref, versionParam(version));
  }

  /** Which agent versions pin this policy version — "who breaks if I tighten this?" */
  @Get(':ref/versions/:version/usage')
  async usage(@Param('ref') ref: string, @Param('version') version: string): Promise<unknown> {
    const pinnedBy = await this.policies.usage(ref, versionParam(version));
    return {
      ref,
      version: versionParam(version),
      pinnedBy,
      note:
        'Agents pin a version, so tightening this policy refuses their NEXT publish rather ' +
        'than changing anything already running.',
    };
  }
}
