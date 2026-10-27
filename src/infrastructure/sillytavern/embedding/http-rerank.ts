import type { RerankConnection } from "../../../features/settings/rerank-settings.ts";
import type { RerankPort } from "../../../features/semantic-query/rerank.ts";

/** Cohere-compatible query/documents -> results[index,relevance_score]; browser direct HTTP. */
export class HttpRerankPort implements RerankPort {
  private readonly connection: RerankConnection;
  private readonly request: typeof fetch;
  constructor(
    connection: RerankConnection,
    request: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.connection = connection;
    this.request = request;
  }

  async rerank(
    query: string,
    documents: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly number[]> {
    const c = this.connection;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(c.timeoutSeconds * 1000)]);
    const body = JSON.stringify({ model: c.model, query, documents, top_n: documents.length });
    if (query.length > c.maxInputChars || documents.some((text) => text.length > c.maxInputChars))
      throw new Error(`重排输入超过单条 ${c.maxInputChars} 字符上限`);
    if (new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024)
      throw new Error("重排请求体超过 2 MiB 上限");
    let response: Response;
    try {
      response = await this.request(c.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
        },
        body,
        credentials: "omit",
        signal: requestSignal,
      });
    } catch (error) {
      if (requestSignal.aborted) throw requestSignal.reason;
      throw new Error("无法连接重排端点，请检查地址、网络和跨域许可", { cause: error });
    }
    if (!response.ok)
      throw new Error(
        `重排服务返回 HTTP ${response.status}：${(await response.text()).slice(0, 500)}`,
      );
    const data: unknown = await response.json();
    if (
      !data ||
      typeof data !== "object" ||
      !("results" in data) ||
      !Array.isArray(data.results) ||
      data.results.length !== documents.length
    )
      throw new Error("重排服务返回格式或候选数量不正确");
    const scores = new Array<number>(documents.length);
    const seen = new Set<number>();
    for (const result of data.results) {
      if (
        !result ||
        typeof result !== "object" ||
        !Number.isInteger(result.index) ||
        result.index < 0 ||
        result.index >= documents.length ||
        seen.has(result.index) ||
        typeof result.relevance_score !== "number" ||
        !Number.isFinite(result.relevance_score)
      )
        throw new Error("重排服务返回重复、越界索引或无效分数");
      seen.add(result.index);
      scores[result.index] = result.relevance_score;
    }
    requestSignal.throwIfAborted();
    return scores;
  }
}
