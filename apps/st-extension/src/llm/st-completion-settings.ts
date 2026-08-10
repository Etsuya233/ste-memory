import type { Model } from "@earendil-works/pi-ai";
import type { StContext } from "../st/st-chat-adapter.ts";

/**
 * ST 当前对话生成配置（openai.js oai_settings 子集，st-context.js
 * chatCompletionSettings 暴露）。字段名与 ST 内部一致——这是未文档化契约的
 * 一部分，集中隔离在本模块；只声明 LLM 适配器需要的字段，其余不关心。
 */
export interface StChatCompletionSettings {
  /** 当前 Chat Completion source（chat_completion_source 枚举值） */
  chat_completion_source?: unknown;
  temp_openai?: unknown;
  top_p_openai?: unknown;
  freq_pen_openai?: unknown;
  pres_pen_openai?: unknown;
  /** 用户配置的输出 token 预算（openai.js default_settings: 300） */
  openai_max_tokens?: unknown;
  /** 用户配置的上下文 token 预算（default_settings: 4096） */
  openai_max_context?: unknown;
}

/** ST 默认值（openai.js default_settings 已核实）：配置缺失/非法时的兜底 */
export const ST_DEFAULT_MAX_TOKENS = 300;
export const ST_DEFAULT_MAX_CONTEXT = 4096;

/**
 * pi 模型对象 + ST chat_completion_source。
 *
 * source 随模型走（run 内不变）：st-extension 的 LLM 端口在任务开始时构造
 * 一次模型，请求体需要的 `chat_completion_source` 从模型上取——streamFn 因此
 * 保持 pi 契约的纯函数形状（model, context, options），不隐式读 ST 环境。
 */
export interface StBackendsModel extends Model<"openai-completions"> {
  /** ST chat_completion_source 枚举值（'openai' | 'custom' | …，chat-completions.js switch 派发键） */
  readonly stSource: string;
}

/** 从 getContext() 读出的、构造 LLM 端口所需配置（读一次，快照式） */
export interface StChatCompletionConfig {
  /** ST chat_completion_source 枚举值；未知/缺失为空串（由调用方决定抛错时机） */
  readonly source: string;
  /** 当前 source 的模型名（ST getChatCompletionModel 映射，未配置为空串） */
  readonly modelName: string;
  /** 生成参数；缺失/非法 → undefined（请求体省略该字段，上游用默认值） */
  readonly temperature?: number;
  readonly topP?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  /** 用户输出 token 预算；缺失/非法 → ST 默认 300 */
  readonly maxTokens: number;
  /** 用户上下文 token 预算；缺失/非法 → ST 默认 4096 */
  readonly contextWindow: number;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function numberOrDefault(value: unknown, fallback: number): number {
  const parsed = numberOrUndefined(value);
  return parsed !== undefined && parsed > 0 ? parsed : fallback;
}

/**
 * 读取 ST 当前对话生成配置（薄层映射，只取适配器需要的字段）。
 * 读取失败（非 ST 环境/字段缺失）不抛错——由 createStLlmPort 决定何时报错，
 * 保证任何环境下模块不崩。
 */
export function readStChatCompletionConfig(context: StContext): StChatCompletionConfig {
  const settings = context.chatCompletionSettings ?? {};
  const source = typeof settings.chat_completion_source === "string" ? settings.chat_completion_source : "";
  const modelName =
    typeof context.getChatCompletionModel === "function"
      ? context.getChatCompletionModel(settings)
      : "";
  return {
    source,
    modelName: typeof modelName === "string" ? modelName : "",
    temperature: numberOrUndefined(settings.temp_openai),
    topP: numberOrUndefined(settings.top_p_openai),
    frequencyPenalty: numberOrUndefined(settings.freq_pen_openai),
    presencePenalty: numberOrUndefined(settings.pres_pen_openai),
    maxTokens: numberOrDefault(settings.openai_max_tokens, ST_DEFAULT_MAX_TOKENS),
    contextWindow: numberOrDefault(settings.openai_max_context, ST_DEFAULT_MAX_CONTEXT),
  };
}

/** 按当前 ST 配置构造 pi 模型对象（model.id = 模型名，直接进请求体） */
export function createStBackendsModel(config: StChatCompletionConfig): StBackendsModel {
  return {
    id: config.modelName,
    name: config.modelName,
    api: "openai-completions",
    provider: "sillytavern",
    // 元数据：同源代理挂载点（请求实际走 /api/backends/chat-completions/generate）
    baseUrl: "/api/backends/chat-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    stSource: config.source,
  };
}
