import { Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import { ReplayService } from '../../domain/run-engine/replay.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';

const replayBody = z.object({
  runId: z.string().uuid(),
  /** Replay only up to this event, for bisecting where a run went wrong. */
  throughSeq: z.number().int().nonnegative().optional(),
});

/**
 * §0.2 replay, offered rather than only exercised in CI.
 *
 * POST rather than GET: replaying a long log is real work and takes a body, and a GET
 * that people cache or prefetch is the wrong shape for it. It is nonetheless a pure read
 * -- nothing executes, nothing is written (see ReplayService).
 */
@Controller('v1/replay')
export class ReplayController {
  constructor(private readonly replay: ReplayService) {}

  @Post()
  async run(@Body() body: unknown): Promise<unknown> {
    const parsed = replayBody.safeParse(body ?? {});
    if (!parsed.success) {
      throw new PlatformError('admission_rejected', 'Malformed replay request', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    return this.replay.replay(parsed.data.runId, parsed.data.throughSeq);
  }
}
