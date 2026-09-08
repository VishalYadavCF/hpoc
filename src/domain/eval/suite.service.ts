import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { AdmissionRejected, NotFound } from '../errors/platform.errors.js';
import type { GraderKindValue, Mechanism } from '../../platform/persistence/schema.types.js';

export interface CaseInput {
  name: string;
  input: unknown;
  expectation: unknown;
  grader: GraderKindValue;
  weight?: number;
  /** False for cases that only make sense with the mechanism on. */
  abComparable?: boolean;
}

export interface UpsertSuiteInput {
  ref: string;
  description?: string | null;
  mechanismUnderTest?: Mechanism | null;
  minScore?: number;
  minMechanismDelta?: number;
  /** §0.5: repeats per case, so a re-run is distinguishable from a regression. */
  trialsPerCase?: number;
  cases: CaseInput[];
}

/**
 * Suite authoring.
 *
 * Cases are REPLACED wholesale on upsert rather than merged. A merge would leave a case
 * an author deleted still scoring, and a suite whose contents differ from what its author
 * believes gates on evidence nobody reviewed.
 */
@Injectable()
export class EvalSuiteService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uow: UnitOfWork,
  ) {}

  async upsert(input: UpsertSuiteInput): Promise<{ id: string; ref: string; cases: number }> {
    const ctx = requireContext();
    const rejections: string[] = [];
    if (input.cases.length === 0) {
      rejections.push('cases: a suite with no cases would score 1.0 by vacuous aggregation');
    }
    const names = new Set<string>();
    for (const c of input.cases) {
      if (names.has(c.name)) rejections.push(`cases: duplicate name "${c.name}"`);
      names.add(c.name);
    }
    // §0.5 again: a suite claiming to test a mechanism needs at least one case that can
    // be compared with it off, or the A/B it exists to enable is impossible.
    if (input.mechanismUnderTest && input.mechanismUnderTest !== 'none') {
      const comparable = input.cases.filter((c) => c.abComparable !== false).length;
      if (comparable === 0) {
        rejections.push(
          `cases: this suite names mechanism "${input.mechanismUnderTest}" but no case is ` +
            `abComparable, so no A/B is possible`,
        );
      }
    }
    if (rejections.length > 0) throw new AdmissionRejected(rejections);

    return this.uow.run(async (tx) => {
      const suite = await tx
        .insertInto('eval_suites')
        .values({
          org_id: ctx.orgId,
          namespace_id: ctx.namespaceId,
          ref: input.ref,
          description: input.description ?? null,
          mechanism_under_test: input.mechanismUnderTest ?? null,
          min_score: String(input.minScore ?? 0.7),
          min_mechanism_delta: String(input.minMechanismDelta ?? 0.05),
          trials_per_case: input.trialsPerCase ?? 1,
        })
        .onConflict((oc) =>
          oc.columns(['org_id', 'ref']).doUpdateSet({
            description: input.description ?? null,
            mechanism_under_test: input.mechanismUnderTest ?? null,
            min_score: String(input.minScore ?? 0.7),
            min_mechanism_delta: String(input.minMechanismDelta ?? 0.05),
            trials_per_case: input.trialsPerCase ?? 1,
          }),
        )
        .returning(['id', 'ref'])
        .executeTakeFirstOrThrow();

      // Historical eval_case_results reference these rows; ON DELETE CASCADE takes them
      // with the case. That is correct — a result for a case that no longer exists cannot
      // be interpreted — and it is why `eval_runs` stores its own aggregate score rather
      // than recomputing from results.
      await tx.deleteFrom('eval_cases').where('eval_suite_id', '=', suite.id).execute();
      await tx
        .insertInto('eval_cases')
        .values(
          input.cases.map((c) => ({
            eval_suite_id: suite.id,
            name: c.name,
            input: JSON.stringify(c.input ?? null),
            expectation: JSON.stringify(c.expectation ?? null),
            weight: c.weight ?? 1,
            grader: c.grader,
            ab_comparable: c.abComparable ?? true,
          })),
        )
        .execute();

      return { id: suite.id, ref: suite.ref, cases: input.cases.length };
    });
  }

  async list() {
    const ctx = requireContext();
    return this.db
      .selectFrom('eval_suites as s')
      .leftJoin('eval_cases as c', 'c.eval_suite_id', 's.id')
      .select(({ fn }) => [
        's.id', 's.ref', 's.description', 's.mechanism_under_test',
        's.min_score', 's.min_mechanism_delta', 's.trials_per_case',
        fn.count<string>('c.id').as('case_count'),
      ])
      .where('s.org_id', '=', ctx.orgId)
      .groupBy([
        's.id', 's.ref', 's.description', 's.mechanism_under_test', 's.min_score',
        's.min_mechanism_delta', 's.trials_per_case',
      ])
      .orderBy('s.ref')
      .execute();
  }

  async get(ref: string) {
    const ctx = requireContext();
    const suite = await this.db
      .selectFrom('eval_suites')
      .select(['id', 'ref', 'description', 'mechanism_under_test', 'min_score', 'min_mechanism_delta'])
      .where('org_id', '=', ctx.orgId)
      .where('ref', '=', ref)
      .executeTakeFirst();
    if (!suite) throw new NotFound('eval suite', ref);

    const cases = await this.db
      .selectFrom('eval_cases')
      .select(['name', 'grader', 'weight', 'ab_comparable', 'input', 'expectation'])
      .where('eval_suite_id', '=', suite.id)
      .orderBy('name')
      .execute();
    return { ...suite, cases };
  }

  /**
   * §0.5's ledger: which mechanisms have an eval, and what it last said.
   *
   * The report the principle actually requires. "Each mechanism has an eval demonstrating
   * current benefit" is unauditable without a list of mechanisms with no suite at all —
   * which is why the absent ones are enumerated rather than omitted.
   */
  async mechanismLedger() {
    const ctx = requireContext();
    const ALL: Mechanism[] = [
      'summarization', 'compaction', 'memory_tiers', 'planning_scaffold', 'sub_agents',
      'retrieval', 'eviction', 'skills', 'knowledge', 'model_cache', 'peers',
    ];

    // Only runs that actually ANSWERED the mechanism question count. A plain scoring run
    // of the same suite against some other version says nothing about whether the
    // mechanism helps -- and taking the most recent run of any kind meant a later
    // pass/fail run silently overwrote a standing `mechanism_justified` with `failed`,
    // which reads as "the mechanism was disproved" when nobody re-tested it at all.
    const rows = await this.db
      .selectFrom('eval_suites as s')
      .leftJoin('eval_runs as r', (join) =>
        join
          .onRef('r.eval_suite_id', '=', 's.id')
          .on('r.verdict', 'in', ['mechanism_justified', 'mechanism_not_justified', 'inconclusive']),
      )
      .select([
        's.ref', 's.mechanism_under_test', 's.min_mechanism_delta',
        'r.id as eval_run_id', 'r.verdict', 'r.score', 'r.started_at',
      ])
      .where('s.org_id', '=', ctx.orgId)
      .where('s.mechanism_under_test', 'is not', null)
      .orderBy('r.started_at', 'desc')
      .execute();

    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = row.mechanism_under_test!;
      if (!latest.has(key)) latest.set(key, row);
    }

    return ALL.map((mechanism) => {
      const row = latest.get(mechanism);
      if (!row) {
        return {
          mechanism,
          suiteRef: null,
          verdict: 'no_eval',
          note: '§0.5: a mechanism with no eval cannot be shown to help, and is a candidate for removal.',
        };
      }
      return {
        mechanism,
        suiteRef: row.ref,
        // A suite exists but has never been run as an A/B, so the mechanism is still
        // unjustified -- distinguished from `no_eval` because the fix is different:
        // one needs a suite written, the other needs it run with compareMechanism.
        verdict: row.verdict ?? 'never_compared',
        score: row.score === null ? null : Number(row.score),
        lastRunAt: row.started_at,
        minDelta: Number(row.min_mechanism_delta),
      };
    });
  }
}
