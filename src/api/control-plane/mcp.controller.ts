import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { McpRegistryService } from '../../domain/mcp/mcp-registry.service.js';
import { PlatformError } from '../../domain/errors/platform.errors.js';
import { Doc } from '../openapi/api-doc.decorator.js';
import { ApiTags } from '@nestjs/swagger';

const registerBody = z.object({
  name: z.string().min(1).max(60).regex(/^[a-z0-9_-]+$/, 'lowercase, digits, _ or - only'),
  endpointUrl: z.url().nullish(),
  /** stdio transport. Registry-only by design: a spec naming a command would be RCE. */
  command: z.array(z.string().min(1)).min(1).max(16).nullish(),
  protocolRevision: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a dated revision, never "latest"'),
  residency: z.enum(['internal', 'external']),
  rateLimitQps: z.number().int().positive().nullish(),
});

const approveToolBody = z.object({
  toolName: z.string().min(1),
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
});

const approveTenantBody = z.object({ tenantRef: z.string().min(1).nullable() });

@ApiTags('mcp')
@Controller('v1/mcp/servers')
export class McpController {
  constructor(private readonly mcp: McpRegistryService) {}

  @Doc({
    summary: 'Register an MCP server',
    description:
      'The registry owns the endpoint and transport. A spec can never point a server at an arbitrary command (§18.5).',
    body: registerBody,
  })
  @Post()
  async register(@Body() body: unknown): Promise<unknown> {
    const parsed = registerBody.safeParse(body);
    if (!parsed.success) throw bad(parsed.error);
    return this.mcp.register(parsed.data);
  }

  @Doc({
    summary: 'List MCP servers and their tools',
  })
  @Get()
  async list(): Promise<unknown> {
    return { servers: await this.mcp.list() };
  }

  /** Re-discovers tools and reports which changed. Nothing is auto-approved. */
  @Doc({
    summary: 'Rediscover a server\'s tools',
    description:
      'Discovery is not approval: a rediscovered tool stays unapproved until someone approves its definition hash.',
  })
  @Post(':id/refresh')
  async refresh(@Param('id') id: string): Promise<unknown> {
    const tools = await this.mcp.refresh(id);
    return {
      tools,
      // A changed definition disables the bound tool immediately; surfacing the count
      // here means an operator sees it without reading logs.
      changed: tools.filter((t) => t.status === 'changed').length,
    };
  }

  @Doc({
    summary: 'Approve a tool\'s definition hash',
    description:
      '§13.2\'s pin. A server that rewrites the tool afterwards fails closed rather than running something nobody reviewed.',
    body: approveToolBody,
  })
  @Post(':id/tools/approve')
  async approveTool(@Param('id') id: string, @Body() body: unknown): Promise<unknown> {
    const parsed = approveToolBody.safeParse(body);
    if (!parsed.success) throw bad(parsed.error);
    return this.mcp.approveTool(id, parsed.data.toolName, parsed.data.definitionHash);
  }

  /** §13.2: approval is tenant-scoped. `null` means the whole namespace. */
  @Doc({
    summary: 'Approve a server for a tenant',
    body: approveTenantBody,
  })
  @Post(':id/approvals')
  async approveTenant(@Param('id') id: string, @Body() body: unknown): Promise<unknown> {
    const parsed = approveTenantBody.safeParse(body);
    if (!parsed.success) throw bad(parsed.error);
    return this.mcp.approveForTenant(id, parsed.data.tenantRef);
  }
}

const bad = (error: z.ZodError): PlatformError =>
  new PlatformError('admission_rejected', 'Malformed request', {
    issues: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  });
