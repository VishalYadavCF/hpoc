import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { MCP_CLIENT, type McpClient, type McpServerRef } from '../ports/mcp-client.port.js';
import { CapabilityDenied, NotFound, PlatformError } from '../errors/platform.errors.js';

export interface DiscoveredTool {
  name: string;
  definitionHash: string;
  status: 'new' | 'unchanged' | 'changed';
  approved: boolean;
}

/**
 * §13.2. Tool definitions are untrusted text entering the context window, from systems
 * outside our control — the highest-severity surface in the design.
 *
 * Three rules, all enforced here rather than documented:
 *
 *  1. **Definitions are pinned by content hash.** A server that passes review and mutates
 *     afterwards fails closed and needs re-approval. This is the defence the whole section
 *     is built around.
 *  2. **Approval is tenant-scoped.** Bound by one team does not mean available to another.
 *  3. **No token passthrough.** Headers are minted by the broker per call; nothing here
 *     ever holds a server credential.
 */
@Injectable()
export class McpRegistryService {
  private readonly log = new Logger(McpRegistryService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MCP_CLIENT) private readonly client: McpClient,
  ) {}

  async register(input: {
    name: string;
    endpointUrl?: string | null;
    /** stdio only. Registry-supplied; a spec can never name a command (§18.5). */
    command?: string[] | null;
    protocolRevision: string;
    residency: 'internal' | 'external';
    rateLimitQps?: number | null;
  }) {
    const ctx = requireContext();
    // "latest" is not a revision. Pinning a dated one is what makes a breaking transport
    // change a deliberate upgrade rather than an outage (§13.1).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.protocolRevision)) {
      throw new PlatformError('admission_rejected', 'protocolRevision must be a dated revision', {
        got: input.protocolRevision,
      });
    }
    if (!input.endpointUrl && !input.command?.length) {
      throw new PlatformError('admission_rejected', 'Give either an endpointUrl or a command', {});
    }
    const transport = input.command?.length ? 'stdio' : 'streamable_http';

    return this.db
      .insertInto('mcp_servers')
      .values({
        org_id: ctx.orgId,
        namespace_id: ctx.namespaceId,
        name: input.name,
        mcp_transport: transport,
        endpoint_url: input.endpointUrl ?? null,
        command: input.command ?? null,
        protocol_revision: input.protocolRevision,
        residency: input.residency,
        rate_limit_qps: input.rateLimitQps ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'name']).doUpdateSet({
          endpoint_url: input.endpointUrl ?? null,
          command: input.command ?? null,
          mcp_transport: transport,
          protocol_revision: input.protocolRevision,
        }),
      )
      .returning(['id', 'name', 'protocol_revision', 'residency'])
      .executeTakeFirstOrThrow();
  }

  async list() {
    const ctx = requireContext();
    return this.db
      .selectFrom('mcp_servers')
      .select(['id', 'name', 'endpoint_url', 'protocol_revision', 'residency', 'status', 'allow_sampling'])
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .execute();
  }

  /**
   * Re-discovers a server's tools and diffs them against what was approved.
   *
   * A changed definition is recorded as a NEW row and the old one superseded — the
   * history of what a server claimed is itself evidence. Nothing is auto-approved: a
   * server that silently rewrites a tool's description is the attack this exists to catch.
   */
  async refresh(serverId: string): Promise<DiscoveredTool[]> {
    const server = await this.server(serverId);
    const discovered = await this.client.listTools(await this.toRef(server));

    const known = await this.db
      .selectFrom('mcp_server_tools')
      .select(['tool_name', 'definition_hash', 'approved_at', 'superseded_at'])
      .where('mcp_server_id', '=', serverId)
      .execute();
    const approvedHash = new Map(
      known.filter((k) => k.approved_at && !k.superseded_at).map((k) => [k.tool_name, k.definition_hash]),
    );

    const out: DiscoveredTool[] = [];
    for (const tool of discovered) {
      const previous = approvedHash.get(tool.name);
      const status: DiscoveredTool['status'] =
        previous === undefined ? 'new' : previous === tool.definitionHash ? 'unchanged' : 'changed';

      if (status === 'changed') {
        this.log.warn(
          `MCP server ${server.name} changed the definition of "${tool.name}" — failing closed`,
        );
        await this.db
          .updateTable('mcp_server_tools')
          .set({ superseded_at: sql`now()` })
          .where('mcp_server_id', '=', serverId)
          .where('tool_name', '=', tool.name)
          .where('superseded_at', 'is', null)
          .execute();
        // The tool row is disabled immediately: an agent must not keep calling a
        // definition nobody has reviewed.
        await this.db
          .updateTable('tools')
          .set({ status: 'disabled' })
          .where('mcp_server_id', '=', serverId)
          .where('mcp_tool_name', '=', tool.name)
          .execute();
      }

      if (status !== 'unchanged') {
        await this.db
          .insertInto('mcp_server_tools')
          .values({
            mcp_server_id: serverId,
            tool_name: tool.name,
            definition_hash: tool.definitionHash,
            definition: JSON.stringify({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            }),
          })
          .onConflict((oc) =>
            oc.columns(['mcp_server_id', 'tool_name', 'definition_hash']).doNothing(),
          )
          .execute();
      }

      out.push({
        name: tool.name,
        definitionHash: tool.definitionHash,
        status,
        approved: status === 'unchanged',
      });
    }
    return out;
  }

  /**
   * Approves one definition hash and materialises a bindable tool.
   *
   * The hash is part of the approval, so approving "the tool called search" is not
   * possible — only "this exact definition of search".
   */
  async approveTool(serverId: string, toolName: string, definitionHash: string) {
    const ctx = requireContext();
    const server = await this.server(serverId);

    const definition = await this.db
      .selectFrom('mcp_server_tools')
      .select(['id', 'definition'])
      .where('mcp_server_id', '=', serverId)
      .where('tool_name', '=', toolName)
      .where('definition_hash', '=', definitionHash)
      .executeTakeFirst();
    if (!definition) throw new NotFound('mcp tool definition', `${toolName}@${definitionHash}`);

    await this.db
      .updateTable('mcp_server_tools')
      .set({ approved_by: ctx.callerPrincipalId, approved_at: sql`now()`, superseded_at: null })
      .where('id', '=', definition.id)
      .execute();

    const spec = definition.definition as { description?: string; inputSchema?: unknown };
    // §13.2's namespacing: an MCP tool is never confusable with a native one.
    const ref = `mcp__${server.name}__${toolName}`;

    const tool = await this.db
      .insertInto('tools')
      .values({
        org_id: ctx.orgId,
        namespace_id: ctx.namespaceId,
        ref,
        origin: 'mcp',
        residency: server.residency,
        description: spec.description ?? null,
        input_schema: JSON.stringify(spec.inputSchema ?? { type: 'object' }),
        // Output is untrusted input (§13.2) and the tool is not assumed safe to repeat.
        // `read_only` would be a claim about someone else's server.
        default_effects: ['non_idempotent'],
        sandbox_profile: 'mcp',
        mcp_server_id: serverId,
        mcp_tool_name: toolName,
        definition_hash: definitionHash,
        timeout_ms: 30_000,
        status: 'active',
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'ref', 'version']).doUpdateSet({
          definition_hash: definitionHash,
          status: 'active',
          input_schema: JSON.stringify(spec.inputSchema ?? { type: 'object' }),
        }),
      )
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();

    // Approving a definition (§13.2) and granting capability (§16.2) are distinct acts,
    // done together here because both are namespace-scoped operator decisions made with
    // the caller's own authority. Without the grant the tool exists but admission refuses
    // every spec naming it, which reads as the approval silently not working.
    const granted = await this.db
      .selectFrom('capability_grants')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('resource_kind', '=', 'tool')
      .where('resource_id', '=', tool.id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    if (!granted) {
      await this.db
        .insertInto('capability_grants')
        .values({
          org_id: ctx.orgId,
          grant_source: 'service',
          namespace_id: ctx.namespaceId,
          resource_kind: 'tool',
          resource_id: tool.id,
          granted_by: ctx.callerPrincipalId,
        })
        .execute();
    }

    return { toolId: tool.id, ref: tool.ref, definitionHash };
  }

  /** §13.2: bound by one team ≠ available to another. */
  async approveForTenant(serverId: string, tenantRef: string | null) {
    const ctx = requireContext();
    await this.server(serverId);
    return this.db
      .insertInto('mcp_server_approvals')
      .values({
        mcp_server_id: serverId,
        namespace_id: ctx.namespaceId,
        tenant_ref: tenantRef,
        approved_by: ctx.callerPrincipalId,
      })
      .onConflict((oc) =>
        oc.columns(['mcp_server_id', 'namespace_id', 'tenant_ref']).doUpdateSet({ revoked_at: null }),
      )
      .returning(['id', 'tenant_ref'])
      .executeTakeFirstOrThrow();
  }

  /**
   * Resolves a server for an invocation, verifying every gate.
   *
   * Called on the hot path deliberately: an approval revoked a minute ago must stop the
   * next call, not the next deploy.
   */
  async resolveForCall(
    serverId: string,
    toolName: string,
    pinnedHash: string | null,
    tenantRef: string,
    namespaceId: string,
  ): Promise<McpServerRef> {
    const server = await this.db
      .selectFrom('mcp_servers').selectAll().where('id', '=', serverId).executeTakeFirst();
    if (!server || server.status !== 'active') throw new NotFound('mcp server', serverId);

    const approval = await this.db
      .selectFrom('mcp_server_approvals')
      .select('id')
      .where('mcp_server_id', '=', serverId)
      .where('namespace_id', '=', namespaceId)
      .where('revoked_at', 'is', null)
      .where((eb) => eb.or([eb('tenant_ref', '=', tenantRef), eb('tenant_ref', 'is', null)]))
      .executeTakeFirst();
    if (!approval) throw new CapabilityDenied('mcp server approval', server.name);

    const current = await this.db
      .selectFrom('mcp_server_tools')
      .select(['definition_hash'])
      .where('mcp_server_id', '=', serverId)
      .where('tool_name', '=', toolName)
      .where('approved_at', 'is not', null)
      .where('superseded_at', 'is', null)
      .executeTakeFirst();

    if (!current) {
      throw new CapabilityDenied('approved mcp tool definition', `${server.name}/${toolName}`);
    }
    if (pinnedHash && current.definition_hash !== pinnedHash) {
      // Fail closed. The bound tool was approved against a definition that is no longer
      // the approved one.
      throw new PlatformError(
        'capability_denied',
        `MCP tool "${toolName}" no longer matches its approved definition`,
        { expected: pinnedHash, approved: current.definition_hash },
      );
    }

    return await this.toRef(server);
  }

  private async server(id: string) {
    const ctx = requireContext();
    const row = await this.db
      .selectFrom('mcp_servers')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('namespace_id', '=', ctx.namespaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFound('mcp server', id);
    return row;
  }

  private async toRef(server: {
    id: string; name: string; endpoint_url: string | null;
    command?: string[] | null; protocol_revision: string;
  }): Promise<McpServerRef> {
    if (!server.endpoint_url && !server.command?.length) {
      throw new PlatformError('upstream_failure', 'Server has neither an endpoint nor a command', {
        server: server.name,
      });
    }
    return {
      id: server.id,
      name: server.name,
      endpointUrl: server.endpoint_url ?? '',
      ...(server.command?.length ? { command: server.command } : {}),
      protocolRevision: server.protocol_revision,
      // Filled by the caller from the credential broker: this service never holds a secret.
      headers: {},
    };
  }
}
