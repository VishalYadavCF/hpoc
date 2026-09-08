export const GRADER_REGISTRY = Symbol('GraderRegistry');

export type GraderKind =
  | 'exact' | 'contains' | 'not_contains' | 'regex' | 'json_path' | 'budget' | 'llm_judge';

export interface GradeInput {
  /** What the case declared it expects. Shape is the grader's own contract. */
  expectation: unknown;
  /** The run's output, whatever the agent produced. */
  output: unknown;
  /** Measured facts about the run, so a grader can score cost and latency, not just text. */
  observed: {
    latencyMs: number;
    costMicros: number;
    status: string;
    error: unknown;
  };
}

export interface Grade {
  /** 0..1. A continuous score rather than a boolean, so a near miss is visible. */
  score: number;
  passed: boolean;
  /** Why. Recorded per case, because an aggregate score explains nothing on its own. */
  detail: Record<string, unknown>;
}

/**
 * Scores one eval case.
 *
 * Graders are deliberately small and mostly deterministic. A suite whose every case is
 * judged by a model measures the judge as much as the agent, and when the score moves
 * nobody can say which one moved -- so `llm_judge` exists for the cases that genuinely
 * need it and is not the default.
 *
 * Every grader must return a score for a FAILED run too, rather than throwing. A crash
 * is a result: an agent that errors on a case has scored zero on it, and treating that as
 * "no data" is how a broken version passes a suite by not answering.
 */
export interface Grader {
  readonly kind: GraderKind;
  grade(input: GradeInput): Promise<Grade>;
}

export interface GraderRegistry {
  for(kind: GraderKind): Grader;
}
