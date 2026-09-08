import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { CatalogService } from '../src/domain/registry/catalog.service.js';
import { PolicyService } from '../src/domain/policy/policy.service.js';
import { AgentService } from '../src/domain/agent/agent.service.js';
import { AgentVersionService } from '../src/domain/registry/agent-version.service.js';
import { AdmissionService } from '../src/domain/admission/admission.service.js';
import { SkillService } from '../src/domain/skills/skill.service.js';
import { PeerService } from '../src/domain/peer/peer.service.js';
import { PromptService } from '../src/domain/prompt/prompt.service.js';
import { McpRegistryService } from '../src/domain/mcp/mcp-registry.service.js';
import { DeploymentService } from '../src/domain/eval/deployment.service.js';
import { NotFound } from '../src/domain/errors/platform.errors.js';
import { runInContext } from '../src/platform/context/platform-context.js';
import { fixture, type Fixture } from './fixtures.js';

let f: Fixture;
let catalog: CatalogService;
let agents: AgentService;

const SUFFIX = Math.random().toString(36).slice(2, 8);
const AGENT_NAME = `catalog-demo-${SUFFIX}`;
const TOOL_REF = `catalog.tool-${SUFFIX}`;

let toolId: string;

const ctx = <T>(fn: () => Promise<T>): Promise<T> =>
  runInContext(
    {
      orgId: f.orgId, namespaceId: f.namespaceId, tenantRef: f.tenantRef,
      callerPrincipalId: f.principalId, onBehalfOfPrincipalId: null,
      authorizingHumanId: null, delegationChain: [],
      traceId: `catalog-${SUFFIX}`, correlationId: `catalog-${SUFFIX}`,
    },
    fn,
  );

const grant = (kind: 'tool', id: string) =>
  f.db.insertInto('capability_grants').values({
    org_id: f.orgId, grant_source: 'service', namespace_id: f.namespaceId,
    resource_kind: kind, resource_id: id, granted_by: f.principalId,
  }).execute();

beforeAll(async () => {
  f = await fixture();
  const uow = new UnitOfWork(f.db);
  const skills = new SkillService(f.db, uow);
  const prompts = new PromptService(f.db, uow);
  const peers = new PeerService(f.db);
  const admission = new AdmissionService(f.db, skills, peers, prompts, new PolicyService(f.db, uow));
  const versions = new AgentVersionService(f.db);
  agents = new AgentService(f.db, uow, admission, versions, new DeploymentService(f.db, uow));
  const mcpRegistry = new McpRegistryService(f.db, {
    id: 'noop',
    listTools: async () => [],
    callTool: async () => {
      throw new Error('not used in this test');
    },
  });
  catalog = new CatalogService(f.db, prompts, skills, mcpRegistry);

  const tool = await f.db
    .insertInto('tools')
    .values({
      org_id: f.orgId, namespace_id: f.namespaceId, ref: TOOL_REF,
      origin: 'http', residency: 'internal', description: 'Catalog test tool',
      input_schema: JSON.stringify({ type: 'object' }),
      default_effects: ['read_only'], sandbox_profile: 'http-egress',
      endpoint_url: 'http://127.0.0.1:9/never', timeout_ms: 1_000,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  toolId = tool.id;
  await grant('tool', toolId);

  await ctx(() =>
    agents.publish({
      name: AGENT_NAME,
      owner: 'catalog-test',
      spec: { framework: 'echo', model: { ref: 'internal/echo' }, tools: [TOOL_REF] },
      exposeAsPeer: true,
    }),
  );
});

afterAll(async () => {
  await f.db.deleteFrom('agent_versions').where('namespace_id', '=', f.namespaceId)
    .where('spec_hash', 'like', '%').where('agent_id', 'is not', null)
    .where('agent_id', 'in', f.db.selectFrom('agents').select('id').where('name', '=', AGENT_NAME))
    .execute();
  await f.db.deleteFrom('agents').where('namespace_id', '=', f.namespaceId).where('name', '=', AGENT_NAME).execute();
  await f.db.deleteFrom('capability_grants').where('resource_id', '=', toolId).execute();
  await f.db.deleteFrom('tools').where('id', '=', toolId).execute();
  await f.close();
});

describe('agent catalog (§17.6)', () => {
  it('lists the agent with its tool capability derived from the latest version', async () => {
    const result = await ctx(() => catalog.agents({ q: AGENT_NAME }));
    expect(result).toHaveLength(1);
    const entry = result[0]!;
    expect(entry.name).toBe(AGENT_NAME);
    expect(entry.exposedAsPeer).toBe(true);
    expect(entry.latestVersion?.version).toBe(1);
    expect(entry.latestVersion?.modelRef).toBe('internal/echo');
    expect(entry.capabilities.tools).toEqual([TOOL_REF]);
  });

  it('fetches a single catalog entry by name', async () => {
    const entry = await ctx(() => catalog.agent(AGENT_NAME));
    expect(entry.capabilities.tools).toEqual([TOOL_REF]);
  });

  it('throws NotFound for an agent that does not exist', async () => {
    await expect(ctx(() => catalog.agent(`no-such-agent-${SUFFIX}`))).rejects.toBeInstanceOf(NotFound);
  });

  it('surfaces the tool through the tool registry section', async () => {
    const tools = await ctx(() => catalog.tools());
    expect(tools.map((t) => t.ref)).toContain(TOOL_REF);
  });

  it('the overview aggregates every §17.6 section', async () => {
    const overview = await ctx(() => catalog.overview());
    expect(overview.agents.items.map((a) => a.name)).toContain(AGENT_NAME);
    expect(overview.tools.items.map((t) => t.ref)).toContain(TOOL_REF);
    expect(overview.models.count).toBeGreaterThan(0);
  });
});
