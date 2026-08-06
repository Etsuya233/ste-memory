import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { QUERY_RECORDS_TOOL_NAME } from "@ste-memory/core/memory/agent";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { buildServer } from "../src/adapters/inbound/http/server.ts";
import type { AgentRunEvent } from "../src/application/agent-events.ts";
import { createTestApplication } from "./test-application.ts";
import {
  assistantMessage,
  fakeModel,
  hangingStreamFn,
  lastToolResult,
  scriptedStreamFn,
  textMessage,
  toStream,
  toolCallMessage,
} from "./chat-stream-support.ts";
import { ScriptedEventStream } from "./chat-stream-support.ts";

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

type TestApplication = Awaited<ReturnType<typeof createTestApplication>>;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** 解析 SSE 响应体中的 data 行（本服务每个事件单行 JSON）。 */
function parseSseEvents(body: string): AgentRunEvent[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as AgentRunEvent);
}

/** 建一个安装了系统表、并在 characters 表写入「云烬/受伤」的空间。 */
async function setupSpaceWithRecords(
  server: Awaited<ReturnType<typeof buildServer>>,
  space: { readonly id: MemorySpaceId },
  tableRepository: TestApplication["tableRepository"],
  fieldRepository: TestApplication["fieldRepository"],
) {
  const table = (await tableRepository.list(space.id)).find((item) => item.key === "characters")!;
  const fields = await fieldRepository.list(space.id, table.id);
  const name = fields.find((field) => field.name === "名称")!;
  const status = fields.find((field) => field.name === "当前状态")!;
  const response = await server.inject({
    method: "POST",
    url: `/memory-spaces/${space.id}/tables/${table.id}/records`,
    payload: { payload: { [name.id]: "云烬", [status.id]: "受伤" } },
  });
  expect(response.statusCode).toBe(201);
  return { table, name, status };
}

describe("GET /llm-config", () => {
  it("只暴露非敏感的环境回退信息，不含 API Key 值", async () => {
    const { server } = await createTestApplication("ste-chat-config-", "2026-07-30T01:02:03.000Z", {
      envConfig: {
        baseUrl: "https://example.com/v1",
        model: "env-model",
        apiKey: "super-secret-env-key",
      },
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/llm-config" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      env: { baseUrl: "https://example.com/v1", model: "env-model", apiKeyConfigured: true },
    });
    expect(response.body).not.toContain("super-secret-env-key");
  });
});

describe("POST /memory-spaces/:spaceId/chat", () => {
  it("跑通整循环：工具调用 → 真实查询 → 回答增量 → done", async () => {
    const streamFn = scriptedStreamFn((context) => {
      if (!lastToolResult(context)) {
        return assistantMessage(
          [
            toolCallMessage("call-1", QUERY_RECORDS_TOOL_NAME, {
              table: "characters",
              conditions: [{ field: "current_status", op: "equals", value: "受伤" }],
            }),
          ],
          "toolUse",
        );
      }
      return assistantMessage([textMessage("当前受伤的角色：云烬。")], "stop");
    });
    const { server, spaces, systemTables, tableRepository, fieldRepository } =
      await createTestApplication("ste-chat-run-", "2026-07-30T01:02:03.000Z", {
        buildLlmPort: () => ({ streamFn, model: fakeModel() }),
      });
    servers.push(server);
    const space = await spaces.create("会话");
    await systemTables.install(space.id);
    await setupSpaceWithRecords(server, space, tableRepository, fieldRepository);

    const response = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/chat`,
      payload: {
        messages: [{ role: "user", content: "谁受伤了？" }],
        config: { model: "test-model", apiKey: "test-key", baseUrl: "" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const events = parseSseEvents(response.body);

    const toolStart = events.find((event) => event.type === "tool_start");
    expect(toolStart).toMatchObject({
      name: QUERY_RECORDS_TOOL_NAME,
      args: {
        table: "characters",
        conditions: [{ field: "current_status", op: "equals", value: "受伤" }],
      },
    });
    expect(typeof toolStart?.callId).toBe("string");

    const toolResult = events.find((event) => event.type === "tool_result");
    expect(toolResult?.isError).toBe(false);
    // 工具真的查了库：结果带记录 id/display，values 用字段 key 键控
    expect(toolResult?.result).toMatchObject({
      table: "characters",
      total: 1,
      records: [{ display: "云烬", values: { current_status: "受伤" } }],
    });

    const answer = events
      .filter((event) => event.type === "message_delta")
      .map((event) => (event as { type: "message_delta"; text: string }).text)
      .join("");
    expect(answer).toContain("云烬");

    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
    // 一次 run 两次流式调用：工具轮 + 回答轮
    expect(streamFn.calls.count).toBe(2);
  });

  it("多轮上下文：客户端回传历史文本，agent 无状态续跑", async () => {
    const streamFn = scriptedStreamFn((context) => {
      if (!lastToolResult(context)) {
        return assistantMessage(
          [toolCallMessage("call-1", QUERY_RECORDS_TOOL_NAME, { table: "characters" })],
          "toolUse",
        );
      }
      return assistantMessage([textMessage("第一轮回答")], "stop");
    });
    const { server, spaces, systemTables, tableRepository, fieldRepository } =
      await createTestApplication("ste-chat-history-", "2026-07-30T01:02:03.000Z", {
        buildLlmPort: () => ({ streamFn, model: fakeModel() }),
      });
    servers.push(server);
    const space = await spaces.create("会话");
    await systemTables.install(space.id);
    await setupSpaceWithRecords(server, space, tableRepository, fieldRepository);

    const first = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/chat`,
      payload: {
        messages: [{ role: "user", content: "介绍一下角色" }],
        config: { model: "test-model", apiKey: "test-key" },
      },
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/chat`,
      payload: {
        messages: [
          { role: "user", content: "介绍一下角色" },
          { role: "assistant", content: "第一轮回答" },
          { role: "user", content: "还有别的角色吗？" },
        ],
        config: { model: "test-model", apiKey: "test-key" },
      },
    });
    expect(second.statusCode).toBe(200);
    expect(parseSseEvents(second.body).at(-1)).toMatchObject({ type: "done" });

    // 第二轮第一次流式调用的上下文 = 完整历史（含第一轮回答文本）
    const secondTurnContext = streamFn.contexts[2]!;
    const texts = secondTurnContext.messages
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
      )
      .join(" | ");
    expect(texts).toContain("介绍一下角色");
    expect(texts).toContain("第一轮回答");
    expect(texts).toContain("还有别的角色吗？");
  });

  it("配置缺失：apiKey / model 双方都未配置时 400，且提示环境变量名", async () => {
    const { server, spaces } = await createTestApplication(
      "ste-chat-config-missing-",
      "2026-07-30T01:02:03.000Z",
    );
    servers.push(server);
    const space = await spaces.create("会话");

    // model 先校验：双方都未配置时报 model 缺失
    const none = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/chat`,
      payload: { messages: [{ role: "user", content: "你好" }] },
    });
    expect(none.statusCode).toBe(400);
    expect(none.json().message).toContain("OPENAI_MODEL");

    const noKey = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/chat`,
      payload: {
        messages: [{ role: "user", content: "你好" }],
        config: { model: "m" },
      },
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().message).toContain("OPENAI_API_KEY");

    const noModel = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/chat`,
      payload: {
        messages: [{ role: "user", content: "你好" }],
        config: { apiKey: "test-key" },
      },
    });
    expect(noModel.statusCode).toBe(400);
    expect(noModel.json().message).toContain("OPENAI_MODEL");
  });

  it("网页配置逐字段覆盖环境变量，空值回退（SSE 照常工作）", async () => {
    const streamFn = scriptedStreamFn(() => assistantMessage([textMessage("好")], "stop"));
    const { server, spaces, systemTables } = await createTestApplication(
      "ste-chat-env-",
      "2026-07-30T01:02:03.000Z",
      {
        envConfig: { baseUrl: "https://env.example.com/v1", model: "env-model", apiKey: "env-key" },
        buildLlmPort: (config) => {
          // 逐字段覆盖校验：web 的 model 生效、env 的 baseUrl 回退生效
          expect(config.model).toBe("web-model");
          expect(config.baseUrl).toBe("https://env.example.com/v1");
          expect(config.apiKey).toBe("env-key");
          expect(config.sources).toEqual({
            baseUrl: "env",
            model: "web",
            apiKey: "env",
          });
          return { streamFn, model: fakeModel() };
        },
      },
    );
    servers.push(server);
    const space = await spaces.create("会话");
    await systemTables.install(space.id);

    const response = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/chat`,
      payload: {
        messages: [{ role: "user", content: "你好" }],
        config: { model: "web-model", baseUrl: "", apiKey: "" },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(parseSseEvents(response.body).at(-1)).toMatchObject({ type: "done" });
  });

  it("记忆空间不存在时返回 404（预检先于 SSE 头）", async () => {
    const { server } = await createTestApplication("ste-chat-404-", "2026-07-30T01:02:03.000Z");
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: `/memory-spaces/does-not-exist/chat`,
      payload: {
        messages: [{ role: "user", content: "你好" }],
        config: { model: "m", apiKey: "k" },
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().message).toContain("记忆空间不存在");
  });

  it("消息形状校验：空列表 / 非 user 开头结尾 / config 非对象 → 400", async () => {
    const { server, spaces } = await createTestApplication(
      "ste-chat-shape-",
      "2026-07-30T01:02:03.000Z",
    );
    servers.push(server);
    const space = await spaces.create("会话");
    const url = `/memory-spaces/${space.id}/chat`;
    const config = { model: "m", apiKey: "k" };

    const empty = await server.inject({ method: "POST", url, payload: { messages: [], config } });
    expect(empty.statusCode).toBe(400);

    const startsWithAssistant = await server.inject({
      method: "POST",
      url,
      payload: { messages: [{ role: "assistant", content: "x" }], config },
    });
    expect(startsWithAssistant.statusCode).toBe(400);

    const endsWithAssistant = await server.inject({
      method: "POST",
      url,
      payload: {
        messages: [
          { role: "user", content: "x" },
          { role: "assistant", content: "y" },
        ],
        config,
      },
    });
    expect(endsWithAssistant.statusCode).toBe(400);

    const badConfig = await server.inject({
      method: "POST",
      url,
      payload: { messages: [{ role: "user", content: "x" }], config: "not-an-object" },
    });
    expect(badConfig.statusCode).toBe(400);
  });

  it("LLM 调用失败（网络/鉴权）以 SSE error 事件送达，不阻塞后续请求", async () => {
    const streamFn = scriptedStreamFn(() =>
      assistantMessage([], "error", "401 Unauthorized: invalid api key"),
    );
    const { server, spaces, systemTables } = await createTestApplication(
      "ste-chat-llm-error-",
      "2026-07-30T01:02:03.000Z",
      {
        buildLlmPort: () => ({ streamFn, model: fakeModel() }),
      },
    );
    servers.push(server);
    const space = await spaces.create("会话");
    await systemTables.install(space.id);

    const response = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/chat`,
      payload: {
        messages: [{ role: "user", content: "你好" }],
        config: { model: "m", apiKey: "bad-key" },
      },
    });
    expect(response.statusCode).toBe(200);
    const events = parseSseEvents(response.body);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect((events.at(-1) as { type: "error"; message: string }).message).toContain("401");

    // 不阻塞继续操作：换一个正常脚本可以再次对话
    const okStreamFn = scriptedStreamFn(() => assistantMessage([textMessage("好")], "stop"));
    const {
      server: server2,
      spaces: spaces2,
      systemTables: systemTables2,
    } = await createTestApplication("ste-chat-llm-error-2-", "2026-07-30T01:02:03.000Z", {
      buildLlmPort: () => ({ streamFn: okStreamFn, model: fakeModel() }),
    });
    servers.push(server2);
    const space2 = await spaces2.create("会话");
    await systemTables2.install(space2.id);
    const retry = await server2.inject({
      method: "POST",
      url: `/memory-spaces/${space2.id}/chat`,
      payload: {
        messages: [{ role: "user", content: "你好" }],
        config: { model: "m", apiKey: "good-key" },
      },
    });
    expect(parseSseEvents(retry.body).at(-1)).toMatchObject({ type: "done" });
  });

  it("超时：agent 内部超时中止，SSE error 事件提示", async () => {
    const { server, spaces, systemTables } = await createTestApplication(
      "ste-chat-timeout-",
      "2026-07-30T01:02:03.000Z",
      {
        buildLlmPort: () => ({ streamFn: hangingStreamFn(), model: fakeModel() }),
        timeoutMs: 50,
      },
    );
    servers.push(server);
    const space = await spaces.create("会话");
    await systemTables.install(space.id);

    const response = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/chat`,
      payload: {
        messages: [{ role: "user", content: "你好" }],
        config: { model: "m", apiKey: "k" },
      },
    });
    expect(response.statusCode).toBe(200);
    const events = parseSseEvents(response.body);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect((events.at(-1) as { type: "error"; message: string }).message).toContain("超时");
  });

  it("客户端断开：真实 socket 关闭 → 中止运行（AbortController 链路）", async () => {
    const started = { fired: false };
    const aborted = { fired: false };
    const streamFn: StreamFn = (_model, _context, options) => {
      started.fired = true;
      const stream = new ScriptedEventStream();
      options?.signal?.addEventListener(
        "abort",
        () => {
          aborted.fired = true;
          const message = assistantMessage([], "aborted", "客户端断开");
          stream.push({ type: "start", partial: message });
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end(message);
        },
        { once: true },
      );
      return toStream(stream);
    };
    const { server, spaces, systemTables } = await createTestApplication(
      "ste-chat-disconnect-",
      "2026-07-30T01:02:03.000Z",
      {
        buildLlmPort: () => ({ streamFn, model: fakeModel() }),
        timeoutMs: 30_000,
      },
    );
    servers.push(server);
    const space = await spaces.create("会话");
    await systemTables.install(space.id);

    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const port = Number(new URL(address).port);
    const body = JSON.stringify({
      messages: [{ role: "user", content: "你好" }],
      config: { model: "m", apiKey: "k" },
    });

    const socket = connect(port, "127.0.0.1");
    socket.write(
      `POST /memory-spaces/${space.id}/chat HTTP/1.1\r\n` +
        `host: 127.0.0.1:${port}\r\n` +
        "content-type: application/json\r\n" +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        "connection: keep-alive\r\n\r\n" +
        body,
    );
    // 等运行真正开始（streamFn 被调用）后断开连接
    await waitUntil(() => started.fired, 2000);
    socket.destroy();

    // 断开 → 连接 close → controller.abort() → agent 运行中止 → streamFn 的 signal 收到 abort
    await waitUntil(() => aborted.fired, 2000);
    expect(aborted.fired).toBe(true);
  });
});

/** 轮询等待条件成立（真实 socket 测试用）。 */
async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitUntil 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
