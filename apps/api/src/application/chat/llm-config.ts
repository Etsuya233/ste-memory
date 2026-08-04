/**
 * LLM 配置接入（ticket 11.5，参考 11 设计文档 §4）：
 *
 * - 环境变量：OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL；
 * - 合并规则：逐字段 web ?? env（网页配置覆盖，空值回退服务端环境变量）；
 * - API Key 仅本次请求内存：本模块只读取与合并，绝不落库/落盘/打日志；
 * - provider 构造不在此模块（见 adapters/outbound/llm/openai-compatible-llm.ts）。
 */

/** Base URL 与环境变量都未配置时的默认值（OpenAI 官方兼容端点）。 */
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "https://api.openai.com/v1";

/** 各字段最终生效来源，供网页表单标注（「网页配置 / 环境变量」）。 */
export type LlmConfigSource = "web" | "env" | "default" | "missing";

/** 从环境变量读取的 LLM 配置；未设置（或空白）的字段为 null。 */
export interface LlmEnvConfig {
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly apiKey: string | null;
}

/** 网页提交的 LLM 配置；空字符串表示未填写（该字段回退环境变量）。 */
export interface LlmWebConfig {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly apiKey?: string;
}

/** web ?? env 合并后的最终配置（apiKey 只存在于本次请求内存中）。 */
export interface ResolvedLlmConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  /** 各字段生效来源：baseUrl 可能落到默认值；model/apiKey 必填，缺失在 resolve 时抛错。 */
  readonly sources: Readonly<{
    readonly baseUrl: Exclude<LlmConfigSource, "missing">;
    readonly model: Exclude<LlmConfigSource, "default">;
    readonly apiKey: "web" | "env";
  }>;
}

/**
 * GET /llm-config 的响应：只暴露非敏感的环境回退信息（供表单标注生效来源），
 * 绝不包含 API Key 值本身，只给存在性布尔。
 */
export interface LlmConfigInfo {
  readonly env: Readonly<{
    readonly baseUrl: string | null;
    readonly model: string | null;
    readonly apiKeyConfigured: boolean;
  }>;
}

/** LLM 配置缺失/非法（HTTP 层映射为 400）。 */
export class LlmConfigError extends Error {
  readonly field: "model" | "apiKey";

  constructor(field: "model" | "apiKey", message: string) {
    super(message);
    this.name = "LlmConfigError";
    this.field = field;
  }
}

function normalize(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function loadLlmEnvConfig(
  environment: Readonly<Record<string, string | undefined>>,
): LlmEnvConfig {
  return {
    baseUrl: normalize(environment.OPENAI_BASE_URL),
    model: normalize(environment.OPENAI_MODEL),
    apiKey: normalize(environment.OPENAI_API_KEY),
  };
}

export function llmConfigInfo(env: LlmEnvConfig): LlmConfigInfo {
  return {
    env: {
      baseUrl: env.baseUrl,
      model: env.model,
      apiKeyConfigured: env.apiKey !== null,
    },
  };
}

/** 逐字段 web ?? env 合并；model / apiKey 双方都缺失时抛 LlmConfigError。 */
export function resolveLlmConfig(env: LlmEnvConfig, web: LlmWebConfig): ResolvedLlmConfig {
  const webBaseUrl = normalize(web.baseUrl);
  const webModel = normalize(web.model);
  const webApiKey = normalize(web.apiKey);

  const baseUrl = webBaseUrl ?? env.baseUrl ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
  const model = webModel ?? env.model;
  const apiKey = webApiKey ?? env.apiKey;

  if (model === null) {
    throw new LlmConfigError(
      "model",
      "未配置 LLM 模型（model）：请在 LLM 配置表单填写，或设置 OPENAI_MODEL 环境变量",
    );
  }
  if (apiKey === null) {
    throw new LlmConfigError(
      "apiKey",
      "未配置 LLM API Key：请在 LLM 配置表单填写，或设置 OPENAI_API_KEY 环境变量",
    );
  }

  return {
    baseUrl,
    model,
    apiKey,
    sources: {
      baseUrl: webBaseUrl !== null ? "web" : env.baseUrl !== null ? "env" : "default",
      model: webModel !== null ? "web" : "env",
      apiKey: webApiKey !== null ? "web" : "env",
    },
  };
}
