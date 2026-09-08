import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { EvalSuiteService } from '../src/domain/eval/suite.service.js';
import { DeploymentService } from '../src/domain/eval/deployment.service.js';
import { withMechanismDisabled } from '../src/domain/eval/mechanism-variant.js';
import { agentSpecSchema } from '../src/domain/registry/agent-spec.js';
import {
  BudgetGrader, ContainsGrader, ExactGrader, JsonPathGrader, NotContainsGrader, RegexGrader,
} from '../src/adapters/graders/deterministic.graders.js';
import { LlmJudgeGrader } from '../src/adapters/graders/llm-judge.grader.js';
import { GraderRegistryImpl } from '../src/adapters/graders/grader.registry.js';
import { AdmissionRejected, PlatformError } from '../src/domain/errors/platform.errors.js';
import { runInContext } from '../src/platform/context/platform-context.js';
import { fixture, type Fixture } from './fixtures.js';
import type { GradeInput } from '../src/domain/ports/grader.port.js';

let f: Fixture;
let suites: EvalSuiteService;
let deployments: DeploymentService;
let agentId: string;
let versionId: string;

const SUFFIX = Math.random().toString(36).slice(2, 8);
const AGENT = `eval-target-${SUFFIX}`;
const SUITE = `suite-${SUFFIX}`;

const completed = (over: Partial<GradeInput['observed']> = {}) => ({
  latencyMs: 100, costMicros: 50, status: 'completed', error: null, ...over,
});

/** Every service call needs the tenant context the middleware normally installs. */
const ctx = <T>(fn: () => Promise<T>): Promise<T> =>
  runInContext(
    {
      orgId: f.orgId,
      namespaceId: f.namespaceId,
      tenantRef: f.tenantRef,
      callerPrincipalId: f.principalId,
      onBehalfOfPrincipalId: null,
      authorizingHumanId: null,
      delegationChain: [],
      traceId: `eval-test-${SUFFIX}`,
      correlationId: `eval-test-${SUFFIX}`,
    },
    fn,
  );

beforeAll(async () => {
  f = await fixture();
  const uow = new UnitOfWork(f.db);
  suites = new EvalSuiteService(f.db, uow);
  deployments = new DeploymentService(f.db, uow);

  const agent = await f.db
    .insertInto('agents')
    .values({
      org_id: f.orgId, namespace_id: f.namespaceId, name: AGENT,
      owner: 'platform-tests', description: 'eval harness tests',
    })
    .returning('id').executeTakeFirstOrThrow();
  agentId = agent.id;

  const version = await f.db
    .insertInto('agent_versions')
    .values({
      agent_id: agentId, org_id: f.orgId, namespace_id: f.namespaceId,
      lifetime: 'registered', version: 1,
      spec: JSON.stringify({ framework: 'echo' }),
      spec_hash: `eval-${SUFFIX}`,
      workload_identity_id: f.principalId, model_id: f.modelId,
    })
    .returning('id').executeTakeFirstOrThrow();
  versionId = version.id;
});

afterAll(async () => {
  if (!f) return;
  await f.db.deleteFrom('promotion_gates').where('agent_id', '=', agentId).execute();
  await f.db.deleteFrom('deployments').where('agent_id', '=', agentId).execute();
  await f.db.deleteFrom('eval_suites').where('org_id', '=', f.orgId)
    .where('ref', 'like', `%${SUFFIX}`).execute();
  await f.db.deleteFrom('agent_versions').where('agent_id', '=', agentId).execute();
  await f.db.deleteFrom('agents').where('id', '=', agentId).execute();
  await f.close();
});

describe('deterministic graders', () => {
  it('gives partial credit for some of the required strings', async () => {
    const grade = await new ContainsGrader().grade({
      expectation: { all: ['T+2', 'domestic', 'business days'] },
      output: { text: 'Domestic settlement is T+2.' },
      observed: completed(),
    });
    // Fractional, not false: an answer with two of three facts is genuinely better than
    // one with none, and that signal is how you tell "improved" from "failed differently".
    expect(grade.score).toBeCloseTo(2 / 3);
    expect(grade.passed).toBe(false);
    expect(grade.detail['missing']).toEqual(['business days']);
  });

  it('scores a failed run zero rather than treating it as no data', async () => {
    for (const grader of [new ContainsGrader(), new ExactGrader(), new RegexGrader(), new BudgetGrader()]) {
      const grade = await grader.grade({
        expectation: { all: ['anything'] },
        output: null,
        observed: completed({ status: 'failed', error: { code: 'boom' } }),
      });
      // An agent that errors has scored zero on the case. Reporting "no data" is how a
      // broken version passes a suite by not answering.
      expect(grade.score).toBe(0);
      expect(grade.passed).toBe(false);
      expect(grade.detail['reason']).toMatch(/did not complete/);
    }
  });

  it('is all-or-nothing for forbidden content', async () => {
    const grader = new NotContainsGrader();
    expect((await grader.grade({
      expectation: ['T+1', 'T+3'],
      output: { text: 'Settlement is T+2.' },
      observed: completed(),
    })).passed).toBe(true);

    // No partial credit for leaking one of three secrets.
    const leaked = await grader.grade({
      expectation: ['T+1', 'T+3', 'T+4'],
      output: { text: 'Probably T+3.' },
      observed: completed(),
    });
    expect(leaked.score).toBe(0);
    expect(leaked.detail['present']).toEqual(['T+3']);
  });

  it('reports a malformed pattern as a broken case, not a failing agent', async () => {
    const grade = await new RegexGrader().grade({
      expectation: { pattern: '([unclosed' },
      output: { text: 'anything' },
      observed: completed(),
    });
    expect(grade.detail['reason']).toBe('invalid pattern');
  });

  it('compares JSON structurally, not by reference', async () => {
    const grade = await new JsonPathGrader().grade({
      expectation: { checks: [{ path: 'items.0.name', equals: 'refund' }] },
      output: { items: [{ name: 'refund' }] },
      observed: completed(),
    });
    expect(grade.passed).toBe(true);
  });

  it('grades a budget continuously, so direction is visible', async () => {
    const grader = new BudgetGrader();
    const near = await grader.grade({
      expectation: { maxLatencyMs: 1_000 },
      output: {}, observed: completed({ latencyMs: 1_100 }),
    });
    const far = await grader.grade({
      expectation: { maxLatencyMs: 1_000 },
      output: {}, observed: completed({ latencyMs: 10_000 }),
    });
    expect(near.passed).toBe(false);
    expect(far.passed).toBe(false);
    // Both fail, but not equally — a boolean could not tell you a change made it worse.
    expect(near.score).toBeGreaterThan(far.score);
  });

  it('never emits [object Object] for a structured answer', async () => {
    const grade = await new ContainsGrader().grade({
      expectation: { all: ['refund'] },
      output: { nested: { detail: 'refund issued' } },
      observed: completed(),
    });
    expect(grade.passed).toBe(true);
  });
});

describe('llm judge and §16.1 Constraint 1', () => {
  it('refuses an external judge model — evals may not leave the perimeter', async () => {
    const external = await f.db
      .selectFrom('models').select(['ref', 'residency'])
      .where('org_id', '=', f.orgId).where('residency', '=', 'external')
      .executeTakeFirst();
    // The fixture org has an external model registered; if it ever does not, this test
    // would silently pass without exercising the refusal.
    expect(external, 'expected an external model in the fixture org').toBeDefined();

    const judge = new LlmJudgeGrader(
      f.db,
      // Never reached: the residency check happens before any provider is selected.
      [],
      { id: 'test', resolve: async () => ({}) },
    );
    const grade = await judge.grade({
      expectation: { rubric: 'Is the answer polite?', judgeModelRef: external!.ref },
      output: { text: 'yes' },
      observed: completed(),
    });

    expect(grade.passed).toBe(false);
    expect(String(grade.detail['reason'])).toContain('§16.1');
    expect(grade.detail['residency']).toBe('external');
  });

  it('registers exactly one implementation per schema-permitted grader kind', () => {
    const registry = new GraderRegistryImpl(
      new ExactGrader(), new ContainsGrader(), new NotContainsGrader(), new RegexGrader(),
      new JsonPathGrader(), new BudgetGrader(),
      new LlmJudgeGrader(f.db, [], { id: 'test', resolve: async () => ({}) }),
    );
    for (const kind of ['exact', 'contains', 'not_contains', 'regex', 'json_path', 'budget', 'llm_judge'] as const) {
      expect(registry.for(kind).kind).toBe(kind);
    }
  });
});

describe('mechanism variants (§0.5)', () => {
  const spec = (over: Record<string, unknown> = {}) =>
    agentSpecSchema.parse({ model: { ref: 'internal/echo' }, ...over });

  it('turns one mechanism off and leaves the rest alone', () => {
    const on = spec({ memory: { enabled: true }, context: { compaction: true } });
    const off = withMechanismDisabled(on, 'memory_tiers')!;
    expect(off.memory.enabled).toBe(false);
    // Only the named mechanism moves; a variant that disabled two would attribute both
    // to whichever one the suite claimed to be testing.
    expect(off.context.compaction).toBe(true);
  });

  it('returns null when the mechanism is already off, rather than an identical spec', () => {
    // An identical spec would produce a delta of exactly zero and be reported as
    // "no benefit" — a conclusion about the mechanism drawn from a comparison that
    // never happened.
    expect(withMechanismDisabled(spec(), 'memory_tiers')).toBeNull();
    expect(withMechanismDisabled(spec(), 'skills')).toBeNull();
    expect(withMechanismDisabled(spec(), 'knowledge')).toBeNull();
    expect(withMechanismDisabled(spec(), 'none')).toBeNull();
  });

  it('produces a spec that is still admissible', () => {
    const on = spec({ knowledge: { collections: ['some-corpus'] } });
    const off = withMechanismDisabled(on, 'knowledge')!;
    // The off arm executes as a real, separately-admitted version. A variant that failed
    // schema validation would mean the A/B measured something undeployable.
    expect(() => agentSpecSchema.parse(off)).not.toThrow();
  });
});

describe('suite authoring', () => {
  it('refuses an empty suite — it would score 1.0 and pass every gate', async () => {
    const error = await ctx(() => suites.upsert({ ref: `empty-${SUFFIX}`, cases: [] }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdmissionRejected);
    expect((error as AdmissionRejected).rejections.join('\n')).toMatch(/no cases/);
  });

  it('refuses a mechanism suite where no case can be compared', async () => {
    const error = await ctx(() =>
      suites.upsert({
        ref: `nocompare-${SUFFIX}`,
        mechanismUnderTest: 'memory_tiers',
        cases: [{ name: 'a', input: 'x', expectation: { all: ['y'] }, grader: 'contains', abComparable: false }],
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdmissionRejected);
    expect((error as AdmissionRejected).rejections.join('\n')).toMatch(/no case is abComparable/);
  });

  it('replaces cases wholesale rather than merging', async () => {
    await ctx(() =>
      suites.upsert({
        ref: SUITE,
        cases: [
          { name: 'keep', input: 'a', expectation: { all: ['a'] }, grader: 'contains' },
          { name: 'drop', input: 'b', expectation: { all: ['b'] }, grader: 'contains' },
        ],
      }),
    );
    await ctx(() =>
      suites.upsert({
        ref: SUITE,
        cases: [{ name: 'keep', input: 'a', expectation: { all: ['a'] }, grader: 'contains' }],
      }),
    );
    const suite = await ctx(() => suites.get(SUITE));
    // A merge would leave `drop` still scoring, so the suite's contents would differ from
    // what its author believes gates on it.
    expect(suite.cases.map((c) => c.name)).toEqual(['keep']);
  });

  it('lists every mechanism, including those with no suite at all', async () => {
    const ledger = await ctx(() => suites.mechanismLedger());
    // The absent ones are the point: "each mechanism has an eval" is unauditable without
    // a list of the ones that do not.
    expect(ledger.length).toBeGreaterThanOrEqual(11);
    expect(ledger.some((m) => m.verdict === 'no_eval')).toBe(true);
    expect(ledger.map((m) => m.mechanism)).toContain('memory_tiers');
  });
});

describe('promotion gate (§15.5)', () => {
  it('reports an ungated agent as ungated, not as passing', async () => {
    const gate = await ctx(() => deployments.checkGate(AGENT, 'production', versionId));
    expect(gate.gated).toBe(false);
    // Distinct facts. Collapsing them makes an unverified agent indistinguishable from a
    // verified one in every report that reads `passed`.
    expect(gate.passed).toBe(false);
  });

  it('blocks promotion when no eval run exists for THIS version', async () => {
    await ctx(() => suites.upsert({
      ref: SUITE,
      cases: [{ name: 'keep', input: 'a', expectation: { all: ['a'] }, grader: 'contains' }],
    }));
    await ctx(() => deployments.setGate({ agentName: AGENT, environment: 'production', suiteRef: SUITE, minScore: 0.9 }));

    const error = await ctx(() =>
      deployments.promote({ agentName: AGENT, environment: 'production', agentVersionId: versionId }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).message).toMatch(/No completed eval run/);
  });

  it('will not accept another version’s passing run as evidence', async () => {
    const other = await f.db
      .insertInto('agent_versions')
      .values({
        agent_id: agentId, org_id: f.orgId, namespace_id: f.namespaceId,
        lifetime: 'registered', version: 2,
        spec: JSON.stringify({ framework: 'echo' }), spec_hash: `eval-other-${SUFFIX}`,
        workload_identity_id: f.principalId, model_id: f.modelId,
      })
      .returning('id').executeTakeFirstOrThrow();

    const suite = await f.db.selectFrom('eval_suites').select('id')
      .where('org_id', '=', f.orgId).where('ref', '=', SUITE).executeTakeFirstOrThrow();

    // A perfect run — for the OTHER version.
    await f.db.insertInto('eval_runs').values({
      eval_suite_id: suite.id, agent_version_id: other.id,
      score: '1.0', passed: true, min_score: '0.9', verdict: 'passed',
      ended_at: new Date(),
    }).execute();

    const gate = await ctx(() => deployments.checkGate(AGENT, 'production', versionId));
    // This is the failure mode where v4 ships on v3's evidence — a green check for an
    // untested artefact, which is worse than no gate at all.
    expect(gate.passed).toBe(false);
    expect(gate.reason).toMatch(/No completed eval run/);
  });

  it('refuses an override the gate did not authorise', async () => {
    const error = await ctx(() =>
      deployments.promote({
        agentName: AGENT, environment: 'production', agentVersionId: versionId,
        overrideReason: 'shipping anyway because it is Friday',
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    // A gate anyone can talk past by supplying a string is decoration.
    expect((error as PlatformError).code).toBe('capability_denied');
  });

  it('records who overrode the gate and why', async () => {
    await ctx(() => deployments.setGate({
      agentName: AGENT, environment: 'production', suiteRef: SUITE,
      minScore: 0.9, allowOverride: true,
    }));
    const result = await ctx(() =>
      deployments.promote({
        agentName: AGENT, environment: 'production', agentVersionId: versionId,
        overrideReason: 'SEV2: index rebuild in progress',
      }),
    );
    expect(result['gateOverridden']).toBe(true);

    const row = await f.db
      .selectFrom('deployments')
      .select(['gate_overridden_by', 'gate_override_reason'])
      .where('id', '=', result['deploymentId'] as string)
      .executeTakeFirstOrThrow();
    // Auditable (§16.4). An override nobody can attribute is a gate that was bypassed
    // silently, which is the outcome the override exists to prevent.
    expect(row.gate_overridden_by).toBe(f.principalId);
    expect(row.gate_override_reason).toContain('SEV2');
  });

  it('keeps exactly one active deployment per environment', async () => {
    const active = await f.db
      .selectFrom('deployments')
      .select('id')
      .where('agent_id', '=', agentId)
      .where('environment', '=', 'production')
      .where('state', 'in', ['active', 'rolling'])
      .execute();
    // Enforced by the partial unique index, so two active rows are unrepresentable.
    expect(active.length).toBe(1);
  });

  it('leaves no second live row behind when a canary is replaced', async () => {
    const v4 = await f.db
      .insertInto('agent_versions')
      .values({
        agent_id: agentId, org_id: f.orgId, namespace_id: f.namespaceId,
        lifetime: 'registered', version: 4,
        spec: JSON.stringify({ framework: 'echo' }), spec_hash: `eval-v4-${SUFFIX}`,
        workload_identity_id: f.principalId, model_id: f.modelId,
      })
      .returning('id').executeTakeFirstOrThrow();

    // A canary leaves a `rolling` row...
    await ctx(() => deployments.promote({
      agentName: AGENT, environment: 'staging', agentVersionId: v4.id, canaryPercent: 10,
    }));
    // ...and promoting it fully must retire that row, not sit alongside it. Retiring only
    // `state = 'active'` left the rolling row live, and the environment then appeared
    // twice in the status subresource.
    await ctx(() => deployments.promote({
      agentName: AGENT, environment: 'staging', agentVersionId: v4.id,
    }));

    const live = await f.db
      .selectFrom('deployments')
      .select(['state', 'canary_percent'])
      .where('agent_id', '=', agentId)
      .where('environment', '=', 'staging')
      .where('state', 'in', ['active', 'rolling'])
      .execute();
    expect(live).toHaveLength(1);
    expect(live[0]!.state).toBe('active');
  });

  it('rolls back to the previous version without being told which', async () => {
    const v3 = await f.db
      .insertInto('agent_versions')
      .values({
        agent_id: agentId, org_id: f.orgId, namespace_id: f.namespaceId,
        lifetime: 'registered', version: 3,
        spec: JSON.stringify({ framework: 'echo' }), spec_hash: `eval-v3-${SUFFIX}`,
        workload_identity_id: f.principalId, model_id: f.modelId,
      })
      .returning('id').executeTakeFirstOrThrow();

    await ctx(() => deployments.promote({
      agentName: AGENT, environment: 'production', agentVersionId: v3.id,
      overrideReason: 'test: promoting a second version to roll back from',
    }));

    const rolled = await ctx(() => deployments.rollback(AGENT, 'production'));
    // Derived from history: nobody should have to recall a version id under pressure.
    expect(rolled['rolledBackFrom']).toBe(v3.id);
    expect(rolled['rolledBackTo']).toBe(versionId);
  });

  it('refuses to deploy an ephemeral version — a rollback target must be nameable', async () => {
    const ephemeral = await f.db
      .insertInto('agent_versions')
      .values({
        agent_id: null, org_id: f.orgId, namespace_id: f.namespaceId,
        lifetime: 'ephemeral', version: null,
        spec: JSON.stringify({ framework: 'echo' }), spec_hash: `eval-eph-${SUFFIX}`,
        workload_identity_id: f.principalId, model_id: f.modelId,
      })
      .returning('id').executeTakeFirstOrThrow();

    const error = await ctx(() =>
      deployments.promote({ agentName: AGENT, environment: 'staging', agentVersionId: ephemeral.id }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);

    await f.db.deleteFrom('agent_versions').where('id', '=', ephemeral.id).execute();
  });
});
