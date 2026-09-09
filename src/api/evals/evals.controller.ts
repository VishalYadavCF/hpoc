import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { EvalService } from '../../domain/eval/eval.service.js';
import { EvalSuiteService } from '../../domain/eval/suite.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';
import { Doc } from '../openapi/api-doc.decorator.js';
import { ApiTags } from '@nestjs/swagger';

const MECHANISMS = [
  'summarization', 'compaction', 'memory_tiers', 'planning_scaffold', 'sub_agents',
  'retrieval', 'eviction', 'skills', 'knowledge', 'model_cache', 'peers', 'none',
] as const;

const suiteBody = z.object({
  ref: z.string().min(1).max(120),
  description: z.string().max(2_000).nullish(),
  mechanismUnderTest: z.enum(MECHANISMS).nullish(),
  minScore: z.number().min(0).max(1).optional(),
  minMechanismDelta: z.number().min(0).max(1).optional(),
  // Bounded at 20 by the schema: past that the suite costs more than the confidence buys.
  trialsPerCase: z.number().int().min(1).max(20).optional(),
  cases: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        input: z.unknown(),
        expectation: z.unknown(),
        grader: z.enum(['exact', 'contains', 'not_contains', 'regex', 'json_path', 'budget', 'llm_judge']),
        weight: z.number().positive().max(100).optional(),
        abComparable: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(500),
});

const runBody = z.object({
  suiteRef: z.string().min(1),
  agentVersionId: z.string().uuid(),
  compareMechanism: z.boolean().default(false),
  caseTimeoutMs: z.number().int().positive().max(600_000).optional(),
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
 * Eval suites and runs (§15.5).
 *
 * `POST /{ref}/run` executes synchronously and can take minutes: it starts a real run per
 * case and waits for each to settle. That is deliberate at this scale — the caller is
 * usually CI, which wants the verdict rather than a job id to poll — and `caseTimeoutMs`
 * bounds it. A suite large enough to make that wrong should be split, or moved behind the
 * trigger path, which already does async.
 */
@ApiTags('evals')
@Controller('v1/evals')
export class EvalsController {
  constructor(
    private readonly suites: EvalSuiteService,
    private readonly evals: EvalService,
  ) {}

  /**
   * §0.5's ledger.
   *
   * Under a literal segment rather than at `/v1/evals/{ref}` because suites and runs live
   * under their own prefixes: a bare `{ref}` at this level would mean every literal route
   * added later silently shadows a suite named the same thing.
   */
  @Doc({
    summary: 'List the compensating mechanisms an eval can toggle',
    description:
      '§0.5: every mechanism is individually disableable, so its contribution can be measured.',
  })
  @Get('mechanisms')
  async mechanisms(): Promise<unknown> {
    return {
      mechanisms: await this.suites.mechanismLedger(),
      note:
        '§0.5: each compensating mechanism needs an eval demonstrating current benefit. ' +
        'A verdict of no_eval means the mechanism is retained on faith.',
    };
  }

  @Doc({
    summary: 'List eval suites',
  })
  @Get('suites')
  async list(): Promise<unknown> {
    return { suites: await this.suites.list() };
  }

  @Doc({
    summary: 'Create or update an eval suite',
  })
  @Post('suites')
  async upsert(@Body() body: unknown): Promise<unknown> {
    return this.suites.upsert(parse(suiteBody, body));
  }

  @Doc({
    summary: 'Read an eval suite',
  })
  @Get('suites/:ref')
  async get(@Param('ref') ref: string): Promise<unknown> {
    return this.suites.get(ref);
  }

  /**
   * Replaces a suite and every case in it.
   *
   * PUT rather than PATCH because that is what it does: cases are replaced wholesale, so
   * a suite an author edited is exactly what they submitted. A merge would leave a deleted
   * case still scoring, and the suite would differ from what its author believes gates on it.
   */
  @Doc({
    summary: 'Replace an eval suite',
  })
  @Put('suites/:ref')
  async replace(@Param('ref') ref: string, @Body() body: unknown): Promise<unknown> {
    const input = parse(suiteBody.omit({ ref: true }), body);
    return this.suites.upsert({ ...input, ref });
  }

  @Doc({
    summary: 'List a suite\'s cases',
  })
  @Get('suites/:ref/cases')
  async cases(@Param('ref') ref: string): Promise<unknown> {
    const suite = await this.suites.get(ref);
    return { cases: suite.cases };
  }

  /**
   * Runs a suite against a version.
   *
   * Synchronous, and it can take minutes: it starts a real run per case and waits for each
   * to settle. Deliberate at this scale — the caller is usually CI, which wants the verdict
   * rather than a job id to poll — and `caseTimeoutMs` bounds it.
   */
  @Doc({
    summary: 'Run an eval suite',
  })
  @Post('runs')
  async run(@Body() body: unknown): Promise<unknown> {
    const input = parse(runBody, body);
    return this.evals.run({
      suiteRef: input.suiteRef,
      agentVersionId: input.agentVersionId,
      compareMechanism: input.compareMechanism,
      ...(input.caseTimeoutMs ? { caseTimeoutMs: input.caseTimeoutMs } : {}),
    });
  }

  @Doc({
    summary: 'List eval runs',
  })
  @Get('runs')
  async history(
    @Query('suiteRef') suiteRef?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    if (!suiteRef) {
      throw new PlatformError('admission_rejected', 'suiteRef is required', {
        hint: 'Eval runs are only meaningful relative to the suite that produced them',
      });
    }
    return { runs: await this.evals.history(suiteRef, Math.min(Number(limit) || 20, 100)) };
  }

  @Doc({
    summary: 'Read one eval run',
  })
  @Get('runs/:evalRunId')
  async evalRun(@Param('evalRunId') evalRunId: string): Promise<unknown> {
    return this.evals.evalRun(evalRunId);
  }

  @Doc({
    summary: 'Read an eval run\'s results',
    description:
      'Includes variance across trials: a single-trial score cannot tell an improvement from noise.',
  })
  @Get('runs/:evalRunId/results')
  async results(@Param('evalRunId') evalRunId: string): Promise<unknown> {
    return { cases: await this.evals.caseResults(evalRunId) };
  }
}
