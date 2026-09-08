import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdmissionService } from '../src/domain/admission/admission.service.js';
import { PolicyService } from '../src/domain/policy/policy.service.js';
import { PromptService } from '../src/domain/prompt/prompt.service.js';
import { SkillService } from '../src/domain/skills/skill.service.js';
import { PeerService } from '../src/domain/peer/peer.service.js';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { AdmissionRejected } from '../src/domain/errors/platform.errors.js';
import { fixture, type Fixture } from './fixtures.js';

let f: Fixture;
let admission: AdmissionService;

beforeAll(async () => {
  f = await fixture();
  admission = new AdmissionService(
    f.db,
    new SkillService(f.db, new UnitOfWork(f.db)),
    new PeerService(f.db),
    new PromptService(f.db, new UnitOfWork(f.db)),
    new PolicyService(f.db, new UnitOfWork(f.db)),
  );
});
afterAll(async () => f.close());

const input = (spec: unknown) => ({
  orgId: f.orgId,
  namespaceId: f.namespaceId,
  callerPrincipalId: f.principalId,
  rawSpec: spec,
});

describe('admission control (§17.5)', () => {
  it('admits a granted model', async () => {
    const result = await admission.admit(input({ model: { ref: 'internal/echo' } }));
    expect(result.modelId).toBe(f.modelId);
    expect(result.specHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an unknown model rather than substituting a default', async () => {
    await expect(admission.admit(input({ model: { ref: 'nope/nothing' } }))).rejects.toBeInstanceOf(
      AdmissionRejected,
    );
  });

  /**
   * §17.5: "Rejections are explicit. Silent narrowing hides bugs." An author fixing a
   * spec must see every problem at once, not one per round trip.
   */
  it('collects every rejection instead of stopping at the first', async () => {
    const error = await admission
      .admit(input({ model: { ref: 'nope/nothing' }, tools: ['nope.one', 'nope.two'] }))
      .catch((e: unknown) => e as AdmissionRejected);

    expect(error).toBeInstanceOf(AdmissionRejected);
    const reasons = (error as AdmissionRejected).rejections.join('\n');
    expect(reasons).toContain('nope/nothing');
    expect(reasons).toContain('nope.one');
    expect(reasons).toContain('nope.two');
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    // An inline spec selects from capability the caller holds; it never widens
    // authority (§18.5). A silently-dropped field is how that rule erodes.
    await expect(
      admission.admit(input({ model: { ref: 'internal/echo' }, escalate: true })),
    ).rejects.toBeInstanceOf(AdmissionRejected);
  });

  it('records the decision either way, for the §18.5 cardinality signal', async () => {
    const before = await f.db
      .selectFrom('admission_decisions')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('caller_principal_id', '=', f.principalId)
      .executeTakeFirstOrThrow();

    await admission.admit(input({ model: { ref: 'nope/nothing' } })).catch(() => undefined);

    const after = await f.db
      .selectFrom('admission_decisions')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('caller_principal_id', '=', f.principalId)
      .executeTakeFirstOrThrow();

    expect(Number(after.n)).toBe(Number(before.n) + 1);
  });

  it('gives an identical spec an identical hash, collapsing repeat runs onto one version', async () => {
    const a = await admission.admit(input({ model: { ref: 'internal/echo' }, systemPrompt: 'x' }));
    const b = await admission.admit(input({ systemPrompt: 'x', model: { ref: 'internal/echo' } }));
    expect(a.specHash).toBe(b.specHash);
  });
});
