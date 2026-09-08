import { Injectable, Logger } from '@nestjs/common';
import type {
  AdvanceInput,
  AdvanceOutput,
  FrameworkAdapter,
  NextAction,
} from '../../../domain/ports/framework-adapter.port.js';

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

interface DeepAgentsState {
  messages: Message[];
  /** Guards against a framework that never stops proposing tool calls. */
  toolCalls: number;
}

const MAX_TOOL_CALLS = 20;

/**
 * A `deepagents`-style reasoning loop, driven one step at a time.
 *
 * ## Why this is not a call to `invoke()`
 *
 * `createDeepAgent(...).invoke()` runs a whole agent to completion inside one process.
 * That is incompatible with everything the platform guarantees: no step boundary to
 * checkpoint at, no point to enforce a budget, nothing to cancel, and a crash loses the
 * run. §2.1 puts the reasoning loop BELOW the platform for exactly this reason.
 *
 * So the adapter inverts it. The platform asks for one action; this returns one action and
 * its own state; the platform executes it, persists a step, checkpoints, and asks again
 * with the result. The framework keeps reasoning, the platform keeps durability.
 *
 * ap-executor's node already does the inverting half with its `AgentTracer` -- translating
 * a callback stream into records. This makes that idea the contract rather than an
 * observability side-effect.
 *
 * ## Honest scope
 *
 * The message-state machine, tool-call translation and the model/tool/complete decision are
 * real. `deepagents`' own graph executor is NOT invoked: driving a run-to-completion
 * executor one step at a time means running it repeatedly and discarding all but the next
 * action, which burns a model call per step. Wiring its streaming callbacks into this shape
 * is the remaining work, and it needs the consumer's real prompts to be worth testing
 * against. Until then this is a faithful loop, not a `deepagents` binding.
 */
@Injectable()
export class DeepAgentsAdapter implements FrameworkAdapter {
  readonly id = 'deep-agents';
  private readonly log = new Logger(DeepAgentsAdapter.name);

  async advance(input: AdvanceInput): Promise<AdvanceOutput> {
    const state = (input.state as DeepAgentsState | null) ?? { messages: seed(input), toolCalls: 0 };
    const messages = [...state.messages];

    // Fold the previous step's result into the transcript before deciding the next one.
    let nativeCalls: { name: string; args: Record<string, unknown> }[] = [];

    switch (input.observation.kind) {
      case 'model_result': {
        const observed = input.observation.content;
        if (isNativeResult(observed)) {
          nativeCalls = observed.toolCalls;
          messages.push({
            role: 'assistant',
            content: observed.text || `(requested ${observed.toolCalls.map((c) => c.name).join(', ')})`,
          });
        } else {
          messages.push({ role: 'assistant', content: String(observed ?? '') });
        }
        break;
      }
      case 'tool_result':
      case 'delegation_result':
        messages.push({ role: 'tool', content: JSON.stringify(input.observation.content ?? null) });
        break;
      case 'tool_error':
      case 'delegation_error':
        // Fed back rather than thrown: a failed tool is information the agent can act on,
        // and §13.5 contains failure by default.
        messages.push({ role: 'tool', content: `error: ${String(input.observation.content ?? '')}` });
        break;
      default:
        break;
    }

    // A native tool call is unambiguous -- the provider says which tool and with what
    // arguments. Text parsing stays only for models or endpoints without tool calling.
    const native = nativeCalls.find((c) => input.spec.tools.some((t) => t.ref === c.name));
    const action: NextAction =
      native && state.toolCalls < MAX_TOOL_CALLS
        ? { type: 'tool_call', toolRef: native.name, args: native.args }
        : this.decide(input, state, messages[messages.length - 1]);
    return {
      action,
      state: { messages, toolCalls: state.toolCalls + (action.type === 'tool_call' ? 1 : 0) },
    };
  }

  private decide(input: AdvanceInput, state: DeepAgentsState, last: Message | undefined): NextAction {
    if (!last || last.role === 'user' || last.role === 'system') {
      return {
        type: 'model_call',
        prompt: renderTranscript(input, state.messages),
        systemPrompt: input.spec.systemPrompt,
      };
    }

    if (last.role === 'assistant') {
      const requested = parseToolCall(last.content, input.spec.tools.map((t) => t.ref));
      if (requested) {
        // A budget the framework cannot talk its way past. Without it a model that keeps
        // proposing calls runs to maxSteps, spending a model call each time.
        if (state.toolCalls >= MAX_TOOL_CALLS) {
          this.log.warn(`run ${input.runId} hit the tool-call ceiling`);
          return { type: 'complete', output: { adapter: this.id, text: last.content, truncated: 'tool_call_limit' } };
        }
        return { type: 'tool_call', toolRef: requested.toolRef, args: requested.args };
      }
      return { type: 'complete', output: { adapter: this.id, text: last.content } };
    }

    // A tool or delegation just returned: back to the model to interpret it.
    return {
      type: 'model_call',
      prompt: renderTranscript(input, state.messages),
      systemPrompt: input.spec.systemPrompt,
    };
  }
}

const seed = (input: AdvanceInput): Message[] => {
  const messages: Message[] = [];

  // Skills first, and as INSTRUCTIONS rather than context. A skill is a procedure the
  // author wants followed; recalled memory and retrieved knowledge are material to reason
  // over. Flattening the two into one block loses that difference, and the model then
  // treats a procedure as one more retrieved fact it may weigh against others.
  if (input.spec.skills.length > 0) {
    messages.push({
      role: 'system',
      content: input.spec.skills
        .map(
          (sk) =>
            `Skill "${sk.name}" v${sk.version}` +
            `${sk.whenToUse ? ` (use when: ${sk.whenToUse})` : ''}:\n${sk.instructions}`,
        )
        .join('\n\n'),
    });
  }

  // Retrieved knowledge, kept in its own block and labelled as reference material. The
  // separation is what lets a wrong answer be traced to a stale document rather than to a
  // bad memory -- two different fixes, in two different places.
  if (input.spec.knowledge.length > 0) {
    messages.push({
      role: 'system',
      content:
        `Reference material retrieved for this request (may be incomplete):\n` +
        input.spec.knowledge.map((k) => `- ${k.content}`).join('\n'),
    });
  }

  // Recalled memory enters as context tagged with provenance -- §6.4 keeps hearsay
  // distinguishable from first-party knowledge at the point of use.
  if (input.spec.recalled.length > 0) {
    messages.push({
      role: 'system',
      content: `Recalled context:\n${input.spec.recalled
        .map((r) => `- (${r.provenance}${r.trusted ? '' : ', unverified'}) ${r.content ?? ''}`)
        .join('\n')}`,
    });
  }
  messages.push({
    role: 'user',
    content: typeof input.input === 'string' ? input.input : JSON.stringify(input.input ?? ''),
  });
  return messages;
};

const renderTranscript = (input: AdvanceInput, messages: Message[]): string => {
  const transcript = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
  if (input.spec.tools.length === 0) return transcript;

  // The example uses a REAL tool ref, not a placeholder. Instructing a model with
  // `TOOL <ref> <json-args>` gets `TOOL <ref> {...}` back verbatim -- the placeholder is
  // copied rather than substituted, and the strict parser then correctly refuses it, so
  // the tool is simply never called and nothing looks broken.
  const first = input.spec.tools[0]!.ref;
  const catalogue = input.spec.tools
    .map((t) => `  - ${t.ref}${t.description ? `: ${t.description}` : ''}`)
    .join('\n');

  return (
    `${transcript}\n\nTools you may call:\n${catalogue}\n` +
    `To call one, reply with a single line and nothing else, for example:\n` +
    `TOOL ${first} {"key": "value"}\n` +
    `Otherwise answer normally.`
  );
};

/**
 * Extracts a tool call from an assistant turn.
 *
 * Deliberately strict: an unparseable or unbound reference is treated as prose, not as a
 * call to something else. Guessing which tool was meant is how an agent invokes a side
 * effect nobody asked for.
 */
function parseToolCall(
  content: string,
  allowed: string[],
): { toolRef: string; args: Record<string, unknown> } | null {
  // Line-anchored, and the JSON must be the REST OF THAT LINE. A `[\s\S]*` body is
  // greedy across newlines, so it swallows the model's following prose whenever that
  // prose happens to end in `}` -- then JSON.parse fails and a real tool call is silently
  // read as prose. That failure looks exactly like the agent choosing not to act.
  for (const line of content.split('\n')) {
    const match = /^\s*TOOL\s+([\w.\-]+)\s*(\{.*\})?\s*$/.exec(line);
    if (!match) continue;
    const toolRef = match[1]!;
    if (!allowed.includes(toolRef)) continue;
    if (!match[2]) return { toolRef, args: {} };
    try {
      const args = JSON.parse(match[2]) as unknown;
      if (typeof args === 'object' && args !== null) {
        return { toolRef, args: args as Record<string, unknown> };
      }
    } catch {
      // Malformed args: refuse rather than guess. Inventing arguments invokes a side
      // effect nobody asked for.
      return null;
    }
  }
  return null;
}

const isNativeResult = (
  value: unknown,
): value is { text: string; toolCalls: { name: string; args: Record<string, unknown> }[] } =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { toolCalls?: unknown }).toolCalls);
