import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemorySpaceService,
  MemoryFieldService,
  type MemoryFieldId,
  MemoryTableService,
  type MemorySpaceId,
  type MemoryTableId,
} from "@ste-memory/core";
import {
  migrateCoreDatabase,
  SqliteMemoryFieldRepository,
  SqliteMemorySpaceRepository,
  SqliteMemoryTableRepository,
} from "@ste-memory/core-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseHealthCheck } from "../src/health/types.ts";
import { DefaultMemorySpaceManager } from "../src/memory-spaces/manager.ts";
import { buildServer } from "../src/server.ts";
import { migrateSourceStoreDatabase } from "../src/source-store/migrate.ts";
import { SqliteSourceChatRepository } from "../src/source-store/repository.ts";

const healthCheck: DatabaseHealthCheck = { check: () => ({ connected: true }) };
const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

async function testServer() {
  const directory = mkdtempSync(join(tmpdir(), "ste-memory-spaces-"));
  const coreUrl = `sqlite:${join(directory, "core.sqlite")}`;
  const sourceUrl = `sqlite:${join(directory, "source.sqlite")}`;
  migrateCoreDatabase(coreUrl);
  migrateSourceStoreDatabase(sourceUrl);
  const spacesRepository = new SqliteMemorySpaceRepository(coreUrl);
  const manager = new DefaultMemorySpaceManager(
    new MemorySpaceService(
      spacesRepository,
      () => randomUUID() as MemorySpaceId,
      () => "2026-07-27T00:00:00.000Z",
    ),
    new SqliteSourceChatRepository(sourceUrl),
  );
  const tableRepository = new SqliteMemoryTableRepository(coreUrl);
  const server = await buildServer({
    coreDatabase: healthCheck,
    sourceStoreDatabase: healthCheck,
    memorySpaces: manager,
    memoryTables: new MemoryTableService(
      spacesRepository,
      tableRepository,
      () => randomUUID() as MemoryTableId,
      () => "2026-07-27T00:00:00.000Z",
    ),
    memoryFields: new MemoryFieldService(
      tableRepository,
      new SqliteMemoryFieldRepository(coreUrl),
      () => randomUUID() as MemoryFieldId,
      () => "2026-07-27T00:00:00.000Z",
    ),
  });
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
