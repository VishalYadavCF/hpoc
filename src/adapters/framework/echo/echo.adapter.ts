import { Injectable } from '@nestjs/common';
import type {
  FrameworkAdapter,
  RunOutcome,
  RunSession,
} from '../../../domain/ports/framework-adapter.port.js';

/**
 * A deterministic framework adapter with no LLM behind it.
 *
 * This is §0.3's mandated second orchestration adapter, and it matters more now than it
 * did when the port returned one step at a time. With the framework driving the loop, the
 * port's whole surface is `RunHost` -- and a port with a single implementation is a guess
 * about what a framework needs. This one is written against nothing but the interface, so
 * anything DeepAgents needs that is not here is a leak.
 *
 * It also stays the fastest end-to-end test in the suite, and the only thing that will
 * catch a `deepagents` concept seeping into `steps` or `events`.
 *
 * It walks: one model call, one tool call when a tool is bound, one peer call when a peer
 * is bound, then completes.
 */
@Injectable()
export class EchoAdapter implements FrameworkAdapter {
  readonly id = 'echo';

  async run(session: RunSession): Promise<RunOutcome> {
    const { spec, host } = session;

    // RESUME BEFORE REPLAY. Falling through here would re-issue the model call and
    // re-invoke the tool a human just approved -- the exact duplicated side effect the
    // approval gate exists to prevent. This adapter has no checkpointer of its own, so
    // the branch is the whole of its resume support, and having to write it is the point:
    // if the port made this easy to forget, it would be forgotten.
    if (session.resume) {
      return { type: 'complete', output: this.finish(session, '', session.resume.value) };
    }

    const asked = typeof session.input === 'string' ? session.input : JSON.stringify(session.input);

    const model = await host.callModel({
      // Prior thread turns (§3) first, so the model sees the conversation it is continuing.
      messages: [...(session.history ?? []), { role: 'user', content: asked }],
      systemPrompt: spec.systemPrompt,
    });

    let observation: unknown = null;

    if (spec.tools.length > 0) {
      const outcome = await host.callTool(spec.tools[0]!.ref, { echo: model.text });
      // A suspension is not a result. The platform has parked the run and will call
      // `run()` again with the answer; returning anything else here would let a completed
      // output overwrite a run that is legitimately waiting.
      if (outcome.kind === 'suspended') return { type: 'suspended' };
      observation = outcome.kind === 'ok' ? outcome.output : { error: outcome.message };
    }

    if (spec.peers.length > 0) {
      // The adapter names an ALIAS and nothing else. It cannot tell whether this peer runs
      // in this process, which is exactly the property §13.4's conformance suite asserts:
      // the same adapter code drives both bindings.
      const outcome = await host.peerCall(spec.peers[0]!.alias, model.text || session.input);
      if (outcome.kind === 'suspended') return { type: 'suspended' };
      observation = outcome.kind === 'ok' ? outcome.output : { error: outcome.message };
    }

    return { type: 'complete', output: this.finish(session, model.text, observation) };
  }

  private finish(
    session: RunSession,
    text: string,
    observation: unknown,
  ): Record<string, unknown> {
    const { spec } = session;
    return {
      adapter: this.id,
      text: text || renderText(observation),
      observation,
      // Echoed back so a test can prove recall reached the framework rather than
      // being silently prepended to a prompt by the platform.
      recalled: spec.recalled.map((r) => ({ tier: r.tier, content: r.content })),
      // Echoed so a test can assert what the platform handed the framework, which is
      // the only way to tell "the skill was not attached" from "the model ignored it".
      skills: spec.skills.map((s) => `${s.name}@${s.version}`),
      knowledge: spec.knowledge.map((k) => k.content),
      peers: spec.peers.map((p) => p.alias),
    };
  }
}

/** Best-effort text for a structured observation, without ever emitting [object Object]. */
function renderText(observed: unknown): string {
  if (observed === null || observed === undefined) return '';
  if (typeof observed === 'string') return observed;
  const text = (observed as { text?: unknown }).text;
  if (typeof text === 'string') return text;
  return JSON.stringify(observed);
}
