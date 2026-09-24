import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { UnitOfWork } from '../src/platform/persistence/unit-of-work.js';
import { SkillService } from '../src/domain/skills/skill.service.js';
import { FilesystemObjectStore } from '../src/adapters/storage/filesystem.object-store.js';
import { PolicyService } from '../src/domain/policy/policy.service.js';
import { AdmissionService } from '../src/domain/admission/admission.service.js';
import { PromptService } from '../src/domain/prompt/prompt.service.js';
import { PeerService } from '../src/domain/peer/peer.service.js';
import { AgentVersionService } from '../src/domain/registry/agent-version.service.js';
import { KnowledgeService } from '../src/domain/knowledge/knowledge.service.js';
import { PgVectorKnowledgeIndex } from '../src/adapters/knowledge/pgvector.knowledge-index.js';
import { DeterministicEmbedder } from '../src/adapters/memory/deterministic.embedder.js';
import { AdmissionRejected } from '../src/domain/errors/platform.errors.js';
import { fixture, type Fixture } from './fixtures.js';

let f: Fixture;
let skills: SkillService;
let admission: AdmissionService;
let versions: AgentVersionService;
let knowledge: KnowledgeService;

const SUFFIX = Math.random().toString(36).slice(2, 8);
const SKILL = `refund-procedure-${SUFFIX}`;
const UNGRANTED_TOOL = `demo.ungranted-${SUFFIX}`;
const COLLECTION = `skill-kb-${SUFFIX}`;

let ungrantedToolId: string;
let collectionId: string;

beforeAll(async () => {
  f = await fixture();
  const uow = new UnitOfWork(f.db);
  skills = new SkillService(f.db, uow, new FilesystemObjectStore());
  admission = new AdmissionService(f.db, skills, new PeerService(f.db), new PromptService(f.db, uow), new PolicyService(f.db, uow));
  versions = new AgentVersionService(f.db);
  const embedder = new DeterministicEmbedder();
  knowledge = new KnowledgeService(
    f.db,
    new UnitOfWork(f.db),
    embedder,
    new PgVectorKnowledgeIndex(f.db, embedder),
  );

  // A real, active tool with NO capability grant. The whole point of the registry is
  // that attaching a skill must not be a way to reach one of these.
  const tool = await f.db
    .insertInto('tools')
    .values({
      org_id: f.orgId,
      namespace_id: f.namespaceId,
      ref: UNGRANTED_TOOL,
      origin: 'http',
      residency: 'internal',
      description: 'A tool the caller was never granted',
      input_schema: JSON.stringify({ type: 'object' }),
      default_effects: ['read_only'],
      sandbox_profile: 'http-egress',
      endpoint_url: 'http://127.0.0.1:9/never',
      timeout_ms: 1_000,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  ungrantedToolId = tool.id;

  const collection = await knowledge.createCollection({
    orgId: f.orgId,
    namespaceId: f.namespaceId,
    name: COLLECTION,
  });
  collectionId = collection.id;
});

afterAll(async () => {
  // Agent versions first. skill_versions is ON DELETE RESTRICT from agent_version_skills
  // on purpose -- deleting a skill out from under a pinned agent is exactly what the
  // pin exists to prevent -- so teardown has to unpin before it can clean up.
  await sql`DELETE FROM agent_versions WHERE namespace_id = ${f.namespaceId}
              AND spec::text LIKE ${`%${SUFFIX}%`}`.execute(f.db);
  await f.db.deleteFrom('skills').where('namespace_id', '=', f.namespaceId)
    .where('name', 'like', `%-${SUFFIX}`).execute();
  await f.db.deleteFrom('knowledge_collections').where('id', '=', collectionId).execute();
  await f.db.deleteFrom('capability_grants').where('resource_id', '=', ungrantedToolId).execute();
  await f.db.deleteFrom('tools').where('id', '=', ungrantedToolId).execute();
  await f.close();
});

const grant = async (kind: 'tool' | 'skill' | 'knowledge_collection', id: string) =>
  f.db
    .insertInto('capability_grants')
    .values({
      org_id: f.orgId,
      grant_source: 'service',
      namespace_id: f.namespaceId,
      resource_kind: kind,
      resource_id: id,
      granted_by: f.principalId,
    })
    .execute();

const spec = (over: Record<string, unknown> = {}) => ({
  framework: 'echo',
  model: { ref: 'internal/echo' },
  ...over,
});

const admit = (over: Record<string, unknown> = {}) =>
  admission.admit({
    orgId: f.orgId,
    namespaceId: f.namespaceId,
    callerPrincipalId: f.principalId,
    rawSpec: spec(over),
  });

describe('skill versioning', () => {
  it('publishing twice mints two versions and leaves the first untouched', async () => {
    const v1 = await skills.publish({
      orgId: f.orgId,
      namespaceId: f.namespaceId,
      name: SKILL,
      instructions: 'Check the captured amount before issuing a refund.',
      whenToUse: 'A customer asks for money back.',
    });
    const v2 = await skills.publish({
      orgId: f.orgId,
      namespaceId: f.namespaceId,
      name: SKILL,
      instructions: 'Check the captured amount AND the dispute window before refunding.',
    });

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.skillId).toBe(v1.skillId);

    const { resolved } = await skills.resolve(f.namespaceId, [`${SKILL}@1`]);
    expect(resolved[0]!.instructions).toBe('Check the captured amount before issuing a refund.');
  });

  it('a bare name resolves to the highest active version', async () => {
    const { resolved } = await skills.resolve(f.namespaceId, [SKILL]);
    expect(resolved[0]!.version).toBe(2);
  });

  it('deprecation makes a version unselectable by name without breaking a pin', async () => {
    await skills.deprecate(f.namespaceId, SKILL, 2);

    const byName = await skills.resolve(f.namespaceId, [SKILL]);
    expect(byName.resolved[0]!.version).toBe(1);

    // The pinned reference still resolves: an agent already admitted against v2 keeps
    // running v2. Cascading deprecation into existing pins would be a deletion wearing
    // a softer word.
    const pinned = await skills.resolve(f.namespaceId, [`${SKILL}@2`]);
    expect(pinned.resolved[0]!.version).toBe(2);
    expect(pinned.rejections).toEqual([]);
  });

  it('names a missing skill rather than silently attaching nothing', async () => {
    const { resolved, rejections } = await skills.resolve(f.namespaceId, ['no-such-skill']);
    expect(resolved).toEqual([]);
    expect(rejections.join('\n')).toContain('no-such-skill');
  });
});

describe('skills and capability (§16.2)', () => {
  let launderingSkill: string;

  beforeAll(async () => {
    launderingSkill = `laundering-${SUFFIX}`;
    await skills.publish({
      orgId: f.orgId,
      namespaceId: f.namespaceId,
      name: launderingSkill,
      instructions: 'Call the tool the caller was never granted.',
      tools: [UNGRANTED_TOOL],
    });
  });

  it('a skill is not a way around a missing tool grant', async () => {
    await grant('skill', (await skills.resolve(f.namespaceId, [launderingSkill])).resolved[0]!.skillVersionId);

    const error = await admit({ skills: [launderingSkill] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdmissionRejected);

    const reasons = (error as AdmissionRejected).rejections.join('\n');
    expect(reasons).toContain(UNGRANTED_TOOL);
    // The message names the SKILL that pulled the tool in. "No grant for
    // demo.ungranted" is baffling to an author whose spec never mentioned that tool.
    expect(reasons).toContain(launderingSkill);
  });

  it('once both are granted, the skill-borne tool is admitted as if named directly', async () => {
    await grant('tool', ungrantedToolId);

    const result = await admit({ skills: [launderingSkill] });
    expect(result.spec.tools).toEqual([]);          // the spec never named it
    expect(result.toolIds.map((t) => t.ref)).toContain(UNGRANTED_TOOL);  // the run gets it
  });

  it('an ungranted collection is refused, whether named directly or pulled in by a skill', async () => {
    // The fixture created this collection with no `createdBy`, so no grant was minted.
    // Creating one through the API mints it (and revoking is then the control) -- this
    // exercises the refusal path a revoked grant leaves behind.
    const error = await admit({ knowledge: { collections: [COLLECTION] } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdmissionRejected);
    expect((error as AdmissionRejected).rejections.join('\n')).toContain('no capability grant for collection');

    await grant('knowledge_collection', collectionId);
    const ok = await admit({ knowledge: { collections: [COLLECTION] } });
    expect(ok.collectionIds.map((c) => c.name)).toEqual([COLLECTION]);
  });
});

describe('pinning', () => {
  it('an agent version stores the resolved version, so a later publish does not move it', async () => {
    const name = `pinned-${SUFFIX}`;
    const first = await skills.publish({
      orgId: f.orgId,
      namespaceId: f.namespaceId,
      name,
      instructions: 'Original procedure.',
    });
    await grant('skill', first.skillVersionId);

    const admitted = await admit({ skills: [name], systemPrompt: `pin-test-${SUFFIX}` });
    const version = await new UnitOfWork(f.db).run((tx) =>
      versions.materialiseEphemeral({
        tx,
        orgId: f.orgId,
        namespaceId: f.namespaceId,
        workloadIdentityId: f.principalId,
        admission: admitted,
      }),
    );
    expect(version.skills.map((s) => s.instructions)).toEqual(['Original procedure.']);

    // Publish v2 of the same skill. The already-materialised version must not move.
    await skills.publish({
      orgId: f.orgId,
      namespaceId: f.namespaceId,
      name,
      instructions: 'Rewritten procedure that does something else entirely.',
    });

    const reloaded = await versions.load(f.db, version.id);
    expect(reloaded.skills.map((s) => s.instructions)).toEqual(['Original procedure.']);
    expect(reloaded.skills[0]!.version).toBe(1);
  });

  it('a version exposes its skills’ collections without the spec naming them', async () => {
    const name = `kb-skill-${SUFFIX}`;
    const published = await skills.publish({
      orgId: f.orgId,
      namespaceId: f.namespaceId,
      name,
      instructions: 'Consult the manual before answering.',
      collections: [COLLECTION],
    });
    await grant('skill', published.skillVersionId);

    const admitted = await admit({ skills: [name], systemPrompt: `kb-pin-${SUFFIX}` });
    const version = await new UnitOfWork(f.db).run((tx) =>
      versions.materialiseEphemeral({
        tx,
        orgId: f.orgId,
        namespaceId: f.namespaceId,
        workloadIdentityId: f.principalId,
        admission: admitted,
      }),
    );

    // The collection reaches the run through the skill, and is NOT copied onto the agent
    // version -- swapping the skill out must take the corpus access with it.
    expect(version.knowledge.collectionIds).toEqual([collectionId]);
    const direct = await f.db
      .selectFrom('agent_version_collections')
      .select('collection_id')
      .where('agent_version_id', '=', version.id)
      .execute();
    expect(direct).toEqual([]);
  });
});

describe('authorisation defaults', () => {
  it('publishing mints the namespace grant, so an author can use what they just published', async () => {
    const name = `self-grant-${SUFFIX}`;
    const published = await skills.publish({
      orgId: f.orgId,
      namespaceId: f.namespaceId,
      name,
      instructions: 'A procedure its own author may run.',
      publishedBy: f.principalId,
    });

    // No explicit grant() here on purpose: requiring one would mean every publish is
    // immediately followed by the same second call, which is a default, not a policy.
    const admitted = await admit({ skills: [name], systemPrompt: `self-grant-${SUFFIX}` });
    expect(admitted.skills.map((s) => s.name)).toEqual([name]);

    // Revocation is what the grant is actually for.
    await f.db
      .updateTable('capability_grants')
      .set({ revoked_at: new Date() })
      .where('resource_id', '=', published.skillVersionId)
      .execute();

    const error = await admit({ skills: [name], systemPrompt: `revoked-${SUFFIX}` })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdmissionRejected);
    expect((error as AdmissionRejected).rejections.join('\n')).toContain(name);
  });
});

describe('uploaded skills (streamed from object storage, not typed as JSON)', () => {
  it('publishing with content stores it in object storage and leaves instructions null', async () => {
    const name = `uploaded-${SUFFIX}`;
    const published = await skills.publish({
      orgId: f.orgId,
      namespaceId: f.namespaceId,
      name,
      content: Buffer.from('---\nname: uploaded\n---\n\nDo the uploaded thing.', 'utf8'),
      whenToUse: 'when the customer asks for the uploaded thing',
    });

    const { resolved } = await skills.resolve(f.namespaceId, [name]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.instructions).toBeNull();
    expect(resolved[0]!.contentUri).toBeTruthy();
    expect(resolved[0]!.skillVersionId).toBe(published.skillVersionId);
  });

  it('the stored content_uri round-trips the exact uploaded bytes', async () => {
    const name = `uploaded-roundtrip-${SUFFIX}`;
    const body = '---\nname: roundtrip\n---\n\nExact bytes, verified below.';
    await skills.publish({
      orgId: f.orgId,
      namespaceId: f.namespaceId,
      name,
      content: Buffer.from(body, 'utf8'),
    });

    const { resolved } = await skills.resolve(f.namespaceId, [name]);
    const store = new FilesystemObjectStore();
    const fetched = await store.get(resolved[0]!.contentUri!);
    expect(fetched.toString('utf8')).toBe(body);
  });

  it('rejects a publish given neither instructions nor content', async () => {
    await expect(
      skills.publish({
        orgId: f.orgId,
        namespaceId: f.namespaceId,
        name: `neither-${SUFFIX}`,
      }),
    ).rejects.toThrow(AdmissionRejected);
  });

  it('rejects a publish given both instructions and content', async () => {
    await expect(
      skills.publish({
        orgId: f.orgId,
        namespaceId: f.namespaceId,
        name: `both-${SUFFIX}`,
        instructions: 'text',
        content: Buffer.from('bytes'),
      }),
    ).rejects.toThrow(AdmissionRejected);
  });

  it('rejects empty content the same way it rejects empty instructions', async () => {
    await expect(
      skills.publish({
        orgId: f.orgId,
        namespaceId: f.namespaceId,
        name: `empty-content-${SUFFIX}`,
        content: Buffer.alloc(0),
      }),
    ).rejects.toThrow(AdmissionRejected);
  });

  it('rejects content over the 5MB limit', async () => {
    await expect(
      skills.publish({
        orgId: f.orgId,
        namespaceId: f.namespaceId,
        name: `oversized-${SUFFIX}`,
        content: Buffer.alloc(5 * 1024 * 1024 + 1),
      }),
    ).rejects.toThrow(AdmissionRejected);
  });

  it('an uploaded skill is admitted and readable by a run exactly like a JSON-authored one', async () => {
    const name = `uploaded-admit-${SUFFIX}`;
    await skills.publish({
      orgId: f.orgId,
      namespaceId: f.namespaceId,
      name,
      content: Buffer.from('---\nname: uploaded-admit\n---\n\nProcedure body.', 'utf8'),
      whenToUse: 'uploaded skill admission check',
      publishedBy: f.principalId,
    });

    const admitted = await admit({ skills: [name], systemPrompt: `uploaded-admit-${SUFFIX}` });
    expect(admitted.skills.map((s) => s.name)).toEqual([name]);
  });
});
