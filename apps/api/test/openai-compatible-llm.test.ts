import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildOpenAiCompatibleLlmPort } from "../src/adapters/outbound/llm/openai-compatible-llm.ts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** 本地假 OpenAI 兼容端点：校验鉴权头，按预排 delta 流式返回。 */
async function fakeOpenAiEndpoint(
  deltas: readonly string[],
): Promise<{ baseUrl: string; requests: Array<{ authorization: string | undefined }> }> {
  const requests: Array<{ authorization: string | undefined }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ authorization: request.headers.authorization });
      const payload = JSON.parse(body) as { model?: string };
      void payload;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const delta of deltas) {
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          })}\n\n`,
        );
      }
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("无法监听测试端口");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

describe("buildOpenAiCompatibleLlmPort", () => {
  it("按解析配置构造 provider：模型带 baseUrl，流式往返拿到回答增量", async () => {
    const { baseUrl, requests } = await fakeOpenAiEndpoint(["你", "好"]);
    const llm = buildOpenAiCompatibleLlmPort({
      baseUrl,
      apiKey: "sk-test-key",
      modelId: "test-model",
    });

    expect(llm.model).toMatchObject({ id: "test-model", baseUrl, api: "openai-completions" });

    const response = await llm.streamFn(
      llm.model,
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
        ],
      },
      { apiKey: "sk-test-key" },
    );
    const events = [];
    for await (const event of response) events.push(event);
    const final = await response.result();

    const text =
      final === undefined
        ? ""
        : final.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
    expect(text).toBe("你好");
    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    // API Key 以 Bearer 头发送，且请求打到了配置的 baseUrl（本地端点）
    expect(requests[0]?.authorization).toBe("Bearer sk-test-key");
  });

  it("getApiKey 钩子返回注入的 key（供 agent 循环透传为显式 key）", () => {
    const llm = buildOpenAiCompatibleLlmPort({
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "sk-in-memory",
      modelId: "m",
    });
    expect(llm.getApiKey?.("ste-memory-openai")).toBe("sk-in-memory");
  });
});
