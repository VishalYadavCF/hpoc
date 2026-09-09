import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdmissionService } from '../src/domain/admission/admission.service.js';
import { PolicyService } from '../src/domain/policy/policy.service.js';
import { PromptService } from '../src/domain/prompt/prompt.service.js';
import { SkillService } from '../src/domain/skills/skill.service.js';
import { PeerService } from '../src/domain/peer/peer.service.js';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { AdmissionRejected } from '../src/domain/errors/platform.errors.js';

/** The rejection strings, which is where admission puts the detail (§17.5). */
const rejectionsFrom = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (e) {
    if (e instanceof AdmissionRejected) return e.rejections.join(' | ');
    throw e;
  }
  throw new Error('expected admission to reject, but it admitted the spec');
};
import { sql } from 'kysely';
import { fixture, type Fixture } from './fixtures.js';

/**
 * §18.5 revisited: an inline spec may DEFINE an HTTP tool, not only select one.
 *
 * ap-executor's ai-agent node lets a workflow author pick any piece and action in the
 * node, with no registration step. Under refs-only there was no path for that at all,
 * which made the ephemeral path unusable by the consumer it was designed for.
 *
 * These tests are about the line that makes it safe: the spec supplies the SHAPE, the
 * template supplies the CONTRACT.
 */
let f: Fixture;
let admission: AdmissionService;
let templateId = '';

const SUFFIX = Math.random().toString(36).slice(2, 8);
const TEMPLATE = `relay.piece.${SUFFIX}`;

const input = (spec: unknown) => ({
  orgId: f.orgId,
  namespaceId: f.namespaceId,
  callerPrincipalId: f.principalId,
  rawSpec: spec,
});

const inlineTool = (over: Record<string, unknown> = {}) => ({
  template: TEMPLATE,
  name: `piece.slack_send_${SUFFIX}`,
  description: 'Send a Slack message through the executor',
  inputSchema: {
    type: 'object',
    properties: { channel: { type: 'string' }, text: { type: 'string' } },
    required: ['channel', 'text'],
  },
  pathTemplate: '/v1/pieces/slack/send-message',
  ...over,
});

const spec = (tools: unknown[]) => ({ model: { ref: 'internal/echo' }, tools });

beforeAll(async () => {
  f = await fixture();
  admission = new AdmissionService(
    f.db,
    new SkillService(f.db, new UnitOfWork(f.db)),
    new PeerService(f.db),
    new PromptService(f.db, new UnitOfWork(f.db)),
    new PolicyService(f.db, new UnitOfWork(f.db)),
  );

  const template = await f.db
    .insertInto('tool_templates')
    .values({
      org_id: f.orgId,
      namespace_id: f.namespaceId,
      ref: TEMPLATE,
      description: 'Any Relay piece action, executed through ap-executor',
      // The contract lives here and nowhere else.
      default_effects: sql`ARRAY['non_idempotent']::effect_class[]`,
      residency: 'internal',
      sandbox_profile: 'http-egress',
      endpoint_url: 'http://127.0.0.1:9999',
      allowed_methods: ['POST'],
      path_prefix: '/v1/pieces/',
      max_instances: 4,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  templateId = template.id;

  await f.db
    .insertInto('capability_grants')
    .values({
      org_id: f.orgId,
      grant_source: 'service',
      namespace_id: f.namespaceId,
      resource_kind: 'tool_template',
      resource_id: templateId,
      granted_by: f.principalId,
    })
    .execute();
});

afterAll(async () => {
  await f.db.deleteFrom('capability_grants').where('resource_id', '=', templateId).execute();
  await f.db.deleteFrom('tools').where('template_id', '=', templateId).execute();
  await f.db.deleteFrom('tool_templates').where('id', '=', templateId).execute();
  await f.close();
});

describe('an inline spec can define an HTTP tool (§18.5)', () => {
  it('instantiates a tool nobody registered', async () => {
    const result = await admission.admit(input(spec([inlineTool()])));

    expect(result.toolIds).toHaveLength(1);
    const row = await f.db
      .selectFrom('tools')
      .selectAll()
      .where('id', '=', result.toolIds[0]!.id)
      .executeTakeFirstOrThrow();

    // The shape came from the spec...
    expect(row.ref).toBe(`piece.slack_send_${SUFFIX}`);
    expect(row.path_template).toBe('/v1/pieces/slack/send-message');
    expect(row.http_method).toBe('POST');
    // ...and the contract, the origin and the isolation came from the template.
    expect(row.endpoint_url).toBe('http://127.0.0.1:9999');
    expect(row.sandbox_profile).toBe('http-egress');
    expect(row.template_id).toBe(templateId);
  });

  it('collapses an identical definition onto ONE row', async () => {
    const a = await admission.admit(input(spec([inlineTool()])));
    const b = await admission.admit(input(spec([inlineTool()])));

    // ap-executor issues the same node config on every workflow run. Without
    // content-addressing that is one tool row per run, and a catalogue nobody can read.
    expect(b.toolIds[0]!.id).toBe(a.toolIds[0]!.id);
  });

  it('treats a different shape as a different tool', async () => {
    const a = await admission.admit(input(spec([inlineTool()])));
    const b = await admission.admit(
      input(spec([inlineTool({ pathTemplate: '/v1/pieces/slack/update-message' })])),
    );
    expect(b.toolIds[0]!.id).not.toBe(a.toolIds[0]!.id);
  });

  it('mixes inline definitions and registry refs in one spec', async () => {
    const result = await admission.admit(input(spec(['demo.echo', inlineTool()])));
    expect(result.toolIds.map((t) => t.ref).sort()).toEqual(
      ['demo.echo', `piece.slack_send_${SUFFIX}`].sort(),
    );
  });
});

describe('the contract is the template\'s, never the caller\'s', () => {
  it('ignores effects a caller tries to declare', async () => {
    // `readOnly` would skip the §14 approval gate, permit caching under §10, and drop the
    // idempotency key §4.5 requires. The field simply does not exist in the schema, and
    // `whitelist` strips it -- so the attempt is not even visible downstream.
    const result = await admission.admit(
      input(spec([{ ...inlineTool(), effects: ['read_only', 'cacheable'] }])),
    );
    expect(result.toolIds[0]!.effects).toEqual(['non_idempotent']);
  });

  it('refuses a method the template does not allow', async () => {
    expect(await rejectionsFrom(admission.admit(input(spec([inlineTool({ method: 'DELETE' })]))))).toMatch(/does not allow/);
  });

  it('refuses a path outside the template prefix', async () => {
    // The prefix is the reachable surface. Without this an instantiation could point at
    // /v1/admin/ on the same host, which is precisely the widening §18.5 forbids.
    expect(await rejectionsFrom(admission.admit(input(spec([inlineTool({ pathTemplate: '/v1/admin/reset' })]))))).toMatch(/outside template/);
  });

  it('refuses an instantiation with no grant for the template', async () => {
    await f.db.deleteFrom('capability_grants').where('resource_id', '=', templateId).execute();
    expect(await rejectionsFrom(admission.admit(input(spec([inlineTool()]))))).toMatch(
      /no capability grant for tool template/,
    );

    await f.db
      .insertInto('capability_grants')
      .values({
        org_id: f.orgId, grant_source: 'service', namespace_id: f.namespaceId,
        resource_kind: 'tool_template', resource_id: templateId, granted_by: f.principalId,
      })
      .execute();
  });

  it('refuses an unknown template rather than inventing a contract for it', async () => {
    expect(
      await rejectionsFrom(admission.admit(input(spec([inlineTool({ template: 'no.such.template' })])))),
    ).toMatch(/no tool template/);
  });

  it('caps how many tools one spec may instantiate', async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      inlineTool({ name: `piece.many_${i}_${SUFFIX}`, pathTemplate: `/v1/pieces/p${i}` }),
    );
    // Four hundred tools in one context is an accuracy problem that gets blamed on the
    // model. The template says how many it is willing to be turned into.
    expect(await rejectionsFrom(admission.admit(input(spec(many))))).toMatch(/allows 4 inline tools/);
  });
});

describe('fixed arguments are bound, not suggested', () => {
  const fixed = () =>
    inlineTool({
      name: `piece.fixed_${SUFFIX}`,
      fixedArgs: { channel: '#ops-alerts' },
    });

  it('records them on the binding rather than in the schema', async () => {
    const result = await admission.admit(input(spec([fixed()])));
    expect(result.toolIds[0]!.fixedArgs).toEqual({ channel: '#ops-alerts' });
  });

  it('refuses a fixed argument the path template also expands', async () => {
    // The template expansion would win and the author would never find out.
    expect(
      await rejectionsFrom(
        admission.admit(
          input(
            spec([
              inlineTool({
                name: `piece.clash_${SUFFIX}`,
                pathTemplate: '/v1/pieces/{piece}/run',
                fixedArgs: { piece: 'slack' },
              }),
            ]),
          ),
        ),
      ),
    ).toMatch(/also expands/);
  });
});
