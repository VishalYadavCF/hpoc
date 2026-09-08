import { Inject, Injectable } from '@nestjs/common';
import type { Grader, GraderKind, GraderRegistry } from '../../domain/ports/grader.port.js';
import {
  BudgetGrader,
  ContainsGrader,
  ExactGrader,
  JsonPathGrader,
  NotContainsGrader,
  RegexGrader,
} from './deterministic.graders.js';
import { LlmJudgeGrader } from './llm-judge.grader.js';

/**
 * Resolves a case's declared grader kind to exactly one implementation.
 *
 * Built from an explicit list rather than by scanning: a grader kind the database accepts
 * (the CHECK constraint on `eval_cases.grader`) but no class implements would otherwise
 * fail at grading time, mid-suite, after real runs had been spent. The boot assertion
 * below turns that into a startup failure instead.
 */
@Injectable()
export class GraderRegistryImpl implements GraderRegistry {
  private readonly byKind: Map<GraderKind, Grader>;

  constructor(
    @Inject(ExactGrader) exact: ExactGrader,
    @Inject(ContainsGrader) contains: ContainsGrader,
    @Inject(NotContainsGrader) notContains: NotContainsGrader,
    @Inject(RegexGrader) regex: RegexGrader,
    @Inject(JsonPathGrader) jsonPath: JsonPathGrader,
    @Inject(BudgetGrader) budget: BudgetGrader,
    @Inject(LlmJudgeGrader) judge: LlmJudgeGrader,
  ) {
    const all: Grader[] = [exact, contains, notContains, regex, jsonPath, budget, judge];
    this.byKind = new Map(all.map((g) => [g.kind, g]));

    // Every kind the schema permits must have an implementation here. Kept as a literal
    // list so adding a kind to the migration without adding a class fails at boot.
    const required: GraderKind[] = [
      'exact', 'contains', 'not_contains', 'regex', 'json_path', 'budget', 'llm_judge',
    ];
    const missing = required.filter((k) => !this.byKind.has(k));
    if (missing.length > 0) {
      throw new Error(`No grader implementation for: ${missing.join(', ')}`);
    }
  }

  for(kind: GraderKind): Grader {
    const grader = this.byKind.get(kind);
    // Unreachable given the constructor check, and thrown rather than defaulted anyway:
    // silently grading with the wrong grader produces a number that means nothing.
    if (!grader) throw new Error(`No grader registered for kind "${kind}"`);
    return grader;
  }
}
