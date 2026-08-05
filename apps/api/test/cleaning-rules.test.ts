import { afterEach, describe, expect, it } from "vitest";
import type { buildServer } from "../src/adapters/inbound/http/server.ts";
import type { CleaningRule } from "../src/application/ports/cleaning-rule.ts";
import { createTestApplication } from "./test-application.ts";

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

async function testServer() {
  const { server } = await createTestApplication(
    "ste-memory-cleaning-",
    "2026-07-27T00:00:00.000Z",
  );
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function multipart(boundary: string, name: string, file?: string): string {
  const parts = [`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`];
  if (file !== undefined) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chat.jsonl"\r\nContent-Type: application/jsonl\r\n\r\n${file}\r\n`,
    );
  }
  parts.push(`--${boundary}--\r\n`);
  return parts.join("");
}

const CHAT = [
  '{"name":"Alice","is_user":true,"mes":"*你好*，**世界**！【重要】今天天气不错。"}',
  '{"name":"Bob","is_user":false,"mes":"（点头）【提醒】明天记得买牛奶。"}',
  '{"name":"Alice","is_user":true,"mes":"普通消息，没有符号。"}',
].join("\n");

async function createSpace(server: Awaited<ReturnType<typeof buildServer>>) {
  const boundary = "cleaning-test";
  const response = await server.inject({
    method: "POST",
    url: "/memory-spaces",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: multipart(boundary, "清洗测试", CHAT),
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

describe("清洗规则 API", () => {
  it("创建规则后 messages 返回清洗后内容，raw 参数返回原文", async () => {
    const server = await testServer();
    const spaceId = await createSpace(server);

    const created = await server.inject({
      method: "POST",
      url: `/memory-spaces/${spaceId}/cleaning-rules`,
      payload: { name: "去星号", mode: "discard", pattern: "\\*", flags: "g" },
    });
    expect(created.statusCode).toBe(201);

    const messages = await server.inject({
      method: "GET",
      url: `/memory-spaces/${spaceId}/messages`,
    });
    expect(messages.statusCode).toBe(200);
    const body = messages.json() as { content: string }[];
    expect(body).toHaveLength(3);
    expect(body[0]!.content).toBe("你好，世界！【重要】今天天气不错。");
    expect(body[1]!.content).toBe("（点头）【提醒】明天记得买牛奶。");
    expect(body[2]!.content).toBe("普通消息，没有符号。");

    const raw = await server.inject({
      method: "GET",
      url: `/memory-spaces/${spaceId}/messages?raw=1`,
    });
    const rawBody = raw.json() as { content: string }[];
    expect(rawBody[0]!.content).toBe("*你好*，**世界**！【重要】今天天气不错。");
  });

  it("保留 + 去掉按顺序执行：先去括号再保留内容", async () => {
    const server = await testServer();
    const spaceId = await createSpace(server);

    await server.inject({
      method: "POST",
      url: `/memory-spaces/${spaceId}/cleaning-rules`,
      payload: { name: "去星号", mode: "discard", pattern: "[*（）]", flags: "g" },
    });
    const kept = await server.inject({
      method: "POST",
      url: `/memory-spaces/${spaceId}/cleaning-rules`,
      payload: { name: "保留括号内", mode: "keep", pattern: "【([^】]+)】", flags: "g" },
    });
    expect(kept.statusCode).toBe(201);

    const messages = await server.inject({
      method: "GET",
      url: `/memory-spaces/${spaceId}/messages`,
    });
    const body = messages.json() as { content: string }[];
    expect(body[0]!.content).toBe("重要");
    expect(body[1]!.content).toBe("提醒");
    expect(body[2]!.content).toBe("普通消息，没有符号。");
  });

  it("校验：语法错误 400；空匹配正则允许保存；非法 flags 拒绝", async () => {
    const server = await testServer();
    const spaceId = await createSpace(server);

    const invalid = await server.inject({
      method: "POST",
      url: `/memory-spaces/${spaceId}/cleaning-rules`,
      payload: { name: "坏正则", mode: "discard", pattern: "([", flags: "g" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().message).toContain("语法错误");

    const emptyMatch = await server.inject({
      method: "POST",
      url: `/memory-spaces/${spaceId}/cleaning-rules`,
      payload: { name: "空匹配", mode: "keep", pattern: "x*", flags: "g" },
    });
    expect(emptyMatch.statusCode).toBe(201);

    const badFlags = await server.inject({
      method: "POST",
      url: `/memory-spaces/${spaceId}/cleaning-rules`,
      payload: { name: "坏flags", mode: "discard", pattern: "a", flags: "gg" },
    });
    expect(badFlags.statusCode).toBe(400);
  });

  it("update/delete/reorder 生效，且 delete 后 position 重排连续", async () => {
    const server = await testServer();
    const spaceId = await createSpace(server);

    const a = await server.inject({
      method: "POST",
      url: `/memory-spaces/${spaceId}/cleaning-rules`,
      payload: { name: "A", mode: "discard", pattern: "a", flags: "g" },
    });
    const b = await server.inject({
      method: "POST",
      url: `/memory-spaces/${spaceId}/cleaning-rules`,
      payload: { name: "B", mode: "discard", pattern: "b", flags: "g" },
    });
    const aId = a.json().id;
    const bId = b.json().id;

    const patched = await server.inject({
      method: "PATCH",
      url: `/memory-spaces/${spaceId}/cleaning-rules/${aId}`,
      payload: { enabled: false, pattern: "A" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ enabled: false, pattern: "A", name: "A" });

    // 只更新 enabled 的部分补丁也必须通过（合并校验用当前值）
    const enabledOnly = await server.inject({
      method: "PATCH",
      url: `/memory-spaces/${spaceId}/cleaning-rules/${aId}`,
      payload: { enabled: true },
    });
    expect(enabledOnly.statusCode).toBe(200);

    const reordered = await server.inject({
      method: "PUT",
      url: `/memory-spaces/${spaceId}/cleaning-rules/order`,
      payload: { ruleIds: [bId, aId] },
    });
    expect(reordered.statusCode).toBe(200);
    expect((reordered.json() as CleaningRule[]).map((rule) => rule.id)).toEqual([bId, aId]);

    const removed = await server.inject({
      method: "DELETE",
      url: `/memory-spaces/${spaceId}/cleaning-rules/${bId}`,
    });
    expect(removed.statusCode).toBe(204);

    const list = await server.inject({
      method: "GET",
      url: `/memory-spaces/${spaceId}/cleaning-rules`,
    });
    const rules = list.json() as CleaningRule[];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: aId, position: 0 });

    const missing = await server.inject({
      method: "DELETE",
      url: `/memory-spaces/${spaceId}/cleaning-rules/${bId}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("创建时 enabled 默认 true，可传 false 创建停用规则", async () => {
    const server = await testServer();
    const spaceId = await createSpace(server);

    const disabled = await server.inject({
      method: "POST",
      url: `/memory-spaces/${spaceId}/cleaning-rules`,
      payload: { name: "停用规则", mode: "discard", pattern: "a", flags: "g", enabled: false },
    });
    expect(disabled.statusCode).toBe(201);
    expect(disabled.json()).toMatchObject({ enabled: false });

    const list = await server.inject({
      method: "GET",
      url: `/memory-spaces/${spaceId}/cleaning-rules`,
    });
    const rules = list.json() as CleaningRule[];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ enabled: false, position: 0 });

    const badEnabled = await server.inject({
      method: "POST",
      url: `/memory-spaces/${spaceId}/cleaning-rules`,
      payload: { name: "坏enabled", mode: "discard", pattern: "a", flags: "g", enabled: "yes" },
    });
    expect(badEnabled.statusCode).toBe(400);
  });

  it("reorder 与规则列表不匹配时 400，空间不存在时 404", async () => {
    const server = await testServer();
    const spaceId = await createSpace(server);

    const bad = await server.inject({
      method: "PUT",
      url: `/memory-spaces/${spaceId}/cleaning-rules/order`,
      payload: { ruleIds: ["不存在"] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain("不匹配");

    const missingSpace = await server.inject({
      method: "PUT",
      url: "/memory-spaces/nope/cleaning-rules/order",
      payload: { ruleIds: [] },
    });
    expect(missingSpace.statusCode).toBe(404);
  });

  it("不存在的记忆空间返回 404", async () => {
    const server = await testServer();
    const response = await server.inject({
      method: "GET",
      url: "/memory-spaces/nope/cleaning-rules",
    });
    expect(response.statusCode).toBe(404);
  });

  it("limit 参数限制返回条数，非法 limit 400", async () => {
    const server = await testServer();
    const spaceId = await createSpace(server);

    const limited = await server.inject({
      method: "GET",
      url: `/memory-spaces/${spaceId}/messages?raw=1&limit=2`,
    });
    expect(limited.statusCode).toBe(200);
    expect(limited.json() as unknown[]).toHaveLength(2);

    const bad = await server.inject({
      method: "GET",
      url: `/memory-spaces/${spaceId}/messages?limit=0`,
    });
    expect(bad.statusCode).toBe(400);
  });
});
