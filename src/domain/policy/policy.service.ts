import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { AdmissionRejected, NotFound, PlatformError } from '../errors/platform.errors.js';
import { policyDocumentSchema, type PolicyDocument } from './policy-document.js';

export interface PublishPolicyInput {
  ref: string;
  owner: string;
  document: unknown;
}

export interface ResolvedPolicy {
  policyVersionId: string;
  ref: string;
  version: number;
  document: PolicyDocument;
  contentHash: string;
  approved: boolean;
}

/** Stable stringify, so key order cannot mint a second version of an identical document. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * The policy registry (§17.3).
 *
 * Deliberately the same shape as `PromptService` (§17.2) -- immutable content-addressed
 * versions, a real approval gate, bare-name resolves to approved only, pinning by `ref@3`
 * for a draft. Two registries that behave differently for no reason is how an author
 * learns to distrust both.
 *
 * The difference is what the artefact DOES. A prompt is text handed to a model; a policy
 * is a constraint the platform enforces at admission (`enforcePolicy`). That is what keeps
 * this from being a JSON blob store with extra steps: publishing a policy that denies a
 * tool actually refuses the next agent that names it.
 *
 * Content-addressing matters more here than for prompts. Policy documents are edited by
 * fiddling with lists, and `canonical()` means reordering `["a","b"]` to `["b","a"]`
 * mints a new version (the meaning is a set, but the ORDER is not what we hash -- we hash
 * the document as written) while re-saving identical text does not.
 */
@Injectable()
export class PolicyService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uow: UnitOfWork,
  ) {}

  async publish(input: PublishPolicyInput): Promise<{
    policyId: string;
    policyVersionId: string;
    version: number;
    reused: boolean;
  }> {
    const ctx = requireContext();

    const parsed = policyDocumentSchema.safeParse(input.document ?? {});
    if (!parsed.success) {
      // A typo'd key in a security document must fail at publish. `.strict()` is what
      // turns "denyy: [...]" from a silently-ignored line into a refused publish.
      throw new AdmissionRejected(
        parsed.error.issues.map((i) => `document.${i.path.join('.') || '(root)'}: ${i.message}`),
      );
    }
    const document = parsed.data;

    // Hashed AFTER parsing, so defaults are part of the identity. Two documents that mean
    // the same thing but were written with different omissions are the same version.
    const contentHash = createHash('sha256').update(canonical(document)).digest('hex');

    return this.uow.run(async (tx) => {
      const policy = await tx
        .insertInto('policies')
        .values({ org_id: ctx.orgId, ref: input.ref, owner: input.owner })
        .onConflict((oc) => oc.columns(['org_id', 'ref']).doUpdateSet({ owner: input.owner }))
        .returning('id')
        .executeTakeFirstOrThrow();

      const existing = await tx
        .selectFrom('policy_versions')
        .select(['id', 'version'])
        .where('policy_id', '=', policy.id)
        .where('content_hash', '=', contentHash)
        .executeTakeFirst();
      if (existing) {
        return {
          policyId: policy.id,
          policyVersionId: existing.id,
          version: existing.version,
          reused: true,
        };
      }

      // Under the transaction's lock, so two concurrent publishes cannot both mint v3.
      const last = await tx
        .selectFrom('policy_versions')
        .select(({ fn }) => [fn.max<number | null>('version').as('max')])
        .where('policy_id', '=', policy.id)
        .executeTakeFirst();
      const version = (last?.max ?? 0) + 1;

      const created = await tx
        .insertInto('policy_versions')
        .values({
          policy_id: policy.id,
          version,
          document: JSON.stringify(document),
          content_hash: contentHash,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      return { policyId: policy.id, policyVersionId: created.id, version, reused: false };
    });
  }

  /**
   * Approves a version, making it selectable by bare name.
   *
   * A policy change is a security-posture change, so it carries the same second-pair-of-eyes
   * gate a prompt does -- arguably more so: loosening a denylist is the edit nobody notices.
   */
  async approve(ref: string, version: number): Promise<Record<string, unknown>> {
    const ctx = requireContext();
    const target = await this.requireVersion(ref, version);
    if (target.approved_at !== null) {
      return { ref, version, alreadyApproved: true, approvedAt: target.approved_at };
    }
    await this.db
      .updateTable('policy_versions')
      .set({ approved_by: ctx.callerPrincipalId, approved_at: new Date() })
      .where('id', '=', target.id)
      .execute();
    return { ref, version, approved: true, approvedBy: ctx.callerPrincipalId };
  }

  /** Resolves `ref` or `ref@3` to one immutable version, approved-only for a bare name. */
  async resolve(refs: string[]): Promise<{ resolved: ResolvedPolicy[]; rejections: string[] }> {
    const ctx = requireContext();
    const resolved: ResolvedPolicy[] = [];
    const rejections: string[] = [];

    for (const raw of refs) {
      const at = raw.lastIndexOf('@');
      const name = at === -1 ? raw : raw.slice(0, at);
      const pinned = at === -1 ? null : Number(raw.slice(at + 1));
      if (pinned !== null && !Number.isInteger(pinned)) {
        rejections.push(`policy: "${raw}" has a non-integer version`);
        continue;
      }

      let q = this.db
        .selectFrom('policy_versions as pv')
        .innerJoin('policies as p', 'p.id', 'pv.policy_id')
        .select(['pv.id', 'pv.version', 'pv.document', 'pv.content_hash', 'pv.approved_at', 'p.ref'])
        .where('p.org_id', '=', ctx.orgId)
        .where('p.ref', '=', name);

      q = pinned === null
        ? q.where('pv.approved_at', 'is not', null)
        : q.where('pv.version', '=', pinned);

      const row = await q.orderBy('pv.version', 'desc').limit(1).executeTakeFirst();
      if (!row) {
        rejections.push(
          pinned === null
            ? `policy: "${name}" has no APPROVED version. Approve one, or pin an explicit ` +
              `version like "${name}@1" to test an unapproved draft.`
            : `policy: "${name}" has no version ${pinned}`,
        );
        continue;
      }

      // Re-parsed on read rather than trusted. A row written before a schema change would
      // otherwise be enforced with fields the current code does not understand -- and for
      // a security document, silently ignoring a clause is the worst available outcome.
      const doc = policyDocumentSchema.safeParse(row.document ?? {});
      if (!doc.success) {
        rejections.push(
          `policy: "${name}@${row.version}" no longer parses against the current document ` +
            `schema and cannot be enforced (${doc.error.issues[0]?.message ?? 'invalid'})`,
        );
        continue;
      }

      resolved.push({
        policyVersionId: row.id,
        ref: row.ref,
        version: row.version,
        document: doc.data,
        contentHash: row.content_hash,
        approved: row.approved_at !== null,
      });
    }
    return { resolved, rejections };
  }

  async list() {
    const ctx = requireContext();
    return this.db
      .selectFrom('policies as p')
      .leftJoin('policy_versions as pv', 'pv.policy_id', 'p.id')
      .select(({ fn }) => [
        'p.id', 'p.ref', 'p.owner',
        fn.max<number | null>('pv.version').as('latest_version'),
        fn.count<string>('pv.id').as('version_count'),
      ])
      .where('p.org_id', '=', ctx.orgId)
      .groupBy(['p.id', 'p.ref', 'p.owner'])
      .orderBy('p.ref')
      .execute();
  }

  async versions(ref: string) {
    const ctx = requireContext();
    const rows = await this.db
      .selectFrom('policy_versions as pv')
      .innerJoin('policies as p', 'p.id', 'pv.policy_id')
      .select([
        'pv.id', 'pv.version', 'pv.content_hash', 'pv.approved_by', 'pv.approved_at',
        'pv.created_at',
      ])
      .where('p.org_id', '=', ctx.orgId)
      .where('p.ref', '=', ref)
      .orderBy('pv.version', 'desc')
      .execute();
    if (rows.length === 0) throw new NotFound('policy', ref);
    return rows;
  }

  async version(ref: string, version: number) {
    return this.requireVersion(ref, version);
  }

  /**
   * Which agent versions pin this policy version.
   *
   * The blast-radius question, and for a policy it is the one that matters: "if I tighten
   * this, who stops working?" As with prompts the honest answer is "nobody until they
   * republish" -- pinning means a policy edit cannot reach into a running agent.
   */
  async usage(ref: string, version: number) {
    const target = await this.requireVersion(ref, version);
    return this.db
      .selectFrom('agent_versions as av')
      .leftJoin('agents as a', 'a.id', 'av.agent_id')
      .select(['av.id', 'a.name as agent_name', 'av.version as agent_version', 'av.lifetime'])
      .where('av.policy_version_id', '=', target.id)
      .orderBy('av.created_at', 'desc')
      .limit(100)
      .execute();
  }

  private async requireVersion(ref: string, version: number) {
    const ctx = requireContext();
    const row = await this.db
      .selectFrom('policy_versions as pv')
      .innerJoin('policies as p', 'p.id', 'pv.policy_id')
      .select([
        'pv.id', 'pv.version', 'pv.document', 'pv.content_hash',
        'pv.approved_by', 'pv.approved_at', 'pv.created_at', 'p.ref', 'p.owner',
      ])
      .where('p.org_id', '=', ctx.orgId)
      .where('p.ref', '=', ref)
      .where('pv.version', '=', version)
      .executeTakeFirst();
    if (!row) throw new PlatformError('not_found', `Policy "${ref}" has no version ${version}`);
    return row;
  }
}
