import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import type { EffectClass } from '../../platform/persistence/schema.types.js';
import { AdmissionRejected, PlatformError } from '../errors/platform.errors.js';
import { stableHash } from '../../platform/ids.js';

export interface PublishSkillInput {
  orgId: string;
  namespaceId: string;
  name: string;
  description?: string | null;
  instructions: string;
  whenToUse?: string | null;
  /** Tool refs this skill brings with it. Each widens capability and is checked. */
  tools?: string[];
  /** Knowledge collections this skill reads from, by name, in this namespace. */
  collections?: string[];
  publishedBy?: string | null;
}

export interface ResolvedSkill {
  skillVersionId: string;
  name: string;
  version: number;
  instructions: string;
  whenToUse: string | null;
  tools: { ref: string; id: string; effects: EffectClass[] }[];
  collectionIds: string[];
}

/**
 * Named, versioned procedural capability.
 *
 * The reason skills are control-plane content rather than a prompt fragment someone pastes
 * in: a skill that carries tools WIDENS what an agent can do. If skills were mutable text
 * attached by name, editing one would change the behaviour and the authority of every
 * published agent that references it, with no new spec hash, no admission decision, and
 * no record of who approved the widening. The run that then does something unexpected
 * gets attributed to an agent version whose stored spec never changed -- which is exactly
 * the situation §17.5 exists to prevent.
 *
 * So: publishing a skill mints a new immutable version, and an agent pins the VERSION.
 * Editing a skill is publishing v(n+1); existing agents keep running v(n) until someone
 * republishes them, which is a deliberate act that goes through admission again.
 */
@Injectable()
export class SkillService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uow: UnitOfWork,
  ) {}

  async publish(input: PublishSkillInput): Promise<{ skillId: string; skillVersionId: string; version: number }> {
    const rejections: string[] = [];
    if (input.instructions.trim().length === 0) rejections.push('instructions: must not be empty');
    if (input.instructions.length > 64_000) rejections.push('instructions: exceeds 64000 characters');

    const toolRefs = input.tools ?? [];
    const tools = toolRefs.length
      ? await this.db
          .selectFrom('tools')
          // ::text[] deliberately: pg hands back the literal '{a,b}' string for a custom
          // enum array, on which Array methods silently do not exist.
          .select((eb) => [
            'id', 'ref', 'status',
            sql<EffectClass[]>`default_effects::text[]`.as('default_effects'),
          ])
          .where('org_id', '=', input.orgId)
          .where('ref', 'in', toolRefs)
          .execute()
      : [];
    const foundTools = new Map(tools.map((t) => [t.ref, t]));
    for (const ref of toolRefs) {
      const tool = foundTools.get(ref);
      if (!tool) rejections.push(`tools: "${ref}" is not in the tool registry`);
      else if (tool.status !== 'active') rejections.push(`tools: "${ref}" is ${tool.status}`);
    }

    const collectionNames = input.collections ?? [];
    const collections = collectionNames.length
      ? await this.db
          .selectFrom('knowledge_collections')
          .select(['id', 'name'])
          .where('namespace_id', '=', input.namespaceId)
          .where('name', 'in', collectionNames)
          .where('archived_at', 'is', null)
          .execute()
      : [];
    const foundCollections = new Map(collections.map((c) => [c.name, c]));
    for (const name of collectionNames) {
      if (!foundCollections.has(name)) {
        rejections.push(
          `collections: "${name}" is not a collection in this namespace. A skill may only ` +
            `cite corpora its own namespace owns.`,
        );
      }
    }

    if (rejections.length > 0) throw new AdmissionRejected(rejections);

    return this.uow.run(async (tx) => {
      const skill = await tx
        .insertInto('skills')
        .values({
          org_id: input.orgId,
          namespace_id: input.namespaceId,
          name: input.name,
          description: input.description ?? null,
          created_by: input.publishedBy ?? null,
        })
        .onConflict((oc) =>
          oc.columns(['namespace_id', 'name']).doUpdateSet({
            description: input.description ?? null,
          }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();

      // Version numbers come from the table under the transaction's lock, not from a
      // counter on `skills`. Two concurrent publishes must not both mint v3.
      const last = await tx
        .selectFrom('skill_versions')
        .select(({ fn }) => [fn.max<number | null>('version').as('max')])
        .where('skill_id', '=', skill.id)
        .executeTakeFirst();
      const version = (last?.max ?? 0) + 1;

      const specHash = stableHash({
        instructions: input.instructions,
        whenToUse: input.whenToUse ?? null,
        tools: [...toolRefs].sort(),
        collections: [...collectionNames].sort(),
      });

      const skillVersion = await tx
        .insertInto('skill_versions')
        .values({
          skill_id: skill.id,
          org_id: input.orgId,
          namespace_id: input.namespaceId,
          version,
          instructions: input.instructions,
          when_to_use: input.whenToUse ?? null,
          spec_hash: specHash,
          published_by: input.publishedBy ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      for (const tool of foundTools.values()) {
        // The contract is COPIED, not referenced. A version must keep the effect classes
        // it was published against even if the tool's defaults change later, or the
        // retry and compensation rules applied at runtime stop matching what was approved.
        await sql`
          INSERT INTO skill_version_tools (skill_version_id, tool_id, effects)
          VALUES (${skillVersion.id}, ${tool.id}, ${tool.default_effects}::effect_class[])
        `.execute(tx);
      }

      for (const collection of foundCollections.values()) {
        await tx
          .insertInto('skill_version_collections')
          .values({
            skill_version_id: skillVersion.id,
            collection_id: collection.id,
            namespace_id: input.namespaceId,
          })
          .execute();
      }

      // Publishing into your own namespace IS the act of authorising it there, so the
      // grant is minted here rather than requiring a second call to an endpoint that
      // would always be called immediately after this one. Same precedent as MCP server
      // approval, and it does not weaken §16.2: the grant is namespace-scoped, minted by
      // a publisher who already holds namespace authority, and the skill's TOOLS are
      // still checked separately -- which is where the laundering risk actually lives.
      // Its value is revocation: a skill can be switched off without being deleted.
      if (input.publishedBy) {
        await tx
          .insertInto('capability_grants')
          .values({
            org_id: input.orgId,
            grant_source: 'service',
            namespace_id: input.namespaceId,
            resource_kind: 'skill',
            resource_id: skillVersion.id,
            granted_by: input.publishedBy,
          })
          .execute();
      }

      return { skillId: skill.id, skillVersionId: skillVersion.id, version };
    });
  }

  async list(namespaceId: string) {
    return this.db
      .selectFrom('skills as s')
      .leftJoin('skill_versions as v', (join) =>
        join.onRef('v.skill_id', '=', 's.id').on('v.status', '=', 'active'),
      )
      .select(({ fn }) => [
        's.id', 's.name', 's.description',
        fn.max<number | null>('v.version').as('latest_version'),
      ])
      .where('s.namespace_id', '=', namespaceId)
      .where('s.archived_at', 'is', null)
      .groupBy(['s.id', 's.name', 's.description'])
      .orderBy('s.name')
      .execute();
  }

  async versions(namespaceId: string, name: string) {
    return this.db
      .selectFrom('skill_versions as v')
      .innerJoin('skills as s', 's.id', 'v.skill_id')
      .select(['v.id', 'v.version', 'v.when_to_use', 'v.spec_hash', 'v.status', 'v.published_at'])
      .where('s.namespace_id', '=', namespaceId)
      .where('s.name', '=', name)
      .orderBy('v.version', 'desc')
      .execute();
  }

  /**
   * Resolves `name` or `name@version` to one immutable version.
   *
   * A bare name resolves to the highest ACTIVE version, and that resolution happens once,
   * at admission. What the agent version stores afterwards is the version id -- so
   * publishing a new skill version never changes a running agent, and a deprecated
   * version keeps working for agents already pinned to it while becoming unselectable
   * for new ones. Deprecation that broke existing pins would be a deletion wearing a
   * softer word.
   */
  async resolve(namespaceId: string, refs: string[]): Promise<{ resolved: ResolvedSkill[]; rejections: string[] }> {
    const resolved: ResolvedSkill[] = [];
    const rejections: string[] = [];

    for (const ref of refs) {
      const at = ref.lastIndexOf('@');
      const name = at === -1 ? ref : ref.slice(0, at);
      const pinned = at === -1 ? null : Number(ref.slice(at + 1));
      if (pinned !== null && !Number.isInteger(pinned)) {
        rejections.push(`skills: "${ref}" has a non-integer version`);
        continue;
      }

      let q = this.db
        .selectFrom('skill_versions as v')
        .innerJoin('skills as s', 's.id', 'v.skill_id')
        .select(['v.id', 'v.version', 'v.instructions', 'v.when_to_use', 'v.status', 's.name'])
        .where('s.namespace_id', '=', namespaceId)
        .where('s.name', '=', name)
        .where('s.archived_at', 'is', null);

      q = pinned === null ? q.where('v.status', '=', 'active') : q.where('v.version', '=', pinned);

      const row = await q.orderBy('v.version', 'desc').limit(1).executeTakeFirst();
      if (!row) {
        rejections.push(
          pinned === null
            ? `skills: "${name}" has no active version in this namespace`
            : `skills: "${name}" has no version ${pinned} in this namespace`,
        );
        continue;
      }
      if (row.status === 'disabled') {
        rejections.push(`skills: "${ref}" is disabled`);
        continue;
      }

      const tools = await this.db
        .selectFrom('skill_version_tools as svt')
        .innerJoin('tools as t', 't.id', 'svt.tool_id')
        .select((eb) => [
          't.id', 't.ref',
          sql<EffectClass[]>`svt.effects::text[]`.as('effects'),
        ])
        .where('svt.skill_version_id', '=', row.id)
        .execute();

      const collections = await this.db
        .selectFrom('skill_version_collections')
        .select('collection_id')
        .where('skill_version_id', '=', row.id)
        .execute();

      resolved.push({
        skillVersionId: row.id,
        name: row.name,
        version: row.version,
        instructions: row.instructions,
        whenToUse: row.when_to_use,
        tools: tools.map((t) => ({ ref: t.ref, id: t.id, effects: t.effects })),
        collectionIds: collections.map((c) => c.collection_id),
      });
    }

    return { resolved, rejections };
  }

  async deprecate(namespaceId: string, name: string, version: number): Promise<void> {
    const skill = await this.db
      .selectFrom('skills')
      .select('id')
      .where('namespace_id', '=', namespaceId)
      .where('name', '=', name)
      .executeTakeFirst();
    if (!skill) throw new PlatformError('not_found', `Skill "${name}" not found`);

    await this.db
      .updateTable('skill_versions')
      .set({ status: 'deprecated' })
      .where('skill_id', '=', skill.id)
      .where('version', '=', version)
      .execute();
  }
}
