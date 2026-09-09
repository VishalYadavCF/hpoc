import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A self-hosted trace and feedback console.
 *
 * §16.1 Constraint 1 is absolute: prompts, conversations, tool calls and execution
 * metadata must not reach an external telemetry vendor. That rules out sending this data
 * to a hosted observability product, which in turn means the console has to live here.
 *
 * Served from the API process rather than built as a separate app on purpose: it reads the
 * same tenant-scoped routes any other client does, so it cannot see anything a caller
 * could not, and there is no second deployment to keep in step.
 */
@Controller('ui')
export class UiController {
  private readonly html = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'console.html'),
    'utf8',
  );

  // A served HTML page, not an API surface: listing it in the reference would put a
  // browser view among the endpoints a client integrates against.
  @ApiExcludeEndpoint()
  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  index(): string {
    return this.html;
  }
}
