import { Injectable } from '@nestjs/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { AIMessageChunk } from '@langchain/core/messages';
import type { AIMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { LangChainProvider } from './langchain.provider.js';
import type { ModelRequest } from '../../domain/ports/model-provider.port.js';

/**
 * A provider that answers without a network call or an API key.
 *
 * It exists so the run loop, the gateway's accounting path and the event log can be
 * exercised end to end in CI and on a laptop.
 *
 * ## Why it is built on LangChain's fake rather than beside it
 *
 * The fake now travels the SAME code path as a real vendor -- `LangChainProvider.build()`
 * returns a `BaseChatModel` either way, so message construction, tool binding, response
 * mapping and stream mapping are exercised by every test in the suite rather than only by
 * the one test that has an API key. A fake wired up separately tests the fake.
 *
 * ## Why two things are still overridden
 *
 * `FakeListChatModel` streams character-by-character and reports no `usage_metadata`.
 * Both are wrong here for reasons that are about our contract, not theirs:
 *
 * - Token counts of zero would flow into `usage_ledger`, which is billing data. An
 *   approximation labelled as one is honest; a fabricated zero is not.
 * - Word-level chunks are what a clause-boundary consumer needs to chunk on. Character
 *   chunks would also work, but the granularity is a documented property that voice
 *   (§12.3) depends on, so it is pinned rather than inherited by accident.
 */
class EchoChatModel extends FakeListChatModel {
  constructor(private readonly echoed: string) {
    super({ responses: [echoed] });
  }

  /** Word-by-word, preserving whitespace so the reassembled text is byte-identical. */
  override async *_streamResponseChunks(
    _messages: unknown[],
    options: { signal?: AbortSignal },
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    for (const word of this.echoed.split(/(\s+)/).filter((w) => w.length > 0)) {
      // Checked between words rather than ignored: the interruption path (§12.3) needs a
      // provider that actually stops, or every abort test passes for the wrong reason.
      if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      await runManager?.handleLLMNewToken(word);
      yield new ChatGenerationChunk({
        text: word,
        message: new AIMessageChunk({ content: word }),
      });
    }
  }
}

@Injectable()
export class EchoProvider extends LangChainProvider {
  readonly id = 'echo';

  protected build(request: ModelRequest): BaseChatModel {
    // The LAST turn, not the whole transcript: the contract this fake pins is "the
    // provider saw what was most recently asked", and echoing the history back would make
    // every assertion in the suite grow as the transcript does.
    const asked = request.messages?.length
      ? (request.messages[request.messages.length - 1]?.content ?? '')
      : request.prompt;
    const text = `echo(${request.providerModelId}): ${asked}`;
    const model = new EchoChatModel(text);

    // Usage is attached here, not inside the fake, because the input side depends on the
    // request rather than on the answer.
    const inputTokens = approximateTokens(
      `${request.systemPrompt ?? ''} ${request.messages?.map((m) => m.content).join(' ') ?? request.prompt}`,
    );
    const outputTokens = approximateTokens(text);
    const generate = model._generate.bind(model);
    model._generate = async (messages, options, runManager) => {
      const result = await generate(messages, options, runManager);
      // `generations[0].message` is typed as the BaseMessage union; usage lives on the
      // AI variant, which is the only kind a chat model generates.
      const message = result.generations[0]?.message as AIMessage | undefined;
      if (message) {
        message.usage_metadata = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        };
      }
      return result;
    };
    return model as unknown as BaseChatModel;
  }
}

const approximateTokens = (s: string): number =>
  s.trim().length === 0 ? 0 : Math.ceil(s.trim().split(/\s+/).length * 1.3);
