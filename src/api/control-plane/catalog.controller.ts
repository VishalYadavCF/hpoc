import { Controller, Get, Param, Query } from '@nestjs/common';
import { CatalogService } from '../../domain/registry/catalog.service.js';

/**
 * The agent catalog (§17.6): a read-only discovery surface over agents, tools, MCP
 * servers, models, prompts and skills. Every route here derives its answer from the
 * owning registry -- there is nothing to publish or version at this address.
 */
@Controller('v1/catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  async overview(): Promise<unknown> {
    return this.catalog.overview();
  }

  @Get('agents')
  async agents(@Query('q') q?: string): Promise<unknown> {
    return { agents: await this.catalog.agents(q ? { q } : undefined) };
  }

  @Get('agents/:name')
  async agent(@Param('name') name: string): Promise<unknown> {
    return this.catalog.agent(name);
  }

  @Get('tools')
  async tools(): Promise<unknown> {
    return { tools: await this.catalog.tools() };
  }

  @Get('models')
  async models(): Promise<unknown> {
    return { models: await this.catalog.models() };
  }
}
