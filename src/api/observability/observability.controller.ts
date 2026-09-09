import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { TraceService } from '../../domain/observability/trace.service.js';
import { AnalyticsService } from '../../domain/observability/analytics.service.js';
import { FeedbackService } from '../../domain/observability/feedback.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';
import { Doc } from '../openapi/api-doc.decorator.js';
import { ApiTags } from '@nestjs/swagger';

const feedbackBody = z
  .object({
    runId: z.string().uuid().nullish(),
    threadId: z.string().uuid().nullish(),
    interactionId: z.string().uuid().nullish(),
    // -1 is an explicit thumbs-down; 0..5 a scale. Both are useful and they are not the
    // same signal, which is why the column allows -1 rather than folding it into 0.
    rating: z.number().int().min(-1).max(5).nullish(),
    label: z.string().max(60).nullish(),
    comment: z.string().max(4_000).nullish(),
    correction: z.record(z.string(), z.unknown()).nullish(),
  })
  .refine((f) => Boolean(f.runId || f.threadId), {
    message: 'runId or threadId is required',
  });

const window = (hours?: string, agent?: string) => ({
  sinceHours: hours ? Math.min(Math.max(Number(hours), 1), 24 * 90) : undefined,
  agentName: agent,
});

@ApiTags('observability')
@Controller('v1')
export class ObservabilityController {
  constructor(
    private readonly traces: TraceService,
    private readonly analytics: AnalyticsService,
    private readonly feedback: FeedbackService,
  ) {}

  // ---- §15.2 traces -------------------------------------------------------

  @Doc({ summary: 'Read a run\'s trace' })
  @Get('runs/:id/trace')
  async runTrace(@Param('id') id: string): Promise<unknown> {
    return this.traces.forRun(id);
  }

  @Doc({ summary: 'Read one trace by id' })
  @Get('traces/:traceId')
  async trace(@Param('traceId') traceId: string): Promise<unknown> {
    return this.traces.forTraceId(traceId);
  }

  /** A whole conversation, turn by turn — the chatbot view. */
  @Doc({ summary: 'Read a thread\'s trace' })
  @Get('threads/:id/trace')
  async threadTrace(@Param('id') id: string): Promise<unknown> {
    return this.traces.forThread(id);
  }

  // ---- §15.3 lineage ------------------------------------------------------

  @Doc({ summary: 'Trace lineage for any entity' })
  @Get('lineage/:kind/:id')
  async lineage(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Query('depth') depth?: string,
  ): Promise<unknown> {
    return this.traces.lineage(kind, id, Number(depth ?? 3) || 3);
  }

  // ---- §15.5 analytics ----------------------------------------------------

  @Doc({ summary: 'Per-version analytics' })
  @Get('analytics/versions')
  async versions(@Query('hours') hours?: string, @Query('agent') agent?: string): Promise<unknown> {
    return { versions: await this.analytics.byVersion(window(hours, agent)) };
  }

  @Doc({ summary: 'Latency analytics' })
  @Get('analytics/latency')
  async latency(@Query('hours') hours?: string): Promise<unknown> {
    return this.analytics.latencyBreakdown(window(hours));
  }

  @Doc({ summary: 'Tool-usage analytics' })
  @Get('analytics/tools')
  async tools(@Query('hours') hours?: string): Promise<unknown> {
    return { tools: await this.analytics.toolHealth(window(hours)) };
  }

  @Doc({ summary: 'Memory analytics' })
  @Get('analytics/memory')
  async memory(@Query('hours') hours?: string): Promise<unknown> {
    return this.analytics.memoryEffectiveness(window(hours));
  }

  @Doc({ summary: 'Interaction analytics' })
  @Get('analytics/interactions')
  async interactions(@Query('hours') hours?: string): Promise<unknown> {
    return { interactions: await this.analytics.interactionHealth(window(hours)) };
  }

  // ---- §15.5 feedback -----------------------------------------------------

  @Doc({ summary: 'Submit feedback on a run' })
  @Post('feedback')
  async submit(@Body() body: unknown): Promise<unknown> {
    const parsed = feedbackBody.safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed feedback', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    return this.feedback.submit(parsed.data);
  }

  @Doc({ summary: 'List feedback' })
  @Get('feedback')
  async listFeedback(
    @Query('runId') runId?: string,
    @Query('threadId') threadId?: string,
  ): Promise<unknown> {
    return { feedback: await this.feedback.list({ runId, threadId }) };
  }

  @Doc({ summary: 'Summarise feedback' })
  @Get('feedback/summary')
  async feedbackSummary(@Query('hours') hours?: string): Promise<unknown> {
    return { summary: await this.feedback.summary(Number(hours ?? 168) || 168) };
  }
}
