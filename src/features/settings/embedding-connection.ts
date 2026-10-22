export interface EmbeddingConnection {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 用户设置的字符上限；服务端仍按模型自身的 token 限制校验。 */
  readonly maxInputChars: number;
  readonly dimensions?: number;
  readonly timeoutSeconds: number;
}

/** 缺省值只用于旧设置升级；显式保存的错误配置直接报告。 */
export function parseEmbeddingConnection(raw: unknown): EmbeddingConnection | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("向量连接配置必须为对象");
  }
  const value = raw as Record<string, unknown>;
  if (
    typeof value.baseUrl !== "string" ||
    typeof value.apiKey !== "string" ||
    typeof value.model !== "string" ||
    !value.model.trim()
  ) {
    throw new Error("向量连接需要有效的端点、密钥文本和模型名称");
  }
  const url = new URL(value.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("向量端点须为不含登录信息、查询参数或片段的 HTTP / HTTPS 地址");
  }
  if (!Number.isSafeInteger(value.maxInputChars) || (value.maxInputChars as number) < 1) {
    throw new Error("向量输入字符上限须为正整数");
  }
  if (
    !Number.isInteger(value.timeoutSeconds) ||
    (value.timeoutSeconds as number) < 1 ||
    (value.timeoutSeconds as number) > 1800
  ) {
    throw new Error("向量请求超时须为 1–1800 秒的整数");
  }
  if (
    value.dimensions !== undefined &&
    (!Number.isSafeInteger(value.dimensions) || (value.dimensions as number) < 1)
  ) {
    throw new Error("指定向量维度须为正整数");
  }
  return {
    baseUrl: url.href.replace(/\/$/, ""),
    apiKey: value.apiKey.trim(),
    model: value.model.trim(),
    maxInputChars: value.maxInputChars as number,
    timeoutSeconds: value.timeoutSeconds as number,
    ...(value.dimensions === undefined ? {} : { dimensions: value.dimensions as number }),
  };
}
