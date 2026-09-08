import { Injectable } from '@nestjs/common';
import type { Grade, GradeInput, Grader } from '../../domain/ports/grader.port.js';

/**
 * Reduces a run's output to the text a grader compares.
 *
 * Agents return structured output whose shape is the framework's business (§0.3), so this
 * looks for the conventional text field and falls back to the whole JSON. Stringifying an
 * object with `String()` would yield "[object Object]" and make every text grader pass or
 * fail on that constant instead of on the answer.
 */
function asText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '';
  const text = (output as { text?: unknown }).text;
  if (typeof text === 'string') return text;
  return JSON.stringify(output);
}

/** A failed run has scored zero, not "no data" — see the Grader port. */
function zeroIfBroken(input: GradeInput): Grade | null {
  if (input.observed.status === 'completed') return null;
  return {
    score: 0,
    passed: false,
    detail: {
      reason: 'run did not complete',
      status: input.observed.status,
      error: input.observed.error,
    },
  };
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

@Injectable()
export class ExactGrader implements Grader {
  readonly kind = 'exact' as const;

  async grade(input: GradeInput): Promise<Grade> {
    const broken = zeroIfBroken(input);
    if (broken) return broken;

    const expected = String((input.expectation as { value?: unknown })?.value ?? input.expectation);
    const actual = asText(input.output);
    // Normalised: an assertion that fails on trailing whitespace or capitalisation tests
    // the harness rather than the agent, and gets suppressed rather than fixed.
    const passed = norm(expected) === norm(actual);
    return { score: passed ? 1 : 0, passed, detail: { expected, actual } };
  }
}

/**
 * Partial credit for required substrings.
 *
 * Fractional on purpose: an answer containing three of four required facts is genuinely
 * better than one containing none, and collapsing both to `false` throws away the signal
 * that tells you whether a change helped or merely failed differently.
 */
@Injectable()
export class ContainsGrader implements Grader {
  readonly kind = 'contains' as const;

  async grade(input: GradeInput): Promise<Grade> {
    const broken = zeroIfBroken(input);
    if (broken) return broken;

    const required = toList(input.expectation);
    if (required.length === 0) {
      return { score: 0, passed: false, detail: { reason: 'case declares no required strings' } };
    }
    const actual = norm(asText(input.output));
    const found = required.filter((r) => actual.includes(norm(r)));
    const score = found.length / required.length;
    return {
      score,
      passed: score === 1,
      detail: { required, found, missing: required.filter((r) => !found.includes(r)) },
    };
  }
}

/**
 * Absence of forbidden content — refusals, leaked identifiers, hallucinated specifics.
 *
 * All-or-nothing, unlike `contains`. Partial credit for leaking one secret out of three
 * would be an absurd thing to measure.
 */
@Injectable()
export class NotContainsGrader implements Grader {
  readonly kind = 'not_contains' as const;

  async grade(input: GradeInput): Promise<Grade> {
    const broken = zeroIfBroken(input);
    if (broken) return broken;

    const forbidden = toList(input.expectation);
    const actual = norm(asText(input.output));
    const present = forbidden.filter((f) => actual.includes(norm(f)));
    return {
      score: present.length === 0 ? 1 : 0,
      passed: present.length === 0,
      detail: { forbidden, present },
    };
  }
}

@Injectable()
export class RegexGrader implements Grader {
  readonly kind = 'regex' as const;

  async grade(input: GradeInput): Promise<Grade> {
    const broken = zeroIfBroken(input);
    if (broken) return broken;

    const spec = input.expectation as { pattern?: string; flags?: string };
    if (!spec?.pattern) {
      return { score: 0, passed: false, detail: { reason: 'case declares no pattern' } };
    }
    let re: RegExp;
    try {
      re = new RegExp(spec.pattern, spec.flags ?? 'i');
    } catch (e) {
      // A malformed pattern is a broken CASE, and it must not read as a failing AGENT --
      // that is how a typo in a suite gets attributed to a regression.
      return { score: 0, passed: false, detail: { reason: 'invalid pattern', error: (e as Error).message } };
    }
    const actual = asText(input.output);
    const match = re.exec(actual);
    return {
      score: match ? 1 : 0,
      passed: Boolean(match),
      detail: { pattern: spec.pattern, matched: match?.[0] ?? null },
    };
  }
}

/** Structured assertions, for agents whose output is data rather than prose. */
@Injectable()
export class JsonPathGrader implements Grader {
  readonly kind = 'json_path' as const;

  async grade(input: GradeInput): Promise<Grade> {
    const broken = zeroIfBroken(input);
    if (broken) return broken;

    const checks = (input.expectation as { checks?: { path: string; equals: unknown }[] })?.checks ?? [];
    if (checks.length === 0) {
      return { score: 0, passed: false, detail: { reason: 'case declares no checks' } };
    }
    const results = checks.map((c) => {
      const actual = resolvePath(input.output, c.path);
      // JSON-compared rather than ===, so {a:1} equals {a:1}. Reference equality would
      // fail every structural assertion for a reason invisible in the report.
      return { path: c.path, expected: c.equals, actual, ok: JSON.stringify(actual) === JSON.stringify(c.equals) };
    });
    const score = results.filter((r) => r.ok).length / results.length;
    return { score, passed: score === 1, detail: { checks: results } };
  }
}

/**
 * Latency and cost ceilings.
 *
 * The grader that makes §0.5 answerable in the direction that matters. "Did compaction
 * improve the answer" is one question; "did it make the run cheaper without making the
 * answer worse" is the one that decides whether to keep it, and it needs a grader that
 * scores something other than text.
 */
@Injectable()
export class BudgetGrader implements Grader {
  readonly kind = 'budget' as const;

  async grade(input: GradeInput): Promise<Grade> {
    const broken = zeroIfBroken(input);
    if (broken) return broken;

    const spec = (input.expectation ?? {}) as { maxLatencyMs?: number; maxCostMicros?: number };
    const limits: { name: string; actual: number; limit: number }[] = [];
    if (spec.maxLatencyMs !== undefined) {
      limits.push({ name: 'latencyMs', actual: input.observed.latencyMs, limit: spec.maxLatencyMs });
    }
    if (spec.maxCostMicros !== undefined) {
      limits.push({ name: 'costMicros', actual: input.observed.costMicros, limit: spec.maxCostMicros });
    }
    if (limits.length === 0) {
      return { score: 0, passed: false, detail: { reason: 'case declares no budget' } };
    }

    // Graded, not thresholded: a run at 1.05x the budget and one at 10x are both failures
    // but not the same failure, and a boolean cannot tell you which direction a change moved.
    const scores = limits.map((l) => ({
      ...l,
      score: l.limit === 0 ? (l.actual === 0 ? 1 : 0) : Math.max(0, Math.min(1, l.limit / Math.max(l.actual, 1))),
      within: l.actual <= l.limit,
    }));
    return {
      score: scores.reduce((t, s) => t + s.score, 0) / scores.length,
      passed: scores.every((s) => s.within),
      detail: { limits: scores },
    };
  }
}

function toList(expectation: unknown): string[] {
  if (Array.isArray(expectation)) return expectation.map(String);
  const any = expectation as { all?: unknown[]; value?: unknown };
  if (Array.isArray(any?.all)) return any.all.map(String);
  if (any?.value !== undefined) return [String(any.value)];
  if (typeof expectation === 'string') return [expectation];
  return [];
}

/** Dotted path with numeric array indices — `output.items.0.name`. No dependency needed. */
function resolvePath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (current === null || current === undefined) return undefined;
      if (Array.isArray(current)) {
        const index = Number(segment);
        return Number.isInteger(index) ? current[index] : undefined;
      }
      if (typeof current === 'object') return (current as Record<string, unknown>)[segment];
      return undefined;
    }, value);
}
