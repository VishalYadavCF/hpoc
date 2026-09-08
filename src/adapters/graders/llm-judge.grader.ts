import { Inject, Injectable, Logger } from '@nestjs/common';
import { DB } from '../../platform/persistence/tokens.js';
import type { Db } from '../../platform/persistence/database.js';
import {
  MODEL_PROVIDER_REGISTRY,
  type ModelProvider,
} from '../../domain/ports/model-provider.port.js';
import { SECRET_STORE, type SecretStore } from '../../domain/ports/secret-store.port.js';
import type { Grade, GradeInput, Grader } from '../../domain/ports/grader.port.js';

export interface JudgeExpectation {
  /** What a good answer looks like, in words. The rubric IS the expectation. */
  rubric: string;
  /** The model that judges. Must be internal residency — see below. */
  judgeModelRef: string;
  /** Below this the case fails. Default is deliberately not generous. */
  minScore?: number;
}

/**
 * Rubric-scored grading by a model, for cases no deterministic grader can express —
 * tone, faithfulness to a source, whether a refusal was appropriate.
 *
 * **§16.1 Constraint 1 is absolute and applies here.** "Traces, metrics, evals, and
 * prompt/completion logs never leave our perimeter." A judge sends the case input AND the
 * agent's completion to a model; if that model is external, the eval corpus has left the
 * perimeter. So this grader resolves the judge model from the registry and REFUSES any
 * model whose residency is `external`, regardless of what the suite names.
 *
 * That refusal is not configurable, and it means this grader is unusable until a
 * self-hosted judge model is registered. That is the correct failure: the alternative is
 * a harness that quietly ships evaluation data to a vendor to make a suite look complete.
 *
 * It is also not the default grader. A suite judged entirely by a model measures the
 * judge as much as the agent, and when the number moves nobody can say which one moved.
 */
@Injectable()
export class LlmJudgeGrader implements Grader {
  readonly kind = 'llm_judge' as const;
  private readonly log = new Logger(LlmJudgeGrader.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODEL_PROVIDER_REGISTRY) private readonly providers: ModelProvider[],
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
  ) {}

  async grade(input: GradeInput): Promise<Grade> {
    const spec = input.expectation as JudgeExpectation | undefined;
    if (!spec?.rubric || !spec.judgeModelRef) {
      return {
        score: 0,
        passed: false,
        detail: { reason: 'case declares no rubric or no judgeModelRef' },
      };
    }

    const model = await this.db
      .selectFrom('models')
      .select(['id', 'ref', 'provider', 'provider_model_id', 'residency', 'status', 'credential_ref'])
      .where('ref', '=', spec.judgeModelRef)
      .executeTakeFirst();

    if (!model) {
      return { score: 0, passed: false, detail: { reason: `judge model "${spec.judgeModelRef}" is not registered` } };
    }
    if (model.residency !== 'internal') {
      // Refused, and reported as a BROKEN CASE rather than a failing agent. Scoring the
      // agent zero here would blame it for a policy violation in the suite.
      this.log.warn(`refused external judge model "${model.ref}" (§16.1 Constraint 1)`);
      return {
        score: 0,
        passed: false,
        detail: {
          reason: 'judge model is external; evals may not leave the perimeter (§16.1 Constraint 1)',
          judgeModelRef: model.ref,
          residency: model.residency,
          hint: 'Register a self-hosted judge model with residency = internal',
        },
      };
    }
    if (model.status !== 'active') {
      return { score: 0, passed: false, detail: { reason: `judge model is ${model.status}` } };
    }

    // A failed run still gets a score, without spending a judge call on it: there is no
    // output to judge, and asking a model to rate an error teaches nothing.
    if (input.observed.status !== 'completed') {
      return {
        score: 0,
        passed: false,
        detail: { reason: 'run did not complete', status: input.observed.status },
      };
    }

    const provider = this.providers.find((p) => p.id === model.provider);
    if (!provider) {
      return { score: 0, passed: false, detail: { reason: `no provider adapter for "${model.provider}"` } };
    }
    const credentials = model.credential_ref
      ? ((await this.secrets.resolve(model.credential_ref)) ?? {})
      : {};

    const answer = typeof input.output === 'string' ? input.output : JSON.stringify(input.output);
    try {
      const response = await provider.complete(
        {
          providerModelId: model.provider_model_id,
          // The judge is told to output one number and nothing else. A judge asked for
          // prose has to be parsed, and a parser that guesses turns an unreadable verdict
          // into a confident score.
          systemPrompt:
            'You grade an AI answer against a rubric. Reply with ONLY a number from 0 to 100 ' +
            'and no other text. 100 means the answer fully satisfies the rubric; 0 means it ' +
            'does not satisfy it at all.',
          prompt: `RUBRIC:\n${spec.rubric}\n\nANSWER:\n${answer}\n\nScore (0-100):`,
          maxOutputTokens: 8,
        },
        credentials,
      );

      const parsed = /-?\d+(?:\.\d+)?/.exec(response.text ?? '');
      if (!parsed) {
        // Unparseable, so recorded as unparseable. Defaulting to 0 would make a judge
        // outage indistinguishable from a bad agent, and the suite would look regressed.
        return {
          score: 0,
          passed: false,
          detail: { reason: 'judge returned no number', raw: (response.text ?? '').slice(0, 200) },
        };
      }
      const score = Math.max(0, Math.min(1, Number(parsed[0]) / 100));
      const minScore = spec.minScore ?? 0.7;
      return {
        score,
        passed: score >= minScore,
        detail: { judgeModelRef: model.ref, score, minScore, raw: response.text?.slice(0, 200) },
      };
    } catch (e) {
      return { score: 0, passed: false, detail: { reason: 'judge call failed', error: (e as Error).message } };
    }
  }
}
