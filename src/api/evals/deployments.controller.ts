import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { DeploymentService } from '../../domain/eval/deployment.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';

const environment = z.enum(['staging', 'production']);

const gateBody = z.object({
  environment,
  suiteRef: z.string().min(1),
  minScore: z.number().min(0).max(1).optional(),
  allowOverride: z.boolean().default(false),
});

const promoteBody = z.object({
  environment,
  agentVersionId: z.string().uuid(),
  canaryPercent: z.number().int().min(0).max(100).optional(),
  shadowFromCurrent: z.boolean().default(false),
  overrideReason: z.string().min(10).max(1_000).optional(),
});

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new PlatformError('admission_rejected', 'Malformed request', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
};

/**
 * Deployments, promotion gates, canary and rollback (§17.4, §15.5).
 *
 * Nested under the agent because a deployment is not a free-standing object — it is a
 * statement about which version of THIS agent serves an environment, and the partial
 * unique index enforces exactly one active row per pair.
 */
@Controller('v1/agents/:name')
export class DeploymentsController {
  constructor(private readonly deployments: DeploymentService) {}

  @Get('deployments')
  async list(@Param('name') name: string): Promise<unknown> {
    return { deployments: await this.deployments.list(name) };
  }

  @Post('gate')
  async setGate(@Param('name') name: string, @Body() body: unknown): Promise<unknown> {
    const input = parse(gateBody, body);
    return this.deployments.setGate({
      agentName: name,
      environment: input.environment,
      suiteRef: input.suiteRef,
      ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
      allowOverride: input.allowOverride,
    });
  }

  /** Answers "would this promote?" without promoting — see DeploymentService.checkGate. */
  @Get('gate')
  async checkGate(
    @Param('name') name: string,
    @Query('environment') env: string,
    @Query('agentVersionId') versionId: string,
  ): Promise<unknown> {
    const parsed = environment.safeParse(env);
    if (!parsed.success || !versionId) {
      throw new PlatformError('admission_rejected', 'environment and agentVersionId are required');
    }
    return this.deployments.checkGate(name, parsed.data, versionId);
  }

  @Post('promote')
  async promote(@Param('name') name: string, @Body() body: unknown): Promise<unknown> {
    const input = parse(promoteBody, body);
    return this.deployments.promote({
      agentName: name,
      environment: input.environment,
      agentVersionId: input.agentVersionId,
      ...(input.canaryPercent !== undefined ? { canaryPercent: input.canaryPercent } : {}),
      shadowFromCurrent: input.shadowFromCurrent,
      ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
    });
  }

  @Post('rollback')
  async rollback(@Param('name') name: string, @Body() body: unknown): Promise<unknown> {
    const parsed = z.object({ environment }).safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'environment is required');
    }
    return this.deployments.rollback(name, parsed.data.environment);
  }
}
