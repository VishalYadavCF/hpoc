import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { PolicyService } from '../src/domain/policy/policy.service.js';
import { PromptService } from '../src/domain/prompt/prompt.service.js';
import { SkillService } from '../src/domain/skills/skill.service.js';
import { PeerService } from '../src/domain/peer/peer.service.js';
import { AdmissionService } from '../src/domain/admission/admission.service.js';
import { AgentVersionService } from '../src/domain/registry/agent-version.service.js';
import { enforcePolicy, policyDocumentSchema } from '../src/domain/policy/policy-document.js';
import { AdmissionRejected } from '../src/domain/errors/platform.errors.js';
import { runInContext } from '../src/platform/context/platform-context.js';
import { fixture, type Fixture } from './fixtures.js';

let f: Fixture;
let policies: PolicyService;
let admission: AdmissionService;
let versions: AgentVersionService;

const SUFFIX = Math.random().toString(36).slice(2, 8);
const POLICY = `regulated-${SUFFIX}`;
const TOOL = `policy.tool-${SUFFIX}`;
let toolId: string;

const ctx = <T>(fn: () => Promise<T>): Promise<T> =>
  runInContext(
    {
      orgId: f.orgId, namespaceId: f.namespaceId, tenantRef: f.tenantRef,
      callerPrincipalId: f.principalId, onBehalfOfPrincipalId: null,
      authorizingHumanId: null, delegationChain: [],
      traceId: `policy-${SUFFIX}`, correlationId: `policy-${SUFFIX}`,
    },
    fn,
  );

const admit = (over: Record<string, unknown> = {}) =>
  admission.admit({
    orgId: f.orgId,
    namespaceId: f.namespaceId,
    callerPrincipalId: f.principalId,
    rawSpec: { framework: 'echo', model: { ref: 'internal/echo' }, ...over },
  });

/** Publishes and approves in one step, since most cases care about enforcement not gating. */
const live = async (document: unknown, ref = POLICY): Promise<number> => {
  const published = await ctx(() => policies.publish({ ref, owner: 'policy-tests', document }));
  await ctx(() => policies.approve(ref, published.version));
  return published.version;
};

beforeAll(async () => {
  f = await fixture();
  const uow = new UnitOfWork(f.db);
  policies = new PolicyService(f.db, uow);
  admission = new AdmissionService(
    f.db, new SkillService(f.db, uow), new PeerService(f.db),
    new PromptService(f.db, uow), policies,
  );
  versions = new AgentVersionService(f.db);

  const tool = await f.db
    .insertInto('tools')
    .values({
      org_id: f.orgId, namespace_id: f.namespaceId, ref: TOOL,
      origin: 'http', residency: 'internal', description: 'Policy test tool',
      input_schema: JSON.stringify({ type: 'object' }),
      default_effects: ['read_only'], sandbox_profile: 'http-egress',
      endpoint_url: 'http://127.0.0.1:9/never', timeout_ms: 1_000,
    })
    .returning('id').executeTakeFirstOrThrow();
  toolId = tool.id;
  await f.db.insertInto('capability_grants').values({
    org_id: f.orgId, grant_source: 'service', namespace_id: f.namespaceId,
    resource_kind: 'tool', resource_id: toolId, granted_by: f.principalId,
  }).execute();
});

afterAll(async () => {
  if (!f) return;
  // `agent_versions.policy_version_id` is ON DELETE RESTRICT, which is the correct rule --
  // a policy version an agent pins must not vanish underneath it -- so teardown unpins
  // before it can clean up, exactly as the prompt tests do.
  const ids = (
    await f.db.selectFrom('policies').select('id').where('org_id', '=', f.orgId)
      .where('ref', 'like', `%${SUFFIX}%`).execute()
  ).map((r) => r.id);
  if (ids.length) {
    const versionIds = (
      await f.db.selectFrom('policy_versions').select('id').where('policy_id', 'in', ids).execute()
    ).map((r) => r.id);
    if (versionIds.length) {
      await f.db.deleteFrom('agent_versions').where('policy_version_id', 'in', versionIds).execute();
    }
    await f.db.deleteFrom('policy_versions').where('policy_id', 'in', ids).execute();
    await f.db.deleteFrom('policies').where('id', 'in', ids).execute();
  }
  await f.db.deleteFrom('capability_grants').where('resource_id', '=', toolId).execute();
  await f.db.deleteFrom('tools').where('id', '=', toolId).execute();
  await f.close();
});

describe('policy document (§17.3) — pure enforcement', () => {
  const doc = (over: Record<string, unknown> = {}) => policyDocumentSchema.parse(over);
  const subject = (over: Record<string, unknown> = {}) => ({
    modelRef: 'internal/echo', modelResidency: 'internal' as const,
    tools: [] as string[], peers: [] as { name: string; residency: 'internal' | 'external' }[],
    subAgents: [] as string[], maxCostMicros: null as number | null,
    ...over,
  });

  it('a policy narrows and never widens — deny beats allow', () => {
    // The control someone reaches for during an incident must not be defeatable by also
    // appearing on an allowlist.
    const verdict = enforcePolicy(
      doc({ tools: { allow: ['a.tool'], deny: ['a.tool'] } }),
      subject({ tools: ['a.tool'] }),
    );
    expect(verdict.rejections.join()).toMatch(/denied by policy/);
  });

  it('takes the MINIMUM of the spec and policy cost ceilings', () => {
    expect(enforcePolicy(doc({ maxCostMicros: 500 }), subject({ maxCostMicros: 9_000 })).effectiveMaxCostMicros).toBe(500);
    expect(enforcePolicy(doc({ maxCostMicros: 9_000 }), subject({ maxCostMicros: 500 })).effectiveMaxCostMicros).toBe(500);
    // An unbounded spec inherits the policy's bound rather than staying unbounded.
    expect(enforcePolicy(doc({ maxCostMicros: 500 }), subject({ maxCostMicros: null })).effectiveMaxCostMicros).toBe(500);
    expect(enforcePolicy(doc(), subject({ maxCostMicros: 500 })).effectiveMaxCostMicros).toBe(500);
  });

  it('refuses an external model and an external peer when residency is internal (§16.1)', () => {
    const verdict = enforcePolicy(
      doc({ residency: 'internal' }),
      subject({
        modelRef: 'vendor/gpt', modelResidency: 'external',
        peers: [{ name: 'partner', residency: 'external' }],
      }),
    );
    expect(verdict.rejections).toHaveLength(2);
    expect(verdict.rejections.join()).toMatch(/§16.1/);
  });

  it('only forces approval for tools the spec actually names', () => {
    // A shared policy lists tools many agents never use; flagging absent ones would make
    // it unusable across agents.
    const verdict = enforcePolicy(
      doc({ requireApprovalFor: ['pay.send', 'refund.start'] }),
      subject({ tools: ['pay.send'] }),
    );
    expect(verdict.approvalRequired).toEqual(['pay.send']);
    expect(verdict.rejections).toEqual([]);
  });

  it('collects every violation rather than stopping at the first', () => {
    const verdict = enforcePolicy(
      doc({ tools: { allow: [], deny: [] }, allowSubAgents: false }),
      subject({ tools: ['a', 'b'], subAgents: ['helper'] }),
    );
    expect(verdict.rejections.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects an unknown key rather than ignoring it', () => {
    // A typo in a security document must fail at publish, not be silently dropped.
    expect(() => policyDocumentSchema.parse({ denyy: ['x'] })).toThrow();
  });
});

describe('policy registry (§17.3) — versioning and approval', () => {
  it('republishing an identical document reuses the version', async () => {
    const first = await ctx(() => policies.publish({ ref: POLICY, owner: 'o', document: { maxCostMicros: 100 } }));
    const again = await ctx(() => policies.publish({ ref: POLICY, owner: 'o', document: { maxCostMicros: 100 } }));
    expect(again.reused).toBe(true);
    expect(again.version).toBe(first.version);
  });

  it('is content-addressed after defaults are applied, not before', async () => {
    // `{}` and a document spelling out every default mean the same thing and must not be
    // two versions.
    const bare = await ctx(() => policies.publish({ ref: `defaults-${SUFFIX}`, owner: 'o', document: {} }));
    const spelled = await ctx(() => policies.publish({
      ref: `defaults-${SUFFIX}`, owner: 'o',
      document: { tools: { allow: null, deny: [] }, allowSubAgents: true },
    }));
    expect(spelled.reused).toBe(true);
    expect(spelled.version).toBe(bare.version);
  });

  it('a bare name resolves only to an APPROVED version', async () => {
    const ref = `gated-${SUFFIX}`;
    const draft = await ctx(() => policies.publish({ ref, owner: 'o', document: { maxCostMicros: 1 } }));

    const byName = await ctx(() => policies.resolve([ref]));
    expect(byName.resolved).toEqual([]);
    expect(byName.rejections.join()).toMatch(/no APPROVED version/);

    // A pin reaches the draft, so it is testable without being shippable by name.
    const pinned = await ctx(() => policies.resolve([`${ref}@${draft.version}`]));
    expect(pinned.resolved[0]?.version).toBe(draft.version);
    expect(pinned.resolved[0]?.approved).toBe(false);

    await ctx(() => policies.approve(ref, draft.version));
    expect((await ctx(() => policies.resolve([ref]))).resolved[0]?.approved).toBe(true);
  });
});

describe('policy enforcement at admission (§17.5)', () => {
  it('refuses a spec that violates its policy, naming the reason', async () => {
    await live({ tools: { allow: [], deny: [TOOL] } });

    const error = await ctx(() => admit({ tools: [TOOL], policyRef: POLICY })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdmissionRejected);
    expect((error as AdmissionRejected).rejections.join()).toMatch(new RegExp(`policy: tool "${TOOL}" is denied`));
  });

  it('admits the same spec once the policy allows it, and pins the version', async () => {
    const ref = `permissive-${SUFFIX}`;
    const version = await live({ tools: { allow: [TOOL], deny: [] } }, ref);

    const result = await ctx(() => admit({ tools: [TOOL], policyRef: ref }));
    expect(result.policy?.ref).toBe(ref);
    expect(result.policy?.version).toBe(version);
  });

  it('narrows the stored cost ceiling to the policy’s, not the spec’s', async () => {
    const ref = `cheap-${SUFFIX}`;
    await live({ maxCostMicros: 250 }, ref);

    const admitted = await ctx(() => admit({
      policyRef: ref,
      systemPrompt: `cost-${SUFFIX}`,
      execution: { durability: 'strict', limits: { maxSteps: 50, maxCostMicros: 9_000 } },
    }));
    expect(admitted.effectiveMaxCostMicros).toBe(250);

    // And the narrowed number is what the run engine will actually read off the version.
    const version = await ctx(() => new UnitOfWork(f.db).run((tx) =>
      versions.materialiseEphemeral({
        tx, orgId: f.orgId, namespaceId: f.namespaceId,
        workloadIdentityId: f.principalId, admission: admitted,
      }),
    ));
    expect(version.maxCostMicros).toBe('250');
  });

  it('reports the policy violation alongside unrelated ones, in one round trip', async () => {
    const ref = `strict-${SUFFIX}`;
    await live({ tools: { allow: [], deny: [TOOL] } }, ref);

    const error = await ctx(() => admit({
      tools: [TOOL, 'no.such.tool'],
      policyRef: ref,
    })).catch((e: unknown) => e);

    const reasons = (error as AdmissionRejected).rejections.join('\n');
    // §17.5 collects: the author sees the missing tool AND the policy denial together.
    expect(reasons).toMatch(/no.such.tool/);
    expect(reasons).toMatch(/denied by policy/);
  });

  it('names an unresolvable policy rather than admitting without one', async () => {
    // Silently ignoring a policyRef that does not resolve would be the worst outcome: the
    // agent runs believing it is constrained.
    const error = await ctx(() => admit({ policyRef: `absent-${SUFFIX}` })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdmissionRejected);
    expect((error as AdmissionRejected).rejections.join()).toMatch(/has no APPROVED version/);
  });
});
