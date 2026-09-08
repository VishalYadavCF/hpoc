import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { PolicyService } from '../src/domain/policy/policy.service.js';
import { PromptService } from '../src/domain/prompt/prompt.service.js';
import { AdmissionService } from '../src/domain/admission/admission.service.js';
import { SkillService } from '../src/domain/skills/skill.service.js';
import { PeerService } from '../src/domain/peer/peer.service.js';
import { AgentVersionService } from '../src/domain/registry/agent-version.service.js';
import { AdmissionRejected } from '../src/domain/errors/platform.errors.js';
import { runInContext } from '../src/platform/context/platform-context.js';
import { fixture, type Fixture } from './fixtures.js';

let f: Fixture;
let prompts: PromptService;
let admission: AdmissionService;
let versions: AgentVersionService;

const SUFFIX = Math.random().toString(36).slice(2, 8);
const REF = `reviewer-style-${SUFFIX}`;

const ctx = <T>(fn: () => Promise<T>): Promise<T> =>
  runInContext(
    {
      orgId: f.orgId, namespaceId: f.namespaceId, tenantRef: f.tenantRef,
      callerPrincipalId: f.principalId, onBehalfOfPrincipalId: null,
      authorizingHumanId: null, delegationChain: [],
      traceId: `prompt-${SUFFIX}`, correlationId: `prompt-${SUFFIX}`,
    },
    fn,
  );

const grant = (resourceId: string) =>
  f.db.insertInto('capability_grants').values({
    org_id: f.orgId, grant_source: 'service', namespace_id: f.namespaceId,
    resource_kind: 'prompt', resource_id: resourceId, granted_by: f.principalId,
  }).execute();

beforeAll(async () => {
  f = await fixture();
  const uow = new UnitOfWork(f.db);
  prompts = new PromptService(f.db, uow);
  admission = new AdmissionService(
    f.db, new SkillService(f.db, uow), new PeerService(f.db), prompts,
    new PolicyService(f.db, uow),
  );
  versions = new AgentVersionService(f.db);
});

afterAll(async () => {
  if (!f) return;
  // Both FKs are ON DELETE RESTRICT, which is the correct rule -- a prompt version an
  // agent pins must not vanish underneath it -- so teardown unwinds in dependency order.
  const versionIds = (
    await f.db.selectFrom('prompt_versions as pv').innerJoin('prompts as p', 'p.id', 'pv.prompt_id')
      .select('pv.id').where('p.org_id', '=', f.orgId).where('p.ref', 'like', `%${SUFFIX}`).execute()
  ).map((v) => v.id);
  if (versionIds.length > 0) {
    await f.db.deleteFrom('agent_versions').where('prompt_version_id', 'in', versionIds).execute();
    await f.db.deleteFrom('prompt_versions').where('id', 'in', versionIds).execute();
  }
  await f.db.deleteFrom('prompts').where('org_id', '=', f.orgId)
    .where('ref', 'like', `%${SUFFIX}`).execute();
  await f.close();
});

describe('prompt registry (§17.2)', () => {
  it('republishing identical text reuses the version rather than minting another', async () => {
    const body = 'Flag correctness regressions. Skip rename preferences.';
    const first = await ctx(() => prompts.publish({ ref: REF, owner: 'platform', body }));
    const again = await ctx(() => prompts.publish({ ref: REF, owner: 'platform', body }));

    expect(first.reused).toBe(false);
    expect(first.version).toBe(1);
    // Prompt authoring is mostly re-saving; a version per keystroke would make "which
    // version is running" meaningless.
    expect(again.reused).toBe(true);
    expect(again.promptVersionId).toBe(first.promptVersionId);
  });

  it('trims, so trailing whitespace is not a new version', async () => {
    const again = await ctx(() =>
      prompts.publish({
        ref: REF, owner: 'platform',
        body: '  Flag correctness regressions. Skip rename preferences.\n',
      }),
    );
    expect(again.reused).toBe(true);
  });

  it('refuses a body that looks templated (§18.5)', async () => {
    for (const body of ['Review {{repo}} carefully.', 'Review ${repo} carefully.']) {
      const error = await ctx(() =>
        prompts.publish({ ref: `tmpl-${SUFFIX}`, owner: 'platform', body }),
      ).catch((e: unknown) => e);
      // §18.5 calls interpolating variable content into a system prompt "a direct
      // prompt-injection path, and a cache-defeating one". Caught at publish, because at
      // render time the model would just receive the braces verbatim.
      expect(error).toBeInstanceOf(AdmissionRejected);
      expect((error as AdmissionRejected).rejections.join()).toMatch(/prompt-injection/);
    }
  });

  it('a bare name resolves only to an APPROVED version', async () => {
    const byName = await ctx(() => prompts.resolve([REF]));
    expect(byName.resolved).toEqual([]);
    expect(byName.rejections.join()).toMatch(/no APPROVED version/);

    // An explicit pin still resolves, so a draft is testable without being shippable.
    const pinned = await ctx(() => prompts.resolve([`${REF}@1`]));
    expect(pinned.resolved[0]!.version).toBe(1);
    expect(pinned.resolved[0]!.approved).toBe(false);

    await ctx(() => prompts.approve(REF, 1));
    const after = await ctx(() => prompts.resolve([REF]));
    expect(after.resolved[0]!.version).toBe(1);
    expect(after.resolved[0]!.approved).toBe(true);
  });

  it('records who approved, and is idempotent', async () => {
    const second = await ctx(() => prompts.approve(REF, 1));
    expect(second['alreadyApproved']).toBe(true);

    const rows = await ctx(() => prompts.versions(REF));
    expect(rows[0]!.approved_by).toBe(f.principalId);
  });

  it('a bare name takes the highest approved version, not the highest version', async () => {
    await ctx(() => prompts.publish({ ref: REF, owner: 'platform', body: 'v2: an unapproved draft.' }));
    const resolved = await ctx(() => prompts.resolve([REF]));
    // v2 exists but is unapproved: shipping it by name would defeat the gate entirely.
    expect(resolved.resolved[0]!.version).toBe(1);
  });
});

describe('prompts and agent versions', () => {
  const spec = (over: Record<string, unknown> = {}) => ({
    model: { ref: 'internal/echo' },
    ...over,
  });

  it('refuses a spec that names both an inline prompt and a ref', async () => {
    const error = await ctx(() =>
      admission.admit({
        orgId: f.orgId, namespaceId: f.namespaceId, callerPrincipalId: f.principalId,
        rawSpec: spec({ systemPrompt: 'inline', promptRef: REF }),
      }),
    ).catch((e: unknown) => e);
    // A precedence rule is one nobody remembers under pressure, and the failure would be
    // silent: the agent runs with a prompt its author did not think they selected.
    expect(error).toBeInstanceOf(AdmissionRejected);
    expect((error as AdmissionRejected).rejections.join()).toMatch(/mutually exclusive/);
  });

  it('naming a prompt is not enough to use it (§16.2)', async () => {
    const error = await ctx(() =>
      admission.admit({
        orgId: f.orgId, namespaceId: f.namespaceId, callerPrincipalId: f.principalId,
        rawSpec: spec({ promptRef: REF }),
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdmissionRejected);
    expect((error as AdmissionRejected).rejections.join()).toMatch(/no capability grant/);
  });

  it('pins the resolved version, so a later publish does not move a running agent', async () => {
    const resolved = await ctx(() => prompts.resolve([REF]));
    await grant(resolved.resolved[0]!.promptVersionId);

    const admitted = await ctx(() =>
      admission.admit({
        orgId: f.orgId, namespaceId: f.namespaceId, callerPrincipalId: f.principalId,
        rawSpec: spec({ promptRef: REF, systemPrompt: null }),
      }),
    );
    expect(admitted.prompt?.version).toBe(1);

    const version = await ctx(() =>
      new UnitOfWork(f.db).run((tx) =>
        versions.materialiseEphemeral({
          tx, orgId: f.orgId, namespaceId: f.namespaceId,
          workloadIdentityId: f.principalId, admission: admitted,
        }),
      ),
    );
    // The BODY is loaded from the pinned version and used as the system prompt.
    expect(version.systemPrompt).toBe('Flag correctness regressions. Skip rename preferences.');
    expect(version.promptRef).toBe(`${REF}@1`);

    // Approve v2 and reload: the pinned agent must not move.
    await ctx(() => prompts.approve(REF, 2));
    const reloaded = await ctx(() => versions.load(f.db, version.id));
    expect(reloaded.promptRef).toBe(`${REF}@1`);
    expect(reloaded.systemPrompt).toContain('Flag correctness regressions');
  });

  it('reports which agent versions pin a prompt version', async () => {
    const pinnedBy = await ctx(() => prompts.usage(REF, 1));
    expect(pinnedBy.length).toBeGreaterThan(0);
  });
});
