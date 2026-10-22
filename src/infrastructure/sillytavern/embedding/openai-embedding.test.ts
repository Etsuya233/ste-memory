import { describe, expect, it, vi } from "vitest";
import type { EmbeddingConnection } from "../../../features/settings/embedding-connection.ts";
import { parseEmbeddingConnection } from "../../../features/settings/embedding-connection.ts";
import { OpenAiEmbeddingPort } from "./openai-embedding.ts";

const connection: EmbeddingConnection = {
  baseUrl: "https://embedding.example/v1",
  apiKey: "test-key",
  model: "test-embedding",
  maxInputChars: 1000,
  timeoutSeconds: 1,
};

describe("独立 embedding 连接", () => {
  it("旧设置缺省保持未配置，显式非法设置及非HTTP地址报错", () => {
    expect(parseEmbeddingConnection(undefined)).toBeUndefined();
    expect(() => parseEmbeddingConnection({ ...connection, maxInputChars: 0 })).toThrow("字符上限");
    expect(() => parseEmbeddingConnection({ ...connection, baseUrl: "file:///test" })).toThrow(
      "HTTP",
    );
    expect(() => parseEmbeddingConnection({ ...connection, dimensions: -1 })).toThrow("维度");
  });

  it("发送独立模型和完整字段文本，密钥轮换不改变向量目标", async () => {
    let current = connection;
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [{ index: 0, embedding: [0.2, 0.3] }],
        model: connection.model,
      }),
    );
    const port = new OpenAiEmbeddingPort(() => current, request);
    const before = port.getProfile();
    expect(await port.embed("姓名：张三\n背景：旅人", new AbortController().signal)).toEqual([
      0.2, 0.3,
    ]);
    expect(request).toHaveBeenCalledWith(
      "https://embedding.example/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      }),
    );
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({
      model: "test-embedding",
      input: "姓名：张三\n背景：旅人",
      encoding_format: "float",
    });
    current = { ...current, apiKey: "new-key" };
    expect(port.getProfile()).toEqual(before);
    current = { ...current, dimensions: 3 };
    expect(port.getProfile()!.version).not.toEqual(before!.version);
  });

  it("完整embeddings地址不重复加路径，局部端点可不配置密钥", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ index: 0, embedding: [1] }] }));
    const port = new OpenAiEmbeddingPort(
      () => ({ ...connection, baseUrl: "http://localhost:8080/v1/embeddings/", apiKey: "" }),
      request,
    );
    await port.embed("字段：内容", new AbortController().signal);
    expect(request.mock.calls[0]![0]).toBe("http://localhost:8080/v1/embeddings");
    expect(request.mock.calls[0]![1]!.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("鉴权失败阻塞连接，超长输入在请求前失败", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("invalid key", { status: 401 }));
    const port = new OpenAiEmbeddingPort(() => connection, request);
    await expect(port.embed("内容", new AbortController().signal)).rejects.toMatchObject({
      category: "authentication",
      global: true,
    });
    request.mockClear();
    await expect(port.embed("字".repeat(1001), new AbortController().signal)).rejects.toMatchObject(
      {
        category: "input",
        global: false,
      },
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("数量、维度和无效数值均不发布为向量", async () => {
    for (const data of [
      [],
      [{ index: 1, embedding: [1, 2] }],
      [{ index: 0, embedding: [1] }],
      [{ index: 0, embedding: [0, 0] }],
    ]) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data }));
      const port = new OpenAiEmbeddingPort(() => ({ ...connection, dimensions: 2 }), request);
      await expect(port.embed("字段：内容", new AbortController().signal)).rejects.toMatchObject({
        global: true,
      });
    }
  });

  it("用户取消会传递至fetch，并保留取消语义", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      controller.abort();
      expect(options!.signal!.aborted).toBe(true);
      throw new DOMException("cancelled", "AbortError");
    });
    const port = new OpenAiEmbeddingPort(() => connection, request);
    await expect(port.embed("内容", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
