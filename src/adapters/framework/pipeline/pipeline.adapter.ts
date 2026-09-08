import { Injectable } from '@nestjs/common';
import type {
  AdvanceInput,
  AdvanceOutput,
  FrameworkAdapter,
} from '../../../domain/ports/framework-adapter.port.js';

interface PipelineState {
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
 * Third adapter on the port, after `echo` and `deep-agents`. §0.3 asked for a second one
 * as evidence the abstraction had not leaked; a third that needed no port change is
 * stronger evidence.
 */
@Injectable()
export class PipelineAdapter implements FrameworkAdapter {
  readonly id = 'pipeline';

  async advance(input: AdvanceInput): Promise<AdvanceOutput> {
    const state = (input.state as PipelineState | null) ?? { index: 0, results: [] };
    const stages = input.spec.subAgents;

    // Fold the previous stage's outcome in before deciding the next one.
    const results = [...state.results];
    if (input.observation.kind === 'delegation_result' && state.index > 0) {
      results[state.index - 1] = {
        alias: stages[state.index - 1]?.alias ?? 'unknown',
        output: input.observation.content,
        failed: false,
      };
    } else if (input.observation.kind === 'delegation_error' && state.index > 0) {
      results[state.index - 1] = {
        alias: stages[state.index - 1]?.alias ?? 'unknown',
        output: input.observation.content,
        failed: true,
      };
    }

    // A failed stage stops the pipeline. Continuing would feed the next stage input its
    // predecessor never produced, and a pipeline that reports success on a broken stage is
    // worse than one that stops.
    const lastFailed = results[state.index - 1]?.failed === true;

    if (state.index < stages.length && !lastFailed) {
      const stage = stages[state.index]!;
      return {
        action: {
          type: 'delegate',
          alias: stage.alias,
          // The first stage receives the run's input; each later one receives its
          // predecessor's output.
          input: state.index === 0 ? input.input : results[state.index - 1]?.output,
        },
        state: { index: state.index + 1, results },
      };
    }

    return {
      action: {
        type: 'complete',
        output: {
          adapter: this.id,
          stages: results.map((r) => ({ alias: r.alias, failed: r.failed })),
          text: describe(results),
          result: results[results.length - 1]?.output ?? null,
          halted: lastFailed,
        },
      },
      state: { index: state.index, results },
    };
  }
}

const describe = (results: { alias: string; failed: boolean }[]): string =>
  results.length === 0
    ? 'pipeline had no stages'
    : results.map((r) => `${r.alias}:${r.failed ? 'failed' : 'ok'}`).join(' -> ');
