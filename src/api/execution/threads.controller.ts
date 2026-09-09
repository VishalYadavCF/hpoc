import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ThreadService } from '../../domain/thread/thread.service.js';
import { RunService } from '../../domain/run-engine/run.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { Doc } from '../openapi/api-doc.decorator.js';

const createThreadBody = z
  .object({
    title: z.string().max(200).optional(),
    externalRef: z.string().max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .default({});

const turnBody = z.object({
  agent: z.unknown(),
  input: z.unknown().optional(),
});

@Controller('v1/threads')
export class ThreadsController {
  constructor(
    private readonly threads: ThreadService,
    private readonly runs: RunService,
  ) {}

  @Doc({
    summary: 'Open a thread',
  })
  @Post()
  async create(@Body() body: unknown): Promise<unknown> {
    const parsed = createThreadBody.safeParse(body ?? {});
    if (!parsed.success) throw new PlatformError('admission_rejected', 'Malformed body');
    return this.threads.create(parsed.data);
  }

  @Doc({
    summary: 'List threads',
  })
  @Get()
  async list(): Promise<unknown> {
    return { threads: await this.threads.list() };
  }

  @Doc({
    summary: 'Read one thread',
  })
  @Get(':id')
  async get(@Param('id') id: string): Promise<unknown> {
    const t = await this.threads.get(id);
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      externalRef: t.external_ref,
      metadata: t.metadata,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    };
  }

  /**
   * The next conversational turn.
   *
   * A turn is a new RUN on an existing thread, not a message appended to one -- which is
   * exactly what §3's thread/run split buys: execution state resets, continuity does not.
   */
  @Doc({
    summary: 'Take a turn on a thread',
    description:
      'Starts a run whose transcript continues this thread (§3).',
    body: turnBody,
  })
  @Post(':id/runs')
  async turn(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<unknown> {
    const parsed = turnBody.safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed request body', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    await this.threads.get(id); // tenant-scoped existence check before admission
    return this.runs.create({
      spec: parsed.data.agent,
      input: parsed.data.input ?? null,
      threadId: id,
      idempotencyKey: idempotencyKey ?? null,
      workloadIdentityId: requireContext().callerPrincipalId,
    });
  }

  @Doc({
    summary: 'List the runs on a thread',
  })
  @Get(':id/runs')
  async runsOnThread(@Param('id') id: string): Promise<unknown> {
    return { runs: await this.threads.listRuns(id) };
  }

  @Doc({
    summary: 'Read the thread transcript',
    description:
      'Only DELIVERED content appears: a run that failed produced nothing the user received (§6.3).',
  })
  @Get(':id/messages')
  async messages(@Param('id') id: string): Promise<unknown> {
    return { messages: await this.threads.messages(id) };
  }

  @Doc({
    summary: 'Archive a thread',
  })
  @Post(':id/archive')
  async archive(@Param('id') id: string): Promise<unknown> {
    await this.threads.archive(id);
    return { archived: true };
  }
}
