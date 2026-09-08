import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { HostMessage, RunHost } from '../../../domain/ports/framework-adapter.port.js';

/**
 * The model LangGraph sees, which is really the platform's gateway wearing a LangChain
 * face.
 *
 * ## Why the graph is not given a real `ChatOpenAI`
 *
 * Handing DeepAgents a vendor client directly would work, and would silently take the
 * model call out of the platform: no residency gate, no cost ledger, no per-step budget
 * check, no `steps` row, no `ModelCompleted` event, no fallback, no cache. Those are §9's
 * entire reason for existing, and they are enforced by being on the ONLY path to a
 * provider. So the only path stays the only path, and the framework gets an adapter.
 *
 * Everything the framework asks for -- tool schemas, multi-turn history, structured
 * output -- travels through unchanged. What it cannot do is bypass the gate.
 */
export class HostChatModel extends BaseChatModel {
  /**
   * Tool schemas bound by the graph via `bindTools`, forwarded to the gateway.
   *
   * Held on the instance rather than passed per call because `bindTools` returns a NEW
   * runnable in LangChain's model, and the platform needs the schemas at the point the
   * call is made.
   */
  private boundTools: { name: string; description: string; parameters: Record<string, unknown> }[] = [];

  constructor(
    private readonly host: RunHost,
    /**
     * Framework-provided tool names the pinned policy denies (§17.3).
     *
     * Enforced HERE rather than by removing the tools from the graph, because a
     * middleware's tools are injected by the middleware and there is no honest way to
     * reach in and delete them. Hiding is sufficient: a tool the model was never told
     * about is a tool the model cannot request, and LangGraph's tool node only runs what
     * the model requested. Anything the model DOES request that touches the outside world
     * still goes through `callTool`, which refuses whatever is not bound.
     */
    private readonly excludedTools: readonly string[] = [],
    fields?: BaseChatModelParams,
  ) {
    super(fields ?? {});
  }

  _llmType(): string {
    return 'hpoc-host';
  }

  override bindTools(tools: unknown[]): this {
    // Mutating a clone, not `this`: the graph binds tools once and reuses the result, and
    // a shared instance whose tool list changed underneath a concurrent call would send
    // one node's schemas with another node's messages.
    const clone = new HostChatModel(this.host, this.excludedTools) as this;
    clone.boundTools = tools
      .map((t) => toSchema(t))
      .filter((t) => !this.excludedTools.includes(t.name));
    return clone;
  }

  async _generate(
    messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const { system, turns } = split(messages);

    const result = await this.host.callModel({
      messages: turns,
      systemPrompt: system,
      // Includes DeepAgents' own middleware tools, not just the platform's bindings.
      // Without this the graph would offer the model a planning tool the provider was
      // never told about, and the model would simply never use it.
      ...(this.boundTools.length ? { tools: this.boundTools } : {}),
    });

    // The token counts the platform already billed, reported back so LangChain's own
    // accounting agrees with `usage_ledger` rather than re-estimating from the text.
    const message = new AIMessage({
      content: result.text,
      tool_calls: result.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      usage_metadata: {
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        total_tokens: result.inputTokens + result.outputTokens,
      },
    });
    await runManager?.handleLLMNewToken(result.text);

    return {
      generations: [{ text: result.text, message }],
      llmOutput: {
        tokenUsage: {
          promptTokens: result.inputTokens,
          completionTokens: result.outputTokens,
          totalTokens: result.inputTokens + result.outputTokens,
        },
      },
    };
  }

}

/**
 * Splits LangChain's flat message list into the platform's shape.
 *
 * System messages are pulled out and JOINED rather than kept in sequence: DeepAgents'
 * middleware stack contributes several of them (base prompt, skills, memory, harness
 * profile), and the platform's `systemPrompt` is one field. Concatenating in order
 * preserves the precedence the middleware intended.
 */
function split(messages: BaseMessage[]): { system: string | null; turns: HostMessage[] } {
  const systems: string[] = [];
  const turns: HostMessage[] = [];

  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : renderParts(m.content);
    if (m instanceof SystemMessage || m.getType() === 'system') {
      systems.push(content);
    } else if (m instanceof ToolMessage || m.getType() === 'tool') {
      turns.push({
        role: 'tool',
        content,
        toolCallId: (m as ToolMessage).tool_call_id,
      });
    } else if (m instanceof AIMessage || m.getType() === 'ai') {
      const calls = (m as AIMessage).tool_calls ?? [];
      turns.push({
        role: 'assistant',
        content,
        ...(calls.length
          ? { toolCalls: calls.map((c) => ({ id: c.id ?? '', name: c.name, args: c.args })) }
          : {}),
      });
    } else if (m instanceof HumanMessage || m.getType() === 'human') {
      turns.push({ role: 'user', content });
    }
  }

  return { system: systems.length ? systems.join('\n\n') : null, turns };
}

/** Multi-part content (text + images) flattened to its text, which is all we bill on. */
function renderParts(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .map((part) => (typeof part === 'object' && part && 'text' in part ? String(part.text) : ''))
    .filter(Boolean)
    .join('');
}

function toSchema(t: unknown): { name: string; description: string; parameters: Record<string, unknown> } {
  const tool = t as {
    name?: string;
    description?: string;
    schema?: unknown;
    function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
  };
  if (tool.function) {
    return {
      name: tool.function.name ?? 'unknown',
      description: tool.function.description ?? '',
      parameters: tool.function.parameters ?? { type: 'object' },
    };
  }
  return {
    name: tool.name ?? 'unknown',
    description: tool.description ?? '',
    parameters: (tool.schema as Record<string, unknown>) ?? { type: 'object' },
  };
}
