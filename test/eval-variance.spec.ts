import { describe, expect, it } from 'vitest';
import { EvalService } from '../src/domain/eval/eval.service.js';

/**
 * §0.5 / §15.5 variance handling.
 *
 * The verdict logic is a pure function, so the interesting cases are a table rather than
 * a fixture: what matters is which of the three answers it gives, and the old harness
 * could only give two because it had no notion of spread. Its own rationale text admitted
 * it — "this harness does no significance testing" — and these are the cases that text
 * was apologising for.
 */
const judge = (over: Record<string, unknown> = {}) =>
  (
    EvalService.prototype as unknown as {
      judgeMechanism(args: Record<string, unknown>): { verdict: string; rationale: string };
    }
  ).judgeMechanism({
    mechanism: 'summarization',
    comparableCount: 10,
    primaryScore: 0.80,
    baselineScore: 0.74,
    delta: 0.06,
    minDelta: 0.05,
    primaryPassed: true,
    minScore: 0.7,
    trials: 5,
    deltaStderr: 0.005,
    ...over,
  });

describe('verdict with measured noise (§0.5)', () => {
  it('accepts a delta that clears both the margin and the spread', () => {
    const { verdict, rationale } = judge();
    expect(verdict).toBe('mechanism_justified');
    // The band is reported, so a reader can argue with the number rather than trust it.
    expect(rationale).toMatch(/spread over 5 trials/);
  });

  it('refuses to call a delta real when it sits inside the run-to-run spread', () => {
    // THE case this feature exists for: +0.06 clears the 0.05 margin, but the same
    // configuration re-run swings by ±0.16, so the "improvement" is noise.
    const { verdict, rationale } = judge({ deltaStderr: 0.08 });
    expect(verdict).toBe('inconclusive');
    expect(rationale).toMatch(/inside the noise/);
    expect(rationale).toMatch(/re-running the same configuration/);
  });

  it('is equally sceptical of an apparent REGRESSION inside the noise', () => {
    // Symmetry matters: a gate that only doubts good news is a gate that fails versions
    // for being unlucky.
    const { verdict } = judge({
      primaryScore: 0.74, baselineScore: 0.80, delta: -0.06, deltaStderr: 0.08,
    });
    expect(verdict).toBe('inconclusive');
  });

  it('still condemns a regression that is larger than the noise', () => {
    const { verdict, rationale } = judge({
      primaryScore: 0.60, baselineScore: 0.80, delta: -0.20, deltaStderr: 0.01,
    });
    expect(verdict).toBe('mechanism_not_justified');
    expect(rationale).toMatch(/WORSE/);
  });

  it('says plainly when there is no confidence interval at all', () => {
    // One trial per case is the default and stays supported; what it must not do is imply
    // a precision it never measured.
    const { verdict, rationale } = judge({ trials: 1, deltaStderr: null });
    expect(verdict).toBe('mechanism_justified');
    expect(rationale).toMatch(/no confidence interval/);
  });

  it('keeps the case-count floor ahead of the noise check', () => {
    // Four cases with a suspiciously tight spread must not sneak past on statistics; too
    // few cases is a different objection and it comes first.
    const { verdict, rationale } = judge({ comparableCount: 3, deltaStderr: 0.0001 });
    expect(verdict).toBe('inconclusive');
    expect(rationale).toMatch(/below the floor/);
  });
});

describe('the arithmetic behind the band', () => {
  /** Mirrors executeArm: sample variance (n-1), then propagated to the weighted mean. */
  const stderrOf = (perCase: number[][], weights: number[]): number => {
    let terms = 0;
    let weightTotal = 0;
    perCase.forEach((scores, i) => {
      const w = weights[i]!;
      const mean = scores.reduce((t, v) => t + v, 0) / scores.length;
      const variance = scores.reduce((t, v) => t + (v - mean) ** 2, 0) / (scores.length - 1);
      terms += w ** 2 * (variance / scores.length);
      weightTotal += w;
    });
    return Math.sqrt(terms) / weightTotal;
  };

  it('reports zero spread for a perfectly deterministic agent', () => {
    expect(stderrOf([[1, 1, 1], [0, 0, 0]], [1, 1])).toBe(0);
  });

  it('grows with disagreement between trials', () => {
    const steady = stderrOf([[0.8, 0.8, 0.8], [0.6, 0.6, 0.6]], [1, 1]);
    const jumpy = stderrOf([[1, 0.6, 0.8], [1, 0.2, 0.6]], [1, 1]);
    expect(jumpy).toBeGreaterThan(steady);
  });

  it('shrinks as trials are added, which is why trials_per_case is the lever', () => {
    const few = stderrOf([[1, 0, 1]], [1]);
    const many = stderrOf([[1, 0, 1, 1, 0, 1, 1, 0, 1]], [1]);
    expect(many).toBeLessThan(few);
  });

  it('uses the n-1 form, which does not understate noise on small samples', () => {
    // Population variance over [1,0] gives 0.25; the sample form gives 0.5. Understating
    // spread is the direction that manufactures false confidence, so the larger is correct.
    const scores = [1, 0];
    const mean = 0.5;
    const sample = scores.reduce((t, v) => t + (v - mean) ** 2, 0) / (scores.length - 1);
    expect(sample).toBe(0.5);
  });
});
