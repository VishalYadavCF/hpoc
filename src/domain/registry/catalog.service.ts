import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { NotFound } from '../errors/platform.errors.js';
import { PromptService } from '../prompt/prompt.service.js';
import { SkillService } from '../skills/skill.service.js';
import { McpRegistryService } from '../mcp/mcp-registry.service.js';

export interface CatalogAgentEntry {
  id: string;
  name: string;
  owner: string;
  description: string | null;
  exposedAsPeer: boolean;
  latestVersion: {
    id: string;
    version: number;
    modelRef: string | null;
    durability: string;
    dataClass: string;
  } | null;
  capabilities: {
    tools: string[];
    skills: string[];
    subAgents: string[];
    peers: string[];
    mcpServers: string[];
  };
}

/**
 * The agent catalog (§17.6).
 *
 * "A discoverable catalog of agents, tools, MCP servers, models, prompts, and
 * capabilities, derived from the canonical AgentSpec. No duplicate registration system
 * where metadata can be derived." So this reads the existing registries -- agents,
 * agent_versions and their bindings, tools, models -- and delegates to the prompt, skill
 * and MCP registries rather than re-querying their tables. Nothing here writes anything;
 * a catalog that could drift from what admission actually resolved would be worse than
 * no catalog.
 */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly prompts: PromptService,
    private readonly skills: SkillService,
    private readonly mcpRegistry: McpRegistryService,
  ) {}

  /**
   * Every non-archived agent in the namespace, with its latest version's capabilities
   * flattened out for search -- the whole point of a catalog over the registry tables
   * directly is that "what can this agent do" is one call, not a join per caller.
   */
  async agents(query?: { q?: string }): Promise<CatalogAgentEntry[]> {
    const ctx = requireContext();
    let q = this.db
      .selectFrom('agents')
      .select(['id', 'name', 'owner', 'description', 'expose_as_peer'])
      .where('namespace_id', '=', ctx.namespaceId)
      .where('archived_at', 'is', null);
    if (query?.q) {
      q = q.where('name', 'ilike', `%${query.q}%`);
    }
    const rows = await q.orderBy('name').execute();
    if (rows.length === 0) return [];

    return this.attachCapabilities(rows);
  }

  async agent(name: string): Promise<CatalogAgentEntry> {
    const ctx = requireContext();
    const row = await this.db
      .selectFrom('agents')
      .select(['id', 'name', 'owner', 'description', 'expose_as_peer'])
      .where('namespace_id', '=', ctx.namespaceId)
      .where('name', '=', name)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw new NotFound('agent', name);
    const [entry] = await this.attachCapabilities([row]);
    return entry!;
  }

  /**
   * Batches the latest-version lookup and every capability join across all the given
   * agents, rather than a query per agent -- a listing endpoint is exactly where an N+1
   * would show up first.
   */
  private async attachCapabilities(
    rows: { id: string; name: string; owner: string; description: string | null; expose_as_peer: boolean }[],
  ): Promise<CatalogAgentEntry[]> {
    const agentIds = rows.map((r) => r.id);

    // Latest version per agent. `agent_versions.version` is NULL for the ephemeral
    // lifetime, which registered agents never use, so ordering by it is unambiguous here.
    const versionRows = await this.db
      .selectFrom('agent_versions')
      .select(['id', 'agent_id', 'version', 'model_id', 'durability', 'data_class'])
      .where('agent_id', 'in', agentIds)
      .where('lifetime', '=', 'registered')
      .orderBy('agent_id')
      .orderBy('version', 'desc')
      .execute();
    const latestByAgent = new Map<string, (typeof versionRows)[number]>();
    for (const v of versionRows) {
      if (!latestByAgent.has(v.agent_id!)) latestByAgent.set(v.agent_id!, v);
    }

    const versionIds = [...latestByAgent.values()].map((v) => v.id);
    const modelIds = [...new Set([...latestByAgent.values()].map((v) => v.model_id))];

    const [models, tools, skillNames, subAgents, peers, mcpServers] = await Promise.all([
      modelIds.length
        ? this.db.selectFrom('models').select(['id', 'ref']).where('id', 'in', modelIds).execute()
        : Promise.resolve([]),
      versionIds.length
        ? this.db
            .selectFrom('agent_version_tools as avt')
            .innerJoin('tools as t', 't.id', 'avt.tool_id')
            .select(['avt.agent_version_id', 't.ref'])
            .where('avt.agent_version_id', 'in', versionIds)
            .execute()
        : Promise.resolve([]),
      versionIds.length
        ? this.db
            .selectFrom('agent_version_skills as avs')
            .innerJoin('skill_versions as sv', 'sv.id', 'avs.skill_version_id')
            .innerJoin('skills as sk', 'sk.id', 'sv.skill_id')
            .select(['avs.agent_version_id', 'sk.name'])
            .where('avs.agent_version_id', 'in', versionIds)
            .execute()
        : Promise.resolve([]),
      versionIds.length
        ? this.db
            .selectFrom('agent_version_sub_agents')
            .select(['agent_version_id', 'alias'])
            .where('agent_version_id', 'in', versionIds)
            .execute()
        : Promise.resolve([]),
      versionIds.length
        ? this.db
            .selectFrom('agent_version_peers')
            .select(['agent_version_id', 'alias'])
            .where('agent_version_id', 'in', versionIds)
            .execute()
        : Promise.resolve([]),
      versionIds.length
        ? this.db
            .selectFrom('agent_version_mcp_servers as avm')
            .innerJoin('mcp_servers as m', 'm.id', 'avm.mcp_server_id')
            .select(['avm.agent_version_id', 'm.name'])
            .where('avm.agent_version_id', 'in', versionIds)
            .execute()
        : Promise.resolve([]),
    ]);

    const modelRefById = new Map(models.map((m) => [m.id, m.ref]));
    const byVersion = <T extends { agent_version_id: string }>(list: T[]) => {
      const map = new Map<string, T[]>();
      for (const row of list) {
        const bucket = map.get(row.agent_version_id);
        if (bucket) bucket.push(row);
        else map.set(row.agent_version_id, [row]);
      }
      return map;
    };
    const toolsByVersion = byVersion(tools);
    const skillsByVersion = byVersion(skillNames);
    const subAgentsByVersion = byVersion(subAgents);
    const peersByVersion = byVersion(peers);
    const mcpByVersion = byVersion(mcpServers);

    return rows.map((agent) => {
      const latest = latestByAgent.get(agent.id) ?? null;
      return {
        id: agent.id,
        name: agent.name,
        owner: agent.owner,
        description: agent.description,
        exposedAsPeer: agent.expose_as_peer,
        latestVersion: latest
          ? {
              id: latest.id,
              version: latest.version!,
              modelRef: modelRefById.get(latest.model_id) ?? null,
              durability: latest.durability,
              dataClass: latest.data_class,
            }
          : null,
        capabilities: {
          tools: (toolsByVersion.get(latest?.id ?? '') ?? []).map((t) => t.ref),
          skills: (skillsByVersion.get(latest?.id ?? '') ?? []).map((s) => s.name),
          subAgents: (subAgentsByVersion.get(latest?.id ?? '') ?? []).map((s) => s.alias),
          peers: (peersByVersion.get(latest?.id ?? '') ?? []).map((p) => p.alias),
          mcpServers: (mcpByVersion.get(latest?.id ?? '') ?? []).map((m) => m.name),
        },
      };
    });
  }

  /** The unified tool registry (§8.1), scoped to the caller's namespace. */
  async tools() {
    const ctx = requireContext();
    return this.db
      .selectFrom('tools')
      .select(['id', 'ref', 'version', 'origin', 'residency', 'description', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('status', '=', 'active')
      .orderBy('ref')
      .execute();
  }

  /** The model registry (§9), org-scoped: models are not namespace-partitioned. */
  async models() {
    const ctx = requireContext();
    return this.db
      .selectFrom('models')
      .select(['id', 'ref', 'provider', 'residency', 'context_window_tokens', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('status', '=', 'active')
      .orderBy('ref')
      .execute();
  }

  /**
   * One discoverable snapshot across every kind §17.6 names. Each section delegates to
   * its owning registry rather than re-deriving it -- the catalog aggregates, it never
   * becomes a second source of truth for what a tool, prompt or skill is.
   */
  async overview() {
    const ctx = requireContext();
    const [agents, tools, models, mcpServers, prompts, skills] = await Promise.all([
      this.agents(),
      this.tools(),
      this.models(),
      this.mcpRegistry.list(),
      this.prompts.list(),
      this.skills.list(ctx.namespaceId),
    ]);

    return {
      agents: { count: agents.length, items: agents },
      tools: { count: tools.length, items: tools },
      models: { count: models.length, items: models },
      mcpServers: { count: mcpServers.length, items: mcpServers },
      prompts: { count: prompts.length, items: prompts },
      skills: { count: skills.length, items: skills },
    };
  }
}
