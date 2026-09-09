import { Controller, Get, Param, Query } from '@nestjs/common';
import { CatalogService } from '../../domain/registry/catalog.service.js';
import { Doc } from '../openapi/api-doc.decorator.js';

/**
 * The agent catalog (§17.6): a read-only discovery surface over agents, tools, MCP
 * servers, models, prompts and skills. Every route here derives its answer from the
 * owning registry -- there is nothing to publish or version at this address.
 */
@Controller('v1/catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Doc({ summary: 'Catalog overview: what this caller may bind and route to' })
  @Get()
  async overview(): Promise<unknown> {
    return this.catalog.overview();
  }

  @Doc({ summary: 'List agents visible to this caller' })
  @Get('agents')
  async agents(@Query('q') q?: string): Promise<unknown> {
    return { agents: await this.catalog.agents(q ? { q } : undefined) };
  }

  @Doc({ summary: 'Read one agent\'s catalog entry' })
  @Get('agents/:name')
  async agent(@Param('name') name: string): Promise<unknown> {
    return this.catalog.agent(name);
  }

  @Doc({
    summary: 'List bindable tools and their effect contracts',
    description:
      'The effects declared here are what the platform enforces at call time (§8).',
  })
  @Get('tools')
  async tools(): Promise<unknown> {
    return { tools: await this.catalog.tools() };
  }

  @Doc({ summary: 'List routable models and their residency' })
  @Get('models')
  async models(): Promise<unknown> {
    return { models: await this.catalog.models() };
  }
}
