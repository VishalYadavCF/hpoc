import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import { UnitOfWork } from '../../platform/persistence/unit-of-work.js';
import { requireContext } from '../../platform/context/platform-context.js';
import { AdmissionService } from '../admission/admission.service.js';
import { AgentVersionService } from '../registry/agent-version.service.js';
import { RunService } from '../run-engine/run.service.js';
import { GRADER_REGISTRY, type GraderKind, type GraderRegistry } from '../ports/grader.port.js';
import { NotFound, PlatformError } from '../errors/platform.errors.js';
import type { EvalVerdict } from '../../platform/persistence/schema.types.js';
import { withMechanismDisabled, type Mechanism } from './mechanism-variant.js';

export interface RunSuiteInput {
  suiteRef: string;
  agentVersionId: string;
  /** Run the A/B second arm as well, when the suite names a mechanism. */
  compareMechanism?: boolean;
  /** Per-case ceiling. A hung case must not hold the whole suite open forever. */
  caseTimeoutMs?: number;
}

export interface EvalArm {
  evalRunId: string;
  mechanismEnabled: boolean | null;
  executedVersionId: string;
  score: number;
  passed: boolean;
  casesTotal: number;
  casesPassed: number;
  casesErrored: number;
  p50LatencyMs: number | null;
  totalCostMicros: number;
  /** Trials per case for this arm. 1 means the score has no measurable spread. */
  trials: number;
  /**
   * Standard error of `score`, propagated from the per-case spread. Null at one trial --
   * one sample has no spread, and reporting 0 would claim precision rather than absence.
   */
  scoreStderr: number | null;
  /** Cases that did not agree with themselves across trials: the agent is non-deterministic here. */
  flakyCases: { name: string; scores: number[] }[];
}

export interface SuiteResult {
  suiteRef: string;
  primary: EvalArm;
  baseline?: EvalArm;
  mechanism?: Mechanism;
  /** primary − baseline, over comparable cases only. */
  delta?: number;
  verdict: EvalVerdict;
  /** Why the verdict is what it is, in words a human can argue with. */
  rationale: string;
}

/**
 * The eval harness (§15.5).
 *
 * Two jobs, and the second is the one that matters. The first is ordinary: score a version
 * against a suite and gate promotion on it. The second is to answer §0.5 — "each
 * mechanism has an eval demonstrating current benefit; one that cannot be shown to help is
 * removed" — which requires comparing the SAME suite against the same version with the
 * mechanism on and off.
 *
 * Two design commitments run through it:
 *
 *  - **Eval runs are real runs.** Cases execute through `RunService` on real, admitted
 *    versions in the ordinary queue. A parallel execution path would let the harness
 *    measure something production does not do, and the discrepancy would be discovered
 *    the first time a suite passed and the deploy failed.
 *
 *  - **The verdict refuses to overclaim.** A 0.1 difference over four cases is noise, and
 *    reporting it as "the mechanism helps" is worse than reporting nothing, because it
 *    launders a coin flip into evidence. So there is an explicit minimum sample and a
 *    minimum margin, and below either the verdict is `inconclusive` — not `justified`,
 *    and not `not_justified` either.
 */
@Injectable()
export class EvalService {
  private readonly log = new Logger(EvalService.name);

  /**
   * Below this many comparable cases, a difference is not evidence.
   *
   * Chosen, not derived: this harness does no significance testing, and pretending
   * otherwise would be the exact overclaim the verdict logic exists to prevent. Five is
   * a floor that stops a two-case suite from deciding a mechanism's fate; it is not a
   * substitute for a real experiment, and `ai-docs/evals.md` says so.
   */
  private static readonly MIN_COMPARABLE_CASES = 5;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly admission: AdmissionService,
    private readonly versions: AgentVersionService,
    private readonly runs: RunService,
    @Inject(GRADER_REGISTRY) private readonly graders: GraderRegistry,
  ) {}

  async run(input: RunSuiteInput): Promise<SuiteResult> {
    const ctx = requireContext();
    const suite = await this.db
      .selectFrom('eval_suites')
      .select([
        'id', 'ref', 'mechanism_under_test', 'min_score', 'min_mechanism_delta',
        'trials_per_case',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('ref', '=', input.suiteRef)
      .executeTakeFirst();
    if (!suite) throw new NotFound('eval suite', input.suiteRef);

    const cases = await this.db
      .selectFrom('eval_cases')
      .select(['id', 'name', 'input', 'expectation', 'weight', 'grader', 'ab_comparable'])
      .where('eval_suite_id', '=', suite.id)
      .orderBy('name')
      .execute();
    if (cases.length === 0) {
      // A suite with no cases would score 1.0 by vacuous aggregation and pass every gate.
      throw new PlatformError('admission_rejected', `Suite "${suite.ref}" has no cases`, {
        hint: 'An empty suite would pass every gate it gates',
      });
    }

    const minScore = Number(suite.min_score);
    const mechanism = (suite.mechanism_under_test ?? 'none') as Mechanism;
    const timeoutMs = input.caseTimeoutMs ?? 120_000;
    // From the suite, deliberately: a trial count supplied per call could be turned down
    // until a flaky suite looked stable, which is the failure this feature exists to stop.
    const trials = suite.trials_per_case;

    // Arm one: the version exactly as published.
    const primary = await this.executeArm({
      suiteId: suite.id,
      declaredVersionId: input.agentVersionId,
      executedVersionId: input.agentVersionId,
      mechanismEnabled: mechanism === 'none' ? null : true,
      cases,
      minScore,
      trials,
      timeoutMs,
    });

    if (!input.compareMechanism || mechanism === 'none') {
      const verdict: EvalVerdict = primary.passed ? 'passed' : 'failed';
      await this.setVerdict(primary.evalRunId, verdict);
      return {
        suiteRef: suite.ref,
        primary,
        verdict,
        rationale: primary.passed
          ? `Scored ${primary.score.toFixed(4)} against a minimum of ${minScore}.`
          : `Scored ${primary.score.toFixed(4)}, below the suite minimum of ${minScore}.`,
      };
    }

    // Arm two: the same spec with the mechanism off, materialised as its own version.
    const variantId = await this.materialiseVariant(input.agentVersionId, mechanism);
    if (!variantId) {
      const verdict: EvalVerdict = primary.passed ? 'passed' : 'failed';
      await this.setVerdict(primary.evalRunId, verdict);
      return {
        suiteRef: suite.ref,
        primary,
        mechanism,
        verdict,
        rationale:
          `Cannot compare: "${mechanism}" is already disabled on this version, or is not ` +
          `expressible in its spec. No delta was computed rather than one against an ` +
          `identical spec, which would read as "no benefit".`,
      };
    }

    const comparable = cases.filter((c) => c.ab_comparable);
    const baseline = await this.executeArm({
      suiteId: suite.id,
      declaredVersionId: input.agentVersionId,
      executedVersionId: variantId,
      mechanismEnabled: false,
      cases: comparable,
      trials,
      minScore,
      timeoutMs,
      baselineOf: primary.evalRunId,
    });

    // Scored over COMPARABLE cases on both sides. Comparing a full primary against a
    // filtered baseline would attribute the excluded cases' scores to the mechanism.
    const primaryComparable = await this.scoreOver(primary.evalRunId, comparable.map((c) => c.id), comparable);
    const delta = primaryComparable - baseline.score;
    const minDelta = Number(suite.min_mechanism_delta);

    const { verdict, rationale } = this.judgeMechanism({
      mechanism,
      comparableCount: comparable.length,
      primaryScore: primaryComparable,
      baselineScore: baseline.score,
      trials,
      // Combined standard error of the DIFFERENCE of two independent means.
      deltaStderr:
        primary.scoreStderr !== null && baseline.scoreStderr !== null
          ? Math.sqrt(primary.scoreStderr ** 2 + baseline.scoreStderr ** 2)
          : null,
      delta,
      minDelta,
      primaryPassed: primary.passed,
      minScore,
    });

    await this.setVerdict(primary.evalRunId, verdict);
    await this.db
      .updateTable('eval_runs')
      .set({ baseline_eval_run_id: primary.evalRunId })
      .where('id', '=', baseline.evalRunId)
      .execute();

    return { suiteRef: suite.ref, primary, baseline, mechanism, delta, verdict, rationale };
  }

  /**
   * The verdict rules, in one place and stated plainly.
   *
   * Kept as a pure function so the thresholds are visible and arguable rather than spread
   * through the execution path.
   */
  private judgeMechanism(args: {
    mechanism: Mechanism;
    comparableCount: number;
    primaryScore: number;
    baselineScore: number;
    delta: number;
    minDelta: number;
    primaryPassed: boolean;
    minScore: number;
    trials: number;
    /** Null when either arm ran a single trial and therefore has no measured spread. */
    deltaStderr: number | null;
  }): { verdict: EvalVerdict; rationale: string } {
    const d = args.delta.toFixed(4);
    const on = args.primaryScore.toFixed(4);
    const off = args.baselineScore.toFixed(4);

    if (args.comparableCount < EvalService.MIN_COMPARABLE_CASES) {
      return {
        verdict: 'inconclusive',
        rationale:
          `${args.comparableCount} comparable case(s) is below the floor of ` +
          `${EvalService.MIN_COMPARABLE_CASES}. On with the mechanism scored ${on}, without ${off} ` +
          `(delta ${d}), but a difference over this few cases is not evidence either way. ` +
          `This harness does no significance testing; add cases before deciding.`,
      };
    }
    // The noise floor, and the reason `trials_per_case` exists. A delta that clears the
    // declared margin but sits inside the spread the SAME configuration produces when
    // re-run is not evidence -- it is the re-run indistinguishable from a regression that
    // §15.5's gate would otherwise act on. Two standard errors is a ~95% band under a
    // normal approximation; with a handful of trials that approximation is rough, which is
    // why this returns `inconclusive` and names the numbers rather than asserting
    // significance it has not earned.
    if (args.deltaStderr !== null && Math.abs(args.delta) < 2 * args.deltaStderr) {
      return {
        verdict: 'inconclusive',
        rationale:
          `"${args.mechanism}" moved the score by ${d} (${on} with, ${off} without) over ` +
          `${args.comparableCount} comparable cases at ${args.trials} trial(s) each, but the ` +
          `run-to-run spread is ±${(2 * args.deltaStderr).toFixed(4)}. The difference is ` +
          `inside the noise this suite produces re-running the same configuration, so it is ` +
          `not evidence either way. Raise trials_per_case or add cases to tighten the band.`,
      };
    }

    if (args.delta >= args.minDelta) {
      return {
        verdict: 'mechanism_justified',
        rationale:
          `"${args.mechanism}" improved the score by ${d} (${on} with, ${off} without) over ` +
          `${args.comparableCount} comparable cases, clearing the required margin of ` +
          `${args.minDelta}` +
          (args.deltaStderr === null
            ? ` — measured once per case, so this carries no confidence interval.`
            : ` and the ±${(2 * args.deltaStderr).toFixed(4)} run-to-run spread over ` +
              `${args.trials} trials.`),
      };
    }
    if (args.delta <= -args.minDelta) {
      return {
        verdict: 'mechanism_not_justified',
        rationale:
          `"${args.mechanism}" made the score WORSE by ${Math.abs(args.delta).toFixed(4)} ` +
          `(${on} with, ${off} without). §0.5: a mechanism that cannot be shown to help is ` +
          `removed, and this one is actively harmful on this suite.`,
      };
    }
    return {
      verdict: 'mechanism_not_justified',
      rationale:
        `"${args.mechanism}" changed the score by ${d} (${on} with, ${off} without), inside ` +
        `the required margin of ${args.minDelta} over ${args.comparableCount} cases. §0.5 ` +
        `treats a mechanism that cannot demonstrate benefit as dead weight, so the burden ` +
        `of proof is on keeping it, not on removing it.`,
    };
  }

  /**
   * Materialises the mechanism-off variant as a real, separately-admitted version.
   *
   * It goes through admission for the same reason any spec does: the variant is a spec the
   * caller is asking the platform to execute, and skipping admission for it would make the
   * eval path the one way to run an unadmitted spec.
   */
  private async materialiseVariant(versionId: string, mechanism: Mechanism): Promise<string | null> {
    const ctx = requireContext();
    const row = await this.db
      .selectFrom('agent_versions')
      .select(['spec', 'namespace_id', 'workload_identity_id'])
      .where('id', '=', versionId)
      .executeTakeFirst();
    if (!row) throw new NotFound('agent version', versionId);

    // Re-parsed through admission rather than cast: a stored spec predates any later
    // schema change, and the variant must be valid under TODAY's schema to be runnable.
    const admittedOriginal = await this.admission.admit({
      orgId: ctx.orgId,
      namespaceId: row.namespace_id,
      callerPrincipalId: ctx.callerPrincipalId,
      rawSpec: row.spec,
    });

    const variantSpec = withMechanismDisabled(admittedOriginal.spec, mechanism);
    if (!variantSpec) return null;

    const admitted = await this.admission.admit({
      orgId: ctx.orgId,
      namespaceId: row.namespace_id,
      callerPrincipalId: ctx.callerPrincipalId,
      rawSpec: variantSpec,
    });

    // Ephemeral and content-addressed, so repeated A/Bs of the same pair reuse one row
    // rather than accumulating a version per eval run.
    const version = await this.uow.run((tx) =>
      this.versions.materialiseEphemeral({
        tx,
        orgId: ctx.orgId,
        namespaceId: row.namespace_id,
        workloadIdentityId: row.workload_identity_id,
        admission: admitted,
      }),
    );
    return version.id;
  }

  private async executeArm(args: {
    suiteId: string;
    declaredVersionId: string;
    executedVersionId: string;
    mechanismEnabled: boolean | null;
    cases: { id: string; name: string; input: unknown; expectation: unknown; weight: number; grader: string }[];
    minScore: number;
    timeoutMs: number;
    trials: number;
    baselineOf?: string;
  }): Promise<EvalArm> {
    const evalRun = await this.db
      .insertInto('eval_runs')
      .values({
        eval_suite_id: args.suiteId,
        agent_version_id: args.declaredVersionId,
        executed_version_id: args.executedVersionId,
        mechanism_enabled: args.mechanismEnabled,
        min_score: String(args.minScore),
        cases_total: args.cases.length,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    let weighted = 0;
    let weightTotal = 0;
    let passedCount = 0;
    let erroredCount = 0;
    let costTotal = 0;
    const latencies: number[] = [];

    // Variance accumulators. `varianceTerms` collects w_i^2 * Var(mean_i) so the run-level
    // standard error can be propagated from the per-case spread at the end.
    const flakyCases: { name: string; scores: number[] }[] = [];
    let varianceTerms = 0;

    for (const c of args.cases) {
      const weight = Number(c.weight) || 1;
      const scores: number[] = [];
      let casePassedAll = true;

      for (let trial = 1; trial <= args.trials; trial++) {
        const outcome = await this.executeCase(args.executedVersionId, c, args.timeoutMs);
        if (outcome.errored) erroredCount += 1;
        costTotal += outcome.costMicros;
        latencies.push(outcome.latencyMs);
        scores.push(outcome.grade.score);
        if (!outcome.grade.passed) casePassedAll = false;

        await this.db
          .insertInto('eval_case_results')
          .values({
            eval_run_id: evalRun.id,
            eval_case_id: c.id,
            trial,
            run_id: outcome.runId,
            score: String(outcome.grade.score),
            passed: outcome.grade.passed,
            detail: JSON.stringify({
              ...outcome.grade.detail,
              grader: c.grader,
              trial,
              latencyMs: outcome.latencyMs,
              costMicros: outcome.costMicros,
            }),
          })
          .onConflict((oc) => oc.columns(['eval_run_id', 'eval_case_id', 'trial']).doNothing())
          .execute();
      }

      // The case's score is the MEAN across its trials, so one lucky run cannot carry it.
      const mean = scores.reduce((t, v) => t + v, 0) / scores.length;
      weighted += mean * weight;
      weightTotal += weight;
      // A case counts as passed only if it passed EVERY trial. Anything else is a case
      // that sometimes fails, and calling that "passed" is how a flaky gate goes green.
      if (casePassedAll) passedCount += 1;

      if (scores.length > 1) {
        // Sample variance (n-1): with a handful of trials the population form is biased
        // low, which would understate noise -- the direction that produces false confidence.
        const variance =
          scores.reduce((t, v) => t + (v - mean) ** 2, 0) / (scores.length - 1);
        varianceTerms += weight ** 2 * (variance / scores.length);
        // Disagreeing with itself is worth surfacing on its own: it means the case or the
        // agent is non-deterministic, which is information a score alone hides.
        if (Math.max(...scores) - Math.min(...scores) > 1e-9) {
          flakyCases.push({ name: c.name, scores });
        }
      }
    }

    // Weighted, so a suite can say which cases matter. Guarded against zero because a
    // suite of zero-weight cases would otherwise divide by zero and score NaN, which
    // compares false against every threshold and would silently fail every gate.
    const score = weightTotal > 0 ? weighted / weightTotal : 0;
    const passed = score >= args.minScore;
    // Propagated, not measured directly: score = Σ(w_i·mean_i)/Σw_i, so its variance is
    // Σ(w_i²·Var(mean_i))/(Σw_i)². Null at one trial rather than 0 -- see EvalArm.
    const scoreStderr =
      args.trials > 1 && weightTotal > 0 ? Math.sqrt(varianceTerms) / weightTotal : null;

    await this.db
      .updateTable('eval_runs')
      .set({
        score: String(score),
        passed,
        cases_passed: passedCount,
        cases_errored: erroredCount,
        p50_latency_ms: percentile(latencies, 50),
        total_cost_micros: String(costTotal),
        score_stderr: scoreStderr === null ? null : String(scoreStderr.toFixed(4)),
        ended_at: sql`now()`,
        ...(args.baselineOf ? { baseline_eval_run_id: args.baselineOf } : {}),
      })
      .where('id', '=', evalRun.id)
      .execute();

    return {
      evalRunId: evalRun.id,
      mechanismEnabled: args.mechanismEnabled,
      executedVersionId: args.executedVersionId,
      score,
      passed,
      casesTotal: args.cases.length,
      casesPassed: passedCount,
      casesErrored: erroredCount,
      p50LatencyMs: percentile(latencies, 50),
      totalCostMicros: costTotal,
      trials: args.trials,
      scoreStderr,
      flakyCases,
    };
  }

  /** One case: a real run, settled, then graded. */
  private async executeCase(
    versionId: string,
    c: { name: string; input: unknown; expectation: unknown; grader: string },
    timeoutMs: number,
  ) {
    const startedAt = Date.now();
    const created = await this.runs.createFromVersion({
      agentVersionId: versionId,
      input: c.input,
      initiator: 'api',
      // No idempotency key, deliberately: two arms of an A/B send the same input, and a
      // key derived from it would make the second arm replay the first arm's run and
      // report a delta of exactly zero.
      idempotencyKey: null,
    });

    const settled = await this.settle(created.runId, timeoutMs);
    const latencyMs = Date.now() - startedAt;
    const grade = await this.graders.for(c.grader as GraderKind).grade({
      expectation: c.expectation,
      output: settled.output,
      observed: {
        latencyMs,
        costMicros: settled.costMicros,
        status: settled.status,
        error: settled.error,
      },
    });

    return {
      runId: created.runId,
      grade,
      latencyMs,
      costMicros: settled.costMicros,
      errored: settled.status !== 'completed',
    };
  }

  private async settle(runId: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await this.db
        .selectFrom('runs')
        .select(['status', 'output', 'error', 'cost_micros'])
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();

      if (['completed', 'failed', 'cancelled', 'dead_letter'].includes(run.status)) {
        return {
          status: run.status,
          output: run.output,
          error: run.error,
          costMicros: Number(run.cost_micros),
        };
      }
      if (Date.now() > deadline) {
        // Cancelled, not abandoned. A case left running would keep spending the tenant's
        // budget after the suite that asked for it had already reported.
        await this.runs.cancel(runId).catch(() => undefined);
        this.log.warn(`eval case run ${runId} timed out after ${timeoutMs}ms`);
        return { status: 'timeout', output: null, error: { code: 'timeout' }, costMicros: 0 };
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** Re-scores an existing arm over a subset of cases, for the like-for-like comparison. */
  private async scoreOver(
    evalRunId: string,
    caseIds: string[],
    cases: { id: string; weight: number }[],
  ): Promise<number> {
    if (caseIds.length === 0) return 0;
    const rows = await this.db
      .selectFrom('eval_case_results')
      .select(['eval_case_id', 'score'])
      .where('eval_run_id', '=', evalRunId)
      .where('eval_case_id', 'in', caseIds)
      .execute();

    const weights = new Map(cases.map((c) => [c.id, Number(c.weight) || 1]));
    let weighted = 0;
    let total = 0;
    for (const r of rows) {
      const w = weights.get(r.eval_case_id) ?? 1;
      weighted += Number(r.score ?? 0) * w;
      total += w;
    }
    return total > 0 ? weighted / total : 0;
  }

  private async setVerdict(evalRunId: string, verdict: EvalVerdict): Promise<void> {
    await this.db
      .updateTable('eval_runs')
      .set({ verdict })
      .where('id', '=', evalRunId)
      .execute();
  }

  async history(suiteRef: string, limit = 20) {
    const ctx = requireContext();
    return this.db
      .selectFrom('eval_runs as r')
      .innerJoin('eval_suites as s', 's.id', 'r.eval_suite_id')
      .select([
        'r.id', 'r.agent_version_id', 'r.executed_version_id', 'r.mechanism_enabled',
        'r.score', 'r.passed', 'r.verdict', 'r.cases_total', 'r.cases_passed',
        'r.cases_errored', 'r.p50_latency_ms', 'r.total_cost_micros',
        'r.baseline_eval_run_id', 'r.started_at', 'r.ended_at',
      ])
      .where('s.org_id', '=', ctx.orgId)
      .where('s.ref', '=', suiteRef)
      .orderBy('r.started_at', 'desc')
      .limit(limit)
      .execute();
  }

  /**
   * One eval run with its gate-relevant facts.
   *
   * Includes the baseline arm inline when there is one: a mechanism verdict is a statement
   * about a PAIR, and returning the primary alone would show a verdict with nothing to
   * justify it.
   */
  async evalRun(evalRunId: string) {
    const ctx = requireContext();
    const row = await this.db
      .selectFrom('eval_runs as r')
      .innerJoin('eval_suites as s', 's.id', 'r.eval_suite_id')
      .select([
        'r.id', 's.ref as suite_ref', 's.mechanism_under_test',
        'r.agent_version_id', 'r.executed_version_id', 'r.mechanism_enabled',
        'r.score', 'r.passed', 'r.min_score', 'r.verdict',
        'r.cases_total', 'r.cases_passed', 'r.cases_errored',
        'r.p50_latency_ms', 'r.total_cost_micros', 'r.baseline_eval_run_id',
        'r.started_at', 'r.ended_at',
      ])
      .where('s.org_id', '=', ctx.orgId)
      .where('r.id', '=', evalRunId)
      .executeTakeFirst();
    if (!row) throw new NotFound('eval run', evalRunId);

    // The other arm, in either direction: this row may be the primary (whose baseline
    // points down) or the baseline itself (whose primary points at it).
    const counterpart = await this.db
      .selectFrom('eval_runs')
      .select(['id', 'mechanism_enabled', 'score', 'passed', 'cases_total', 'total_cost_micros', 'p50_latency_ms'])
      .where((eb) =>
        eb.or([
          eb('id', '=', row.baseline_eval_run_id ?? '00000000-0000-0000-0000-000000000000'),
          eb('baseline_eval_run_id', '=', evalRunId),
        ]),
      )
      .executeTakeFirst();

    return {
      ...row,
      score: row.score === null ? null : Number(row.score),
      total_cost_micros: Number(row.total_cost_micros),
      ...(counterpart
        ? {
            counterpart: {
              ...counterpart,
              score: counterpart.score === null ? null : Number(counterpart.score),
              total_cost_micros: Number(counterpart.total_cost_micros),
            },
            delta:
              row.score !== null && counterpart.score !== null
                ? Number(row.score) - Number(counterpart.score)
                : null,
          }
        : {}),
    };
  }

  async caseResults(evalRunId: string) {
    return this.db
      .selectFrom('eval_case_results as r')
      .innerJoin('eval_cases as c', 'c.id', 'r.eval_case_id')
      .select(['c.name', 'c.grader', 'c.weight', 'c.ab_comparable', 'r.score', 'r.passed', 'r.detail', 'r.run_id'])
      .where('r.eval_run_id', '=', evalRunId)
      .orderBy('c.name')
      .execute();
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? null;
}
