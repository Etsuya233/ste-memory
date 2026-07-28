import { afterEach, describe, expect, it } from "vitest";
import type { buildServer } from "../src/server.ts";
import { createTestApplication } from "./test-application.ts";

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

async function testServer() {
  const { server } = await createTestApplication("ste-memory-spaces-", "2026-07-27T00:00:00.000Z");
  servers.push(server);
  return server;
}

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

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("memory space API", () => {
  it("allows local web origins to rename and delete spaces", async () => {
    const server = await testServer();
    const response = await server.inject({
      method: "OPTIONS",
      url: "/memory-spaces/example",
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "PATCH",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(response.headers["access-control-allow-methods"]).toContain("DELETE");
    expect(response.headers["access-control-allow-methods"]).toContain("PUT");
  });

  it("rejects creation without a JSONL file and creates no space", async () => {
    const server = await testServer();
    const boundary = "missing-file";
    const response = await server.inject({
      method: "POST",
      url: "/memory-spaces",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, "测试空间"),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "创建记忆空间必须上传 JSONL 文件" });
    expect((await server.inject({ method: "GET", url: "/memory-spaces" })).json()).toEqual([]);
  });

  it("translates core domain errors by their stable type", async () => {
    const server = await testServer();
    const response = await server.inject({
      method: "PATCH",
      url: "/memory-spaces/example",
      payload: { name: "a".repeat(121) },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      type: "memory_space_name_too_long",
      param: { maxLength: 120 },
      message: "记忆空间名称不能超过 120 个字符",
    });
  });

  it("stores valid messages and exposes parse errors", async () => {
    const server = await testServer();
    const boundary = "valid-chat";
    const file = [
      JSON.stringify({ user_name: "U", character_name: "C", chat_metadata: {} }),
      JSON.stringify({ name: "U", is_user: true, mes: "first" }),
      "broken",
      JSON.stringify({ name: "C", is_user: false, mes: "second" }),
    ].join("\n");
    const created = await server.inject({
      method: "POST",
      url: "/memory-spaces",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, "会话", file),
    });

    expect(created.statusCode).toBe(201);
    const space = created.json<{ id: string; messageCount: number; errorCount: number }>();
    expect(space).toMatchObject({ messageCount: 2, errorCount: 1 });
    const tables = await server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/tables`,
    });
    expect(tables.json<{ key: string }[]>()).toHaveLength(7);
    expect(new Set(tables.json<{ key: string }[]>().map((table) => table.key))).toEqual(
      new Set([
        "characters",
        "relationships",
        "locations",
        "items",
        "plots",
        "foreshadowing",
        "todos",
      ]),
    );
    const characterTable = tables
      .json<{ id: string; key: string; prompt: string }[]>()
      .find((table) => table.key === "characters")!;
    expect(characterTable.prompt.length).toBeGreaterThan(0);
    const disabled = await server.inject({
      method: "PATCH",
      url: `/memory-spaces/${space.id}/tables/${characterTable.id}`,
      payload: { enabled: false, prompt: "自定义人物填写规则" },
    });
    expect(disabled.json()).toMatchObject({
      key: "characters",
      enabled: false,
      prompt: "自定义人物填写规则",
    });
    const characterFields = await server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/tables/${characterTable.id}/fields`,
    });
    const currentStatus = characterFields
      .json<{ id: string; name: string; prompt: string }[]>()
      .find((field) => field.name === "当前状态")!;
    expect(currentStatus.prompt.length).toBeGreaterThan(0);
    const editedField = await server.inject({
      method: "PATCH",
      url: `/memory-spaces/${space.id}/tables/${characterTable.id}/fields/${currentStatus.id}`,
      payload: { prompt: "仅维护仍然成立的状态" },
    });
    expect(editedField.json()).toMatchObject({
      field: { prompt: "仅维护仍然成立的状态" },
      warnings: [],
    });
    const messages = await server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/messages`,
    });
    expect(messages.json()).toMatchObject([
      { source_type: "sillytavern_jsonl", source_id: 1, content: "first" },
      { source_type: "sillytavern_jsonl", source_id: 2, content: "second" },
    ]);
    const errors = await server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/parse-errors`,
    });
    expect(errors.json()).toEqual([
      { lineNumber: 3, rawLine: "broken", message: "该行不是有效的 JSON" },
    ]);

    const renamed = await server.inject({
      method: "PATCH",
      url: `/memory-spaces/${space.id}`,
      payload: { name: "重命名会话" },
    });
    expect(renamed.json()).toMatchObject({ name: "重命名会话", messageCount: 2 });
    expect(
      (await server.inject({ method: "DELETE", url: `/memory-spaces/${space.id}` })).statusCode,
    ).toBe(204);
    expect((await server.inject({ method: "GET", url: "/memory-spaces" })).json()).toEqual([]);
  });
});
