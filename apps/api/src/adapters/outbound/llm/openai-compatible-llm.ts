/**
 * OpenAI 兼容 provider 构造（ticket 11.5，参考 11 设计文档 §4「参考」）：
 *
 * createModels() + createProvider({ id, baseUrl, auth, models, api: openAICompletionsApi() })，
 * 模型对象带 baseUrl；streamFn 走 models.streamSimple；Agent.getApiKey 钩子返回显式 key
 * （pi 的 auth 解析中显式 key 优先于 provider/env 解析）。
 *
 * API Key 只存在于本模块返回的 LlmPort 闭包中：每次对话按本次解析结果构造一次，
 * 不落库/落盘/打日志。
 */
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { LlmPort } from "@ste-memory/core/memory/agent";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "../../../application/chat/chat-manager.ts";

export interface BuildOpenAiCompatibleLlmPortInput {
  readonly baseUrl: string;
  /** 本次请求解析出的 API Key（仅内存）。 */
  readonly apiKey: string;
  readonly modelId: string;
}

export function buildOpenAiCompatibleLlmPort(input: BuildOpenAiCompatibleLlmPortInput): LlmPort {
  const model = buildModel(input);
  const models = createModels();
  models.setProvider(
    createProvider({
      id: OPENAI_COMPATIBLE_PROVIDER_ID,
      name: "OpenAI 兼容",
      baseUrl: input.baseUrl,
      // 显式 key 由 Agent.getApiKey 钩子注入（resolveProviderAuth 的 override 分支），
      // 经 resolve 的 credential 参数传入；无显式 key 时返回 undefined（此时配置层已报错，不会走到流）。
      auth: {
        apiKey: {
          name: "LLM API Key",
          resolve: async ({ credential }) =>
            credential?.key ? { auth: { apiKey: credential.key } } : undefined,
        },
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  return {
    model,
    streamFn: (streamModel, context, options) => models.streamSimple(streamModel, context, options),
    getApiKey: () => input.apiKey,
  };
}

/**
 * 模型对象：id/name 用配置的 modelId，baseUrl 用本次解析结果；
 * 其余为 pi Model 必需元数据（compat 未设置时由 openai-completions 按 baseUrl 自动探测）。
 */
function buildModel(input: BuildOpenAiCompatibleLlmPortInput): Model<"openai-completions"> {
  return {
    id: input.modelId,
    name: input.modelId,
    api: "openai-completions",
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: input.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}
