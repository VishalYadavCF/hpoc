import { Injectable } from '@nestjs/common';
import type {
  AdvanceInput,
  AdvanceOutput,
  FrameworkAdapter,
} from '../../../domain/ports/framework-adapter.port.js';

interface EchoState {
  phase: 'model' | 'tool' | 'peer' | 'done';
  modelText?: string;
  toolOutput?: unknown;
  peerOutput?: unknown;
}

/**
 * A deterministic framework adapter with no LLM behind it.
 *
 * This is §0.3's mandated second orchestration adapter, and it ships in Phase 1 rather
 * than later for two reasons: it is the fastest end-to-end test in the suite, and it is
 * the only thing that will catch a `deepagents` concept seeping into `steps` or `events`.
 * If writing it were hard, the abstraction would already have leaked.
 *
 * It walks: one model call, one tool call when a tool is bound, then completes.
 */
/** Best-effort text for a structured observation, without ever emitting [object Object]. */
function renderText(observed: unknown): string {
  if (observed === null || observed === undefined) return '';
  if (typeof observed === 'string') return observed;
  const text = (observed as { text?: unknown }).text;
  if (typeof text === 'string') return text;
  return JSON.stringify(observed);
}

@Injectable()
export class EchoAdapter implements FrameworkAdapter {
  readonly id = 'echo';

  async advance(input: AdvanceInput): Promise<AdvanceOutput> {
    const state = (input.state as EchoState | null) ?? { phase: 'model' };

    if (state.phase === 'model') {
      return {
        action: {
          type: 'model_call',
          prompt: typeof input.input === 'string' ? input.input : JSON.stringify(input.input),
          systemPrompt: input.spec.systemPrompt,
        },
        state: {
          ...state,
          phase: input.spec.tools.length > 0 ? 'tool' : input.spec.peers.length > 0 ? 'peer' : 'done',
        },
      };
    }

    if (state.phase === 'tool') {
      const modelText =
        input.observation.kind === 'model_result' ? String(input.observation.content) : '';
      const tool = input.spec.tools[0]!;
      return {
        action: { type: 'tool_call', toolRef: tool.ref, args: { echo: modelText } },
        state: { ...state, phase: input.spec.peers.length > 0 ? 'peer' : 'done', modelText },
      };
    }

    if (state.phase === 'peer') {
      // The adapter names an ALIAS and nothing else. It cannot tell whether this peer runs
      // in this process, which is exactly the property §13.4's conformance suite asserts:
      // the same adapter code drives both bindings.
      return {
        action: {
          type: 'peer_call',
          alias: input.spec.peers[0]!.alias,
          input: state.modelText ?? input.input,
        },
        state: { ...state, phase: 'done' },
      };
    }

    const observed =
      input.observation.kind === 'tool_result' || input.observation.kind === 'delegation_result'
        ? input.observation.content
        : input.observation.kind === 'model_result'
          ? input.observation.content
          : input.observation.kind === 'delegation_error'
            ? { error: input.observation.content }
            : null;

    return {
      action: {
        type: 'complete',
        output: {
          adapter: this.id,
          // `String(object)` yields "[object Object]" — a peer or tool result is
          // structured, and stringifying it that way discards the answer entirely.
          text: state.modelText ?? renderText(observed),
          observation: observed,
          steps: input.stepSeq,
          // Echoed back so a test can prove recall reached the framework rather than
          // being silently prepended to a prompt by the platform.
          recalled: input.spec.recalled.map((r) => ({ tier: r.tier, content: r.content })),
          // Echoed so a test can assert what the platform handed the framework, which is
          // the only way to tell "the skill was not attached" from "the model ignored it".
          skills: input.spec.skills.map((s) => `${s.name}@${s.version}`),
          knowledge: input.spec.knowledge.map((k) => k.content),
          peers: input.spec.peers.map((p) => p.alias),
        },
      },
      state: { ...state, phase: 'done' },
    };
  }
}
