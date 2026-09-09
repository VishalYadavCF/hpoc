import { Body, Controller, Param, Post } from '@nestjs/common';
import { TriggerService } from '../../domain/trigger/trigger.service.js';
import { Doc } from '../openapi/api-doc.decorator.js';

/**
 * Trigger ingress.
 *
 * Deliberately OUTSIDE the tenant-context middleware: an external caller has no reason to
 * know our identity headers. Tenancy comes from the trigger row instead, which is why
 * `triggers.tenant_ref` is required for an enabled trigger.
 *
 * Everything domain-shaped stays with the consuming service (§18.2). This turns a request
 * into a Run and nothing else.
 */
@Controller('v1/triggers')
export class TriggersController {
  constructor(private readonly triggers: TriggerService) {}

  @Doc({ summary: 'Inbound webhook. No identity headers — the trigger row carries tenancy.' })
  @Post('webhooks/:path')
  async webhook(@Param('path') path: string, @Body() body: unknown): Promise<unknown> {
    const trigger = await this.triggers.byWebhookPath(path);
    return this.triggers.fire(trigger, body ?? {}, 'trigger');
  }
}
