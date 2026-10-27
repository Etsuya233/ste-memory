import { MAX_RERANK_CANDIDATES } from "../semantic-query/semantic-options.ts";

export interface RerankConnection {
  /** Full endpoint, e.g. https://api.cohere.com/v2/rerank. */
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxInputChars: number;
  readonly timeoutSeconds: number;
}
export interface RerankSettings {
  readonly enabled: boolean;
  readonly candidateLimit: number;
  readonly connection?: RerankConnection;
}
export const DEFAULT_RERANK_SETTINGS: RerankSettings = { enabled: false, candidateLimit: 50 };

export function parseRerankSettings(raw: unknown): RerankSettings {
  if (raw === undefined) return { ...DEFAULT_RERANK_SETTINGS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("重排设置必须为对象");
  const value = raw as RerankSettings;
  if (
    typeof value.enabled !== "boolean" ||
    !Number.isSafeInteger(value.candidateLimit) ||
    value.candidateLimit < 1 ||
    value.candidateLimit > MAX_RERANK_CANDIDATES
  )
    throw new Error(`重排开关须为布尔值，默认候选数须为 1–${MAX_RERANK_CANDIDATES} 的整数`);
  if (value.connection !== undefined) {
    const c = value.connection;
    if (
      !c ||
      typeof c !== "object" ||
      typeof c.endpoint !== "string" ||
      typeof c.apiKey !== "string" ||
      typeof c.model !== "string" ||
      !c.model.trim()
    )
      throw new Error("重排连接需要有效端点、密钥文本和模型名");
    const url = new URL(c.endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("重排端点须为不含登录信息、查询参数和片段的 HTTP / HTTPS 地址");
    if (!Number.isSafeInteger(c.maxInputChars) || c.maxInputChars < 1 || c.maxInputChars > 100000)
      throw new Error("重排单条输入上限须为 1–100000 字符的整数");
    if (!Number.isSafeInteger(c.timeoutSeconds) || c.timeoutSeconds < 1 || c.timeoutSeconds > 1800)
      throw new Error("重排请求超时须为 1–1800 秒的整数");
  }
  if (value.enabled && !value.connection) throw new Error("启用重排前请配置连接");
  return structuredClone(value);
}
