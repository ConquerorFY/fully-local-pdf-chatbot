import {
  SimpleChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelCallOptions } from "@langchain/core/language_models/base";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseMessage, AIMessageChunk } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import {
  // @ts-ignore
  ChatModule,
  type ChatCompletionMessageParam,
  type ModelRecord,
  InitProgressCallback,
} from "@mlc-ai/web-llm";

/**
 * Note that the modelPath is the only required parameter. For testing you
 * can set this in the environment variable `LLAMA_PATH`.
 */
export interface WebLLMInputs extends BaseChatModelParams {
  modelRecord: ModelRecord;
  temperature?: number;
}

export interface WebLLMCallOptions extends BaseLanguageModelCallOptions {}

/**
 *  To use this model you need to have the `@mlc-ai/web-llm` module installed.
 *  This can be installed using `npm install -S @mlc-ai/web-llm`
 * @example
 * ```typescript
 * // Initialize the ChatWebLLM model with the model record.
 * const model = new ChatWebLLM({
 *   modelRecord: {
 *     "model_url": "https://huggingface.co/mlc-ai/phi-2-q4f32_1-MLC/resolve/main/",
 *     "local_id": "Phi2-q4f32_1",
 *     "model_lib_url": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/phi-2/phi-2-q4f32_1-ctx2k-webgpu.wasm",
 *     "vram_required_MB": 4032.48,
 *     "low_resource_required": false,
 *   },
 *   temperature: 0.5,
 * });
 *
 * // Call the model with a message and await the response.
 * const response = await model.invoke([
 *   new HumanMessage({ content: "My name is John." }),
 * ]);
 * ```
 */
export class ChatWebLLM extends SimpleChatModel<WebLLMCallOptions> {
  static inputs: WebLLMInputs;

  protected _chatModule: ChatModule;

  modelRecord: ModelRecord;

  temperature?: number;

  static lc_name() {
    return "ChatWebLLM";
  }

  constructor(inputs: WebLLMInputs) {
    super(inputs);
    this._chatModule = new ChatModule();
    this.modelRecord = inputs.modelRecord;
    this.temperature = inputs.temperature;
  }

  _llmType() {
    return "web-llm";
  }

  async initialize(progressCallback?: InitProgressCallback) {
    if (progressCallback !== undefined) {
      this._chatModule.setInitProgressCallback(progressCallback);
    }
    // @ts-ignore
    await this._chatModule.reload(this.modelRecord.local_id, undefined, {
      model_list: [this.modelRecord],
    });
    this._chatModule.setInitProgressCallback(() => {});
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    await this.initialize();

    const messagesInput: ChatCompletionMessageParam[] = messages.map(
      (message) => {
        if (typeof message.content !== "string") {
          throw new Error(
            "ChatWebLLM does not support non-string message content in sessions.",
          );
        }
        const langChainType = message._getType();
        let role;
        if (langChainType === "ai") {
          role = "assistant" as const;
        } else if (langChainType === "human") {
          role = "user" as const;
        } else if (langChainType === "system") {
          role = "system" as const;
        } else {
          throw new Error(
            "Function, tool, and generic messages are not supported.",
          );
        }
        return {
          role,
          content: message.content,
        };
      },
    );
    const stream = this._chatModule.chatCompletionAsyncChunkGenerator(
      {
        stream: true,
        messages: messagesInput,
        stop: options.stop,
        temperature: this.temperature,
      },
      {},
    );
    for await (const chunk of stream) {
      const text = chunk.choices[0].delta.content ?? "";
      yield new ChatGenerationChunk({
        text,
        message: new AIMessageChunk({
          content: text,
          additional_kwargs: {
            logprobs: chunk.choices[0].logprobs,
          },
        }),
      });
      await runManager?.handleLLMNewToken(text ?? "");
    }
  }

  async _call(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<string> {
    const chunks = [];
    for await (const chunk of this._streamResponseChunks(
      messages,
      options,
      runManager,
    )) {
      chunks.push(chunk.text);
    }
    return chunks.join("");
  }
}
