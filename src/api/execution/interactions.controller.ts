import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { InteractionService } from '../../domain/interaction/interaction.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';

const respondBody = z.object({
  approved: z.boolean(),
  response: z.record(z.string(), z.unknown()).optional(),
});

@Controller('v1/interactions')
export class InteractionsController {
  constructor(private readonly interactions: InteractionService) {}

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('mine') mine?: string,
  ): Promise<unknown> {
    return { interactions: await this.interactions.list(status, mine === 'true') };
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<unknown> {
    const row = await this.interactions.get(id);
    return {
      id: row.id,
      runId: row.run_id,
      threadId: row.thread_id,
      kind: row.kind,
      status: row.status,
      prompt: row.prompt,
      response: row.response,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }

  /** Answering resumes the run: it returns to the queue and a worker picks it up. */
  @Post(':id/respond')
  async respond(@Param('id') id: string, @Body() body: unknown): Promise<unknown> {
    const parsed = respondBody.safeParse(body);
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed response body', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    return this.interactions.respond({
      interactionId: id,
      approved: parsed.data.approved,
      response: parsed.data.response,
    });
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string): Promise<unknown> {
    await this.interactions.cancel(id);
    return { cancelled: true };
  }
}
