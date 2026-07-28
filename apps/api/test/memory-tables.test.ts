import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemorySpaceService,
  MemoryTableService,
  type MemorySpaceId,
  type MemoryTableId,
} from "@ste-memory/core";
import {
  migrateCoreDatabase,
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
  const directory = mkdtempSync(join(tmpdir(), "ste-memory-tables-"));
  const coreUrl = `sqlite:${join(directory, "core.sqlite")}`;
  const sourceUrl = `sqlite:${join(directory, "source.sqlite")}`;
  migrateCoreDatabase(coreUrl);
  migrateSourceStoreDatabase(sourceUrl);
  const spacesRepository = new SqliteMemorySpaceRepository(coreUrl);
  const spaces = new MemorySpaceService(
    spacesRepository,
    () => randomUUID() as MemorySpaceId,
    () => "2026-07-28T00:00:00.000Z",
  );
  const tables = new MemoryTableService(
    spacesRepository,
    new SqliteMemoryTableRepository(coreUrl),
    () => randomUUID() as MemoryTableId,
    () => "2026-07-28T00:00:00.000Z",
  );
  const server = await buildServer({
    coreDatabase: healthCheck,
    sourceStoreDatabase: healthCheck,
    memorySpaces: new DefaultMemorySpaceManager(spaces, new SqliteSourceChatRepository(sourceUrl)),
    memoryTables: tables,
  });
  servers.push(server);
  return { server, spaces };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("memory table API", () => {
  it("creates and lists an empty custom table in its memory space", async () => {
    const { server, spaces } = await testServer();
    const space = spaces.create("会话");

    const response = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/tables`,
      payload: {
        name: "线索",
        description: "值得追踪的线索",
        prompt: "只保留仍可能影响后续情节的内容。",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      memorySpaceId: space.id,
      kind: "custom",
      name: "线索",
      description: "值得追踪的线索",
      prompt: "只保留仍可能影响后续情节的内容。",
      enabled: true,
    });
    expect(
      (await server.inject({ method: "GET", url: `/memory-spaces/${space.id}/tables` })).json(),
    ).toEqual([response.json()]);
  });

  it("updates, disables, reads, and physically deletes a table", async () => {
    const { server, spaces } = await testServer();
    const space = spaces.create("会话");
    const created = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/tables`,
      payload: { name: "线索" },
    });
    const table = created.json<{ id: string }>();

    const updated = await server.inject({
      method: "PATCH",
      url: `/memory-spaces/${space.id}/tables/${table.id}`,
      payload: {
        name: "关键线索",
        description: "只跟踪关键线索",
        prompt: "忽略已经完全回收的线索。",
        enabled: false,
      },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      name: "关键线索",
      description: "只跟踪关键线索",
      prompt: "忽略已经完全回收的线索。",
      enabled: false,
    });
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/memory-spaces/${space.id}/tables/${table.id}`,
        })
      ).json(),
    ).toEqual(updated.json());

    expect(
      (
        await server.inject({
          method: "DELETE",
          url: `/memory-spaces/${space.id}/tables/${table.id}`,
        })
      ).statusCode,
    ).toBe(204);
    const missing = await server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/tables/${table.id}`,
    });
    expect(missing.statusCode).toBe(404);
  });
});
