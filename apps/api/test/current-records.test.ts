import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryFieldService,
  MemoryRecordService,
  MemorySpaceService,
  MemoryTableService,
  type MemoryFieldId,
  type MemoryRecordId,
  type MemoryRecordHistoryId,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemoryTableId,
} from "@ste-memory/core";
import {
  migrateCoreDatabase,
  SqliteMemoryFieldRepository,
  SqliteMemoryRecordRepository,
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
  const directory = mkdtempSync(join(tmpdir(), "ste-current-records-"));
  const coreUrl = `sqlite:${join(directory, "core.sqlite")}`;
  const sourceUrl = `sqlite:${join(directory, "source.sqlite")}`;
  migrateCoreDatabase(coreUrl);
  migrateSourceStoreDatabase(sourceUrl);
  const spaceRepository = new SqliteMemorySpaceRepository(coreUrl);
  const tableRepository = new SqliteMemoryTableRepository(coreUrl);
  const fieldRepository = new SqliteMemoryFieldRepository(coreUrl);
  const recordRepository = new SqliteMemoryRecordRepository(coreUrl);
  const spaces = new MemorySpaceService(
    spaceRepository,
    () => randomUUID() as MemorySpaceId,
    () => randomUUID() as MemoryTableId,
    () => randomUUID() as MemoryFieldId,
    () => "2026-07-28T00:00:00.000Z",
  );
  const server = await buildServer({
    coreDatabase: healthCheck,
    sourceStoreDatabase: healthCheck,
    memorySpaces: new DefaultMemorySpaceManager(spaces, new SqliteSourceChatRepository(sourceUrl)),
    memoryTables: new MemoryTableService(
      spaceRepository,
      tableRepository,
      () => randomUUID() as MemoryTableId,
      () => "2026-07-28T00:00:00.000Z",
    ),
    memoryFields: new MemoryFieldService(
      tableRepository,
      fieldRepository,
      () => randomUUID() as MemoryFieldId,
      () => "2026-07-28T00:00:00.000Z",
    ),
    memoryRecords: new MemoryRecordService(
      tableRepository,
      fieldRepository,
      recordRepository,
      () => randomUUID() as MemoryRecordId,
      () => randomUUID() as MemoryRecordHistoryId,
      () => randomUUID() as MemoryRevisionId,
      () => "2026-07-28T01:02:03.000Z",
    ),
  });
  servers.push(server);
  const space = spaces.create("会话");
  const table = tableRepository.list(space.id).find((item) => item.systemKey === "characters")!;
  const fields = fieldRepository.list(space.id, table.id);
  return { server, space, table, fields };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("current memory record API", () => {
  it("creates, searches, pages, and reads records with manual or explicit source information", async () => {
    const { server, space, table, fields } = await testServer();
    const name = fields.find((field) => field.name === "名称")!;
    const identity = fields.find((field) => field.name === "身份/定位")!;
    const first = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/tables/${table.id}/records`,
      payload: { payload: { [name.id]: "林夏", [identity.id]: "调查员" } },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      displayText: "林夏",
      source: { type: "manual" },
      revisionSource: "user",
      payload: { [name.id]: "林夏", [identity.id]: "调查员" },
    });

    const second = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/tables/${table.id}/records`,
      payload: {
        payload: { [name.id]: "周遥", [identity.id]: "记者" },
        source: {
          type: "source",
          sourceTime: "2026-07-27T11:30:00.000Z",
          sourceLocation: "消息 42",
        },
      },
    });
    expect(second.statusCode).toBe(201);

    const listed = await server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/tables/${table.id}/records?page=1&pageSize=1&search=记者`,
    });
    expect(listed.json()).toMatchObject({
      page: 1,
      pageSize: 1,
      total: 1,
      totalPages: 1,
      records: [{ displayText: "周遥" }],
    });

    await server.inject({
      method: "PATCH",
      url: `/memory-spaces/${space.id}/tables/${table.id}/fields/${identity.id}`,
      payload: { enabled: false },
    });
    const detail = await server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/tables/${table.id}/records/${first.json<{ id: string }>().id}`,
    });
    expect(detail.json()).toMatchObject({
      payload: { [identity.id]: "调查员" },
    });
  });

  it("returns typed validation errors for invalid manual input", async () => {
    const { server, space, table, fields } = await testServer();
    const name = fields.find((field) => field.name === "名称")!;
    const response = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/tables/${table.id}/records`,
      payload: { payload: { [name.id]: 42 } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      type: "memory_record_field_value_invalid",
      param: { fieldId: name.id },
    });
  });

  it("patches fields, archives the old snapshot, and rejects stale revisions", async () => {
    const { server, space, table, fields } = await testServer();
    const name = fields.find((field) => field.name === "名称")!;
    const identity = fields.find((field) => field.name === "身份/定位")!;
    const created = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/tables/${table.id}/records`,
      payload: { payload: { [name.id]: "林夏", [identity.id]: "调查员" } },
    });
    const record = created.json<{ id: string; revisionId: string }>();
    const updated = await server.inject({
      method: "PATCH",
      url: `/memory-spaces/${space.id}/tables/${table.id}/records/${record.id}`,
      payload: { expectedRevisionId: record.revisionId, patch: { [identity.id]: null } },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      displayText: "林夏",
      payload: { [name.id]: "林夏", [identity.id]: null },
      revisionSource: "user",
    });
    const conflict = await server.inject({
      method: "PATCH",
      url: `/memory-spaces/${space.id}/tables/${table.id}/records/${record.id}`,
      payload: { expectedRevisionId: record.revisionId, patch: { [name.id]: "周遥" } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      type: "memory_record_revision_conflict",
      param: { recordId: record.id },
    });

    const histories = await server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/record-history?tableId=${table.id}&recordId=${record.id}&revisionId=${updated.json<{ revisionId: string }>().revisionId}&archivedFrom=2026-07-28T09:00:00%2B08:00&archivedTo=2026-07-28T10:00:00%2B08:00`,
    });
    expect(histories.json()).toEqual([
      expect.objectContaining({
        recordId: record.id,
        payload: { [name.id]: "林夏", [identity.id]: "调查员" },
      }),
    ]);
  });

  it("archives a complete snapshot before physically deleting a current record", async () => {
    const { server, space, table, fields } = await testServer();
    const name = fields.find((field) => field.name === "名称")!;
    const created = await server.inject({
      method: "POST",
      url: `/memory-spaces/${space.id}/tables/${table.id}/records`,
      payload: { payload: { [name.id]: "林夏" } },
    });
    const record = created.json<{ id: string; revisionId: string }>();
    const removed = await server.inject({
      method: "DELETE",
      url: `/memory-spaces/${space.id}/tables/${table.id}/records/${record.id}`,
      payload: { expectedRevisionId: record.revisionId },
    });

    expect(removed.statusCode).toBe(204);
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/memory-spaces/${space.id}/tables/${table.id}/records/${record.id}`,
        })
      ).statusCode,
    ).toBe(404);
    const histories = await server.inject({
      method: "GET",
      url: `/memory-spaces/${space.id}/record-history?recordId=${record.id}`,
    });
    expect(histories.json()).toEqual([
      expect.objectContaining({ recordId: record.id, displayText: "林夏" }),
    ]);
  });
});
