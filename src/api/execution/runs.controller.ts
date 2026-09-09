import { Body, Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { RunService } from '../../domain/run-engine/run.service.js';
import { RunReadService } from '../../domain/run-engine/run-read.service.js';
import { RunRecoveryService } from '../../domain/run-engine/run-recovery.service.js';
import { RunStreamService } from '../streaming/run-stream.service.js';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { EventLog } from '../../domain/event-log/event-log.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { Doc } from '../openapi/api-doc.decorator.js';

const forkBody = z.object({
  checkpointId: z.string().uuid().optional(),
  atStepSeq: z.number().int().nonnegative().optional(),
  input: z.unknown().optional(),
  /** §4.2: a fork repeats every effect the original performed past the fork point. */
  acknowledgeDuplicateEffects: z.boolean().default(false),
});

const resumeBody = z.object({
  // Mandatory, and long enough to be a sentence. An operator resume is a manual override
  // of the platform's own recovery decision; an unexplained one is unauditable (§16.4).
  reason: z.string().min(10).max(1_000),
});

const createRunBody = z.object({
  agent: z.unknown(),
  input: z.unknown().optional(),
  threadId: z.string().uuid().nullish(),
  mode: z.enum(['async', 'sync']).default('async'),
  /**
   * Where to deliver the outcome when nobody is holding a connection (§18.4).
   *
   * The outbox row is written inside the run's terminal transaction, so a crash between
   * "the run completed" and "the caller was told" is impossible, and delivery carries an
   * `Idempotency-Key` so the receiver can deduplicate at-least-once sends.
   */
  delivery: z.object({ webhookUrl: z.url() }).nullish(),
});

@Controller('v1/runs')
export class RunsController {
  constructor(
    private readonly runs: RunService,
    private readonly stream: RunStreamService,
    private readonly events: EventLog,
    @Inject(DB) private readonly db: Db,
    private readonly reads: RunReadService,
    private readonly recovery: RunRecoveryService,
  ) {}

  /**
   * POST /v1/runs — inline spec, the ephemeral path (§18.1).
   *
   * `mode` is delivery, not durability: every run here is durable, and a `sync` client
   * that disconnects leaves the run executing and resumable by id (§18.4).
   */
  @Doc({
    summary: 'Start a run from an inline agent spec',
    description:
      'The ephemeral path (§18.1). `mode` is delivery, not durability: every run here is durable, and a `sync` client that disconnects leaves the run executing and resumable by id.',
    body: createRunBody,
  })
  @Post()
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<unknown> {
    const parsed = createRunBody.safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed request body', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const ctx = requireContext();

    const created = await this.runs.create({
      spec: parsed.data.agent,
      input: parsed.data.input ?? null,
      threadId: parsed.data.threadId ?? null,
      idempotencyKey: idempotencyKey ?? null,
      workloadIdentityId: ctx.callerPrincipalId,
      delivery: parsed.data.delivery ?? null,
    });

    if (parsed.data.mode === 'sync') {
      const settled = await this.stream.awaitTerminal(created.runId, 60_000);
      return { ...created, ...settled };
    }
    return created;
  }

  /**
   * Lists runs, keyset-paginated.
   *
   * Registered BEFORE `@Get(':id')`. Express matches in declaration order and `:id` is a
   * single segment, so ordering is not strictly load-bearing here — but the list is the
   * more general route and reads more naturally first.
   */
  @Doc({
    summary: 'List runs for this tenant',
  })
  @Get()
  async list(
    @Query('threadId') threadId?: string,
    @Query('agent') agentName?: string,
    @Query('agentVersionId') agentVersionId?: string,
    @Query('status') status?: string,
    @Query('initiator') initiator?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<unknown> {
    const parsedSince = since ? new Date(since) : undefined;
    if (parsedSince && Number.isNaN(parsedSince.getTime())) {
      // Refused rather than ignored: silently dropping an unparseable filter returns
      // more rows than the caller asked for, which they will not notice.
      throw new PlatformError('admission_rejected', `"since" is not a valid date: ${since}`);
    }
    return this.reads.list({
      ...(threadId ? { threadId } : {}),
      ...(agentName ? { agentName } : {}),
      ...(agentVersionId ? { agentVersionId } : {}),
      ...(status ? { status: status.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      ...(initiator ? { initiator } : {}),
      ...(parsedSince ? { since: parsedSince } : {}),
      limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
      ...(cursor ? { cursor } : {}),
    });
  }

  @Doc({
    summary: 'Read one run',
  })
  @Get(':id')
  async get(@Param('id') id: string): Promise<unknown> {
    const run = await this.runs.get(id);
    return {
      id: run.id,
      threadId: run.thread_id,
      agentVersionId: run.agent_version_id,
      status: run.status,
      input: run.input,
      output: run.output,
      error: run.error,
      stepCount: run.step_count,
      costMicros: Number(run.cost_micros),
      lastEventSeq: Number(run.last_event_seq),
      createdAt: run.created_at,
      endedAt: run.ended_at,
    };
  }

  @Doc({
    summary: 'List the steps a run took',
  })
  @Get(':id/steps')
  async steps(@Param('id') id: string): Promise<unknown> {
    return { steps: await this.runs.listSteps(id) };
  }

  @Doc({
    summary: 'Read the run\'s event log from a cursor',
    description:
      'Replayable history (§15.1). Use with `GET /events` to resume a stream without gaps.',
  })
  @Get(':id/events/history')
  async history(@Param('id') id: string): Promise<unknown> {
    await this.runs.get(id);
    return { events: await this.events.read(this.db, id, 0, 500) };
  }

  @Doc({
    summary: 'Cancel a run',
  })
  @Post(':id/cancel')
  async cancel(@Param('id') id: string): Promise<unknown> {
    await this.runs.cancel(id);
    return { cancelled: true };
  }

  /** SSE, with Last-Event-ID replay-then-tail (§12.1). */
  @Doc({
    summary: 'Stream run events over SSE',
    description:
      'Resumable: pass `Last-Event-ID` to continue where a dropped connection stopped.',
  })
  @Get(':id/events')
  async events_(
    @Param('id') id: string,
    @Res() res: Response,
    @Headers('last-event-id') lastEventId?: string,
  ): Promise<void> {
    await this.runs.get(id); // tenant-scoped: a run in another tenant is a 404, not a stream
    await this.stream.attach(id, res, Number(lastEventId ?? 0) || 0);
  }

  @Doc({
    summary: 'Read one step by sequence number',
  })
  @Get(':id/steps/:seq')
  async step(@Param('id') id: string, @Param('seq') seq: string): Promise<unknown> {
    const n = Number(seq);
    if (!Number.isInteger(n)) {
      throw new PlatformError('admission_rejected', `"${seq}" is not a step sequence number`);
    }
    return this.reads.step(id, n);
  }

  @Doc({
    summary: 'List the tool invocations a run made',
    description:
      'Every effect the run had, with its contract and idempotency key (§4.5).',
  })
  @Get(':id/tool-invocations')
  async toolInvocations(@Param('id') id: string): Promise<unknown> {
    return { toolInvocations: await this.reads.toolInvocations(id) };
  }

  @Doc({
    summary: 'List a run\'s checkpoints',
  })
  @Get(':id/checkpoints')
  async checkpoints(@Param('id') id: string): Promise<unknown> {
    return { checkpoints: await this.reads.checkpoints(id) };
  }

  @Doc({
    summary: 'Read one checkpoint',
  })
  @Get(':id/checkpoints/:checkpointId')
  async checkpoint(
    @Param('id') id: string,
    @Param('checkpointId') checkpointId: string,
  ): Promise<unknown> {
    return this.reads.checkpoint(id, checkpointId);
  }

  @Doc({
    summary: 'List approvals and questions raised by this run',
  })
  @Get(':id/interactions')
  async interactions(@Param('id') id: string): Promise<unknown> {
    return { interactions: await this.reads.interactions(id) };
  }

  @Doc({
    summary: 'List artifacts this run produced',
  })
  @Get(':id/artifacts')
  async artifacts(@Param('id') id: string): Promise<unknown> {
    return { artifacts: await this.reads.artifacts(id) };
  }

  @Doc({
    summary: 'List runs this run delegated to',
  })
  @Get(':id/children')
  async children(@Param('id') id: string): Promise<unknown> {
    return { children: await this.reads.children(id) };
  }

  @Doc({
    summary: 'Read the run\'s token and cost ledger',
  })
  @Get(':id/usage')
  async usage(@Param('id') id: string): Promise<unknown> {
    return this.reads.usage(id);
  }

  @Doc({
    summary: 'Trace this run\'s ancestry',
    description:
      'The full delegation chain, so the originating human survives every hop (§0.1).',
  })
  @Get(':id/lineage')
  async lineage(@Param('id') id: string): Promise<unknown> {
    return this.reads.lineage(id);
  }

  /**
   * What a fork here would duplicate, without forking (§4.2).
   *
   * Exists because the answer is the whole decision: a fork re-executes everything the
   * original did after the fork point, and a caller needs to see the side effects that
   * implies before authorising it.
   */
  @Doc({
    summary: 'Preview what forking this run would repeat',
    description:
      'Lists the effects a fork would perform a second time, before you commit to it.',
  })
  @Get(':id/fork')
  async previewFork(
    @Param('id') id: string,
    @Query('checkpointId') checkpointId?: string,
    @Query('atStepSeq') atStepSeq?: string,
  ): Promise<unknown> {
    return this.recovery.previewFork(id, {
      ...(checkpointId ? { checkpointId } : {}),
      ...(atStepSeq !== undefined ? { atStepSeq: Number(atStepSeq) } : {}),
    });
  }

  @Doc({
    summary: 'Fork a run from a checkpoint',
    description:
      '§4.2: a fork REPEATS every effect the original performed past the fork point, which is why the acknowledgement is required rather than assumed.',
    body: forkBody,
  })
  @Post(':id/fork')
  async fork(@Param('id') id: string, @Body() body: unknown): Promise<unknown> {
    const parsed = forkBody.safeParse(body ?? {});
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed fork request', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    return this.recovery.fork({
      runId: id,
      ...(parsed.data.checkpointId ? { checkpointId: parsed.data.checkpointId } : {}),
      ...(parsed.data.atStepSeq !== undefined ? { atStepSeq: parsed.data.atStepSeq } : {}),
      ...(parsed.data.input !== undefined ? { input: parsed.data.input } : {}),
      acknowledgeDuplicateEffects: parsed.data.acknowledgeDuplicateEffects,
    });
  }

  /** Operator resume of a run stuck in `waiting` or dead-lettered (§0.8). */
  @Doc({
    summary: 'Resume a dead-lettered run',
    description:
      'An operator override of the platform\'s own recovery decision. The reason is mandatory and audited (§16.4).',
    body: resumeBody,
  })
  @Post(':id/resume')
  async resume(@Param('id') id: string, @Body() body: unknown): Promise<unknown> {
    const parsed = resumeBody.safeParse(body ?? {});
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed resume request', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    return this.recovery.resume(id, parsed.data.reason);
  }
}
