import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { AdmissionRejected, NotFound, PlatformError } from '../errors/platform.errors.js';

export interface PublishPromptInput {
  ref: string;
  owner: string;
  body: string;
}

export interface ResolvedPrompt {
  promptVersionId: string;
  ref: string;
  version: number;
  body: string;
  contentHash: string;
  approved: boolean;
}

/**
 * The prompt registry (§17.2): "prompts are versioned platform resources, never blobs in a spec."
 *
 * Three properties distinguish it from just moving text into a table.
 *
 * **Immutable versions, content-addressed.** `UNIQUE (prompt_id, content_hash)` means
 * republishing identical text returns the version that already exists rather than minting
 * another. Prompt authoring is iterative and mostly re-saves; without this a registry
 * accumulates a version per keystroke and "which version is running" stops meaning anything.
 *
 * **Approval is a real gate.** `approved_by`/`approved_at` are in the schema because a
 * prompt change is a behaviour change. A bare name resolves only to an APPROVED version;
 * an explicit `ref@3` resolves that exact version whether approved or not, so an author
 * can pin an unapproved draft to test it but cannot ship one by accident.
 *
 * **No templating, deliberately.** Bodies are literal text with no variable substitution.
 * §18.5 names "interpolating variable content into the system prompt" as *"a direct
 * prompt-injection path, and a cache-defeating one"* — a registry that offered variables
 * would institutionalise exactly that, and would break the content hash's role as a
 * prompt-cache key (§10). Per-request content belongs in the user turn, where it is data
 * rather than instruction.
 */
@Injectable()
export class PromptService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uow: UnitOfWork,
  ) {}

  async publish(input: PublishPromptInput): Promise<{
    promptId: string;
    promptVersionId: string;
    version: number;
    reused: boolean;
  }> {
    const ctx = requireContext();
    const body = input.body.trim();
    const rejections: string[] = [];
    if (body.length === 0) rejections.push('body: must not be empty');
    if (body.length > 100_000) rejections.push('body: exceeds 100000 characters');
    // Caught here rather than at render time. A `{{name}}` in a body means the author
    // expects substitution that will never happen, and the model would receive the braces
    // verbatim -- a silent behaviour bug rather than a refused publish.
    const placeholder = /\{\{\s*[A-Za-z_][A-Za-z0-9_.]*\s*\}\}|\$\{[A-Za-z_]/.exec(body);
    if (placeholder) {
      rejections.push(
        `body: contains what looks like a template placeholder ("${placeholder[0]}"), but prompts ` +
          `are literal text. §18.5 treats interpolating variable content into a system prompt as a ` +
          `prompt-injection and cache-defeating path; put per-request content in the user turn.`,
      );
    }
    if (rejections.length > 0) throw new AdmissionRejected(rejections);

    const contentHash = createHash('sha256').update(body).digest('hex');

    return this.uow.run(async (tx) => {
      const prompt = await tx
        .insertInto('prompts')
        .values({
          org_id: ctx.orgId,
          namespace_id: ctx.namespaceId,
          ref: input.ref,
          owner: input.owner,
        })
        .onConflict((oc) => oc.columns(['org_id', 'ref']).doUpdateSet({ owner: input.owner }))
        .returning('id')
        .executeTakeFirstOrThrow();

      const existing = await tx
        .selectFrom('prompt_versions')
        .select(['id', 'version'])
        .where('prompt_id', '=', prompt.id)
        .where('content_hash', '=', contentHash)
        .executeTakeFirst();
      if (existing) {
        // Identical text is the same version. Reported as `reused` so a caller can tell
        // "I published something new" from "that was already there".
        return {
          promptId: prompt.id,
          promptVersionId: existing.id,
          version: existing.version,
          reused: true,
        };
      }

      // Under the transaction's lock, so two concurrent publishes cannot both mint v3.
      const last = await tx
        .selectFrom('prompt_versions')
        .select(({ fn }) => [fn.max<number | null>('version').as('max')])
        .where('prompt_id', '=', prompt.id)
        .executeTakeFirst();
      const version = (last?.max ?? 0) + 1;

      const created = await tx
        .insertInto('prompt_versions')
        .values({
          prompt_id: prompt.id,
          version,
          body,
          content_hash: contentHash,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      return { promptId: prompt.id, promptVersionId: created.id, version, reused: false };
    });
  }

  /**
   * Approves a version, making it selectable by bare name.
   *
   * The approver is recorded and cannot be the publisher's implicit self: approval exists
   * so a second person signs off on a behaviour change, and auto-approving on publish
   * would make the column decorative. Whether the same human may do both is a policy the
   * caller's own authorization enforces; the platform records who.
   */
  async approve(ref: string, version: number): Promise<Record<string, unknown>> {
    const ctx = requireContext();
    const target = await this.requireVersion(ref, version);
    if (target.approved_at !== null) {
      return { ref, version, alreadyApproved: true, approvedAt: target.approved_at };
    }
    await this.db
      .updateTable('prompt_versions')
      .set({ approved_by: ctx.callerPrincipalId, approved_at: new Date() })
      .where('id', '=', target.id)
      .execute();
    return { ref, version, approved: true, approvedBy: ctx.callerPrincipalId };
  }

  /**
   * Resolves `ref` or `ref@3` to one immutable version.
   *
   * A bare name takes the highest APPROVED version; a pin takes that exact version even
   * if unapproved, so a draft can be tested without becoming shippable by name.
   */
  async resolve(refs: string[]): Promise<{ resolved: ResolvedPrompt[]; rejections: string[] }> {
    const ctx = requireContext();
    const resolved: ResolvedPrompt[] = [];
    const rejections: string[] = [];

    for (const raw of refs) {
      const at = raw.lastIndexOf('@');
      const name = at === -1 ? raw : raw.slice(0, at);
      const pinned = at === -1 ? null : Number(raw.slice(at + 1));
      if (pinned !== null && !Number.isInteger(pinned)) {
        rejections.push(`prompt: "${raw}" has a non-integer version`);
        continue;
      }

      let q = this.db
        .selectFrom('prompt_versions as pv')
        .innerJoin('prompts as p', 'p.id', 'pv.prompt_id')
        .select(['pv.id', 'pv.version', 'pv.body', 'pv.content_hash', 'pv.approved_at', 'p.ref'])
        .where('p.org_id', '=', ctx.orgId)
        .where('p.ref', '=', name);

      q = pinned === null
        ? q.where('pv.approved_at', 'is not', null)
        : q.where('pv.version', '=', pinned);

      const row = await q.orderBy('pv.version', 'desc').limit(1).executeTakeFirst();
      if (!row) {
        rejections.push(
          pinned === null
            ? `prompt: "${name}" has no APPROVED version. Approve one, or pin an explicit ` +
              `version like "${name}@1" to run an unapproved draft.`
            : `prompt: "${name}" has no version ${pinned}`,
        );
        continue;
      }

      resolved.push({
        promptVersionId: row.id,
        ref: row.ref,
        version: row.version,
        body: row.body,
        contentHash: row.content_hash,
        approved: row.approved_at !== null,
      });
    }
    return { resolved, rejections };
  }

  async list() {
    const ctx = requireContext();
    return this.db
      .selectFrom('prompts as p')
      .leftJoin('prompt_versions as pv', 'pv.prompt_id', 'p.id')
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
      .selectFrom('prompt_versions as pv')
      .innerJoin('prompts as p', 'p.id', 'pv.prompt_id')
      .select([
        'pv.id', 'pv.version', 'pv.content_hash', 'pv.approved_by', 'pv.approved_at',
        'pv.created_at',
      ])
      .where('p.org_id', '=', ctx.orgId)
      .where('p.ref', '=', ref)
      .orderBy('pv.version', 'desc')
      .execute();
    if (rows.length === 0) throw new NotFound('prompt', ref);
    return rows;
  }

  async version(ref: string, version: number) {
    return this.requireVersion(ref, version);
  }

  /**
   * Which agent versions pin this prompt version.
   *
   * The question anyone asks before editing a prompt: what am I about to change? Because
   * agents pin a VERSION, the honest answer is "nothing until they republish" -- and this
   * makes that visible rather than something to reason about.
   */
  async usage(ref: string, version: number) {
    const target = await this.requireVersion(ref, version);
    return this.db
      .selectFrom('agent_versions as av')
      .leftJoin('agents as a', 'a.id', 'av.agent_id')
      .select(['av.id', 'a.name as agent_name', 'av.version as agent_version', 'av.lifetime'])
      .where('av.prompt_version_id', '=', target.id)
      .orderBy('av.created_at', 'desc')
      .limit(100)
      .execute();
  }

  private async requireVersion(ref: string, version: number) {
    const ctx = requireContext();
    const row = await this.db
      .selectFrom('prompt_versions as pv')
      .innerJoin('prompts as p', 'p.id', 'pv.prompt_id')
      .select([
        'pv.id', 'pv.version', 'pv.body', 'pv.content_hash',
        'pv.approved_by', 'pv.approved_at', 'pv.created_at', 'p.ref', 'p.owner',
      ])
      .where('p.org_id', '=', ctx.orgId)
      .where('p.ref', '=', ref)
      .where('pv.version', '=', version)
      .executeTakeFirst();
    if (!row) throw new PlatformError('not_found', `Prompt "${ref}" has no version ${version}`);
    return row;
  }
}
