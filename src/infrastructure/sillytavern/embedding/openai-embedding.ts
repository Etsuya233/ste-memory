import type { EmbeddingConnection } from "../../../features/settings/embedding-connection.ts";
import {
  VectorEmbeddingRequestError,
  type VectorEmbeddingPort,
  type VectorEmbeddingProfile,
} from "../../../features/vector-index/index.ts";

/** OpenAI 兼容 embedding 接口；不经过 ST 的聊天生成代理。 */
export class OpenAiEmbeddingPort implements VectorEmbeddingPort {
  private readonly readConnection: () => EmbeddingConnection | undefined;
  private readonly request: typeof fetch;

  constructor(
    readConnection: () => EmbeddingConnection | undefined,
    request: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.readConnection = readConnection;
    this.request = request;
  }

  getProfile(): VectorEmbeddingProfile | null {
    const connection = this.readConnection();
    if (!connection) return null;
    const endpoint = connection.baseUrl.replace(/\/$/, "");
    return {
      model: connection.model,
      version: JSON.stringify([
        endpoint.endsWith("/embeddings") ? endpoint : `${endpoint}/embeddings`,
        connection.model,
        connection.dimensions ?? null,
      ]),
      maxInputChars: connection.maxInputChars,
      ...(connection.dimensions === undefined ? {} : { dimensions: connection.dimensions }),
    };
  }

  async embed(input: string, signal: AbortSignal): Promise<readonly number[]> {
    const connection = this.readConnection();
    if (!connection) throw new VectorEmbeddingRequestError("尚未配置向量连接", "connection", true);
    if (!input.trim() || input.length > connection.maxInputChars) {
      throw new VectorEmbeddingRequestError("向量输入为空或超过已配置的字符上限", "input");
    }
    const baseUrl = connection.baseUrl.replace(/\/$/, "");
    const endpoint = baseUrl.endsWith("/embeddings") ? baseUrl : `${baseUrl}/embeddings`;
    const timeout = AbortSignal.timeout(connection.timeoutSeconds * 1000);
    const requestSignal = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.request(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: connection.model,
          input,
          encoding_format: "float",
          ...(connection.dimensions === undefined ? {} : { dimensions: connection.dimensions }),
        }),
        credentials: "omit",
        signal: requestSignal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (timeout.aborted) throw new VectorEmbeddingRequestError("向量请求超时", "connection");
      throw new VectorEmbeddingRequestError(
        "无法连接向量端点，请检查地址、网络及服务对当前 ST 站点的跨域许可",
        "connection",
        true,
      );
    }
    if (!response.ok) {
      const message = `向量服务返回 HTTP ${response.status}：${(await response.text()).slice(0, 500)}`;
      const category =
        response.status === 401 || response.status === 403
          ? "authentication"
          : response.status === 400 || response.status === 413 || response.status === 422
            ? "input"
            : "connection";
      throw new VectorEmbeddingRequestError(message, category, category !== "input");
    }
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("data" in body) ||
      !Array.isArray(body.data) ||
      body.data.length !== 1
    ) {
      throw new VectorEmbeddingRequestError("向量服务返回数量或格式不正确", "other", true);
    }
    const item: unknown = body.data[0];
    if (
      typeof item !== "object" ||
      item === null ||
      !("index" in item) ||
      item.index !== 0 ||
      !("embedding" in item) ||
      !Array.isArray(item.embedding) ||
      item.embedding.length === 0 ||
      item.embedding.some(
        (value: unknown) => typeof value !== "number" || !Number.isFinite(value),
      ) ||
      !item.embedding.some((value: number) => value !== 0) ||
      (connection.dimensions !== undefined && item.embedding.length !== connection.dimensions)
    ) {
      throw new VectorEmbeddingRequestError("向量服务返回的向量维度或数值不正确", "other", true);
    }
    return item.embedding as number[];
  }
}
