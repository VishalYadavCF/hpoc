import { Injectable } from '@nestjs/common';
import type {
  FrameworkAdapter,
  RunOutcome,
  RunSession,
} from '../../../domain/ports/framework-adapter.port.js';

interface PipelineState {
  /** How many stages have been DISPATCHED, which is one ahead of how many have settled. */
  index: number;
  results: { alias: string; output: unknown; failed: boolean }[];
}

/**
 * Delegates to each bound sub-agent in turn, passing the previous stage's result forward.
 *
 * This is consumer 02's shape exactly -- intent → trigger → topology → schema-grounding →
 * drafting → correction, six agents owned by one team, deploying together, sharing a trust
 * domain. §13.3 says that is a sub-agent pipeline rather than six peers, and this adapter
 * is what makes the platform able to run it.
 *
 * ## Why it is still here after the framework took the loop
 *
 * It is the port's proof that a framework with NO checkpointer of its own can still be
 * driven correctly. Every stage suspends the run, so `run()` is re-entered from the top
 * once per stage -- and the only thing standing between that and re-dispatching stage one
 * six times is `host.saveState()`. If that mechanism were wrong, this adapter would fail
 * loudly rather than quietly duplicating work, which is why it earns its place.
 */
@Injectable()
export class PipelineAdapter implements FrameworkAdapter {
  readonly id = 'pipeline';

  async run(session: RunSession): Promise<RunOutcome> {
    const { spec, host } = session;
    const stages = spec.subAgents;
    const state = (session.state as PipelineState | null) ?? { index: 0, results: [] };
    const results = [...state.results];

    // Fold the outcome of the stage we suspended on before deciding the next one.
    if (session.resume && state.index > 0) {
      // `failed` comes from the platform, not from sniffing the payload. A stage whose
      // legitimate output happened to mention an error would otherwise halt the pipeline.
      results[state.index - 1] = {
        alias: stages[state.index - 1]?.alias ?? 'unknown',
        output: session.resume.value,
        failed: session.resume.failed,
      };
    }

    // A failed stage stops the pipeline. Continuing would feed the next stage input its
    // predecessor never produced, and a pipeline that reports success on a broken stage is
    // worse than one that stops.
    const lastFailed = results[state.index - 1]?.failed === true;

    if (state.index < stages.length && !lastFailed) {
      const stage = stages[state.index]!;
      // Saved BEFORE dispatching, not after. The delegate call suspends this run, so
      // nothing after it executes -- state written afterwards would never be written at
      // all, and the resumed run would dispatch stage one again.
      host.saveState({ index: state.index + 1, results } satisfies PipelineState);

      const outcome = await host.delegate(
        stage.alias,
        // The first stage receives the run's input; each later one receives its
        // predecessor's output.
        state.index === 0 ? session.input : results[state.index - 1]?.output,
      );
      if (outcome.kind === 'suspended') return { type: 'suspended' };

      // Reached only when the delegation was refused outright -- an unbound alias, a depth
      // or cycle limit. That is a stage failure, and it stops the pipeline like any other.
      results[state.index] = { alias: stage.alias, output: describeFailure(outcome), failed: true };
    }

    return {
      type: 'complete',
      output: {
        adapter: this.id,
        stages: results.map((r) => ({ alias: r.alias, failed: r.failed })),
        text: describe(results),
        result: results[results.length - 1]?.output ?? null,
        halted: lastFailed || results.some((r) => r.failed),
      },
    };
  }
}

const describeFailure = (outcome: { kind: string; message?: string }): unknown => ({
  error: outcome.message ?? 'delegation refused',
});

const describe = (results: { alias: string; failed: boolean }[]): string =>
  results.length === 0
    ? 'pipeline had no stages'
    : results.map((r) => `${r.alias}:${r.failed ? 'failed' : 'ok'}`).join(' -> ');
