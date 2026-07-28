import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemorySpaceService,
  type MemoryFieldId,
  type MemoryRecord,
  type MemoryRecordId,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemoryTableId,
} from "@ste-memory/core";
import { describe, expect, it } from "vitest";
import {
  migrateCoreDatabase,
  SqliteMemoryFieldRepository,
  SqliteMemoryRecordRepository,
  SqliteMemorySpaceRepository,
  SqliteMemoryTableRepository,
} from "../src/index.ts";

describe("SqliteMemoryRecordRepository", () => {
  it("round-trips structured payload and source metadata after a field is disabled", () => {
    const databaseUrl = `sqlite:${join(mkdtempSync(join(tmpdir(), "records-")), "core.sqlite")}`;
    migrateCoreDatabase(databaseUrl);
    const spaces = new MemorySpaceService(
      new SqliteMemorySpaceRepository(databaseUrl),
      () => "space-1" as MemorySpaceId,
      (() => {
        let count = 0;
        return () => `table-${++count}` as MemoryTableId;
      })(),
      (() => {
        let count = 0;
        return () => `field-${++count}` as MemoryFieldId;
      })(),
      () => "2026-07-28T00:00:00.000Z",
    );
    const space = spaces.create("会话");
    const table = new SqliteMemoryTableRepository(databaseUrl).list(space.id)[0]!;
    const fields = new SqliteMemoryFieldRepository(databaseUrl);
    const field = fields.list(space.id, table.id)[0]!;
    fields.update({ ...field, enabled: false, updatedAt: "2026-07-28T01:00:00.000Z" });
    const repository = new SqliteMemoryRecordRepository(databaseUrl);
    const record: MemoryRecord = {
      id: "record-1" as MemoryRecordId,
      memorySpaceId: space.id,
      tableId: table.id,
      payload: { [field.id]: "林夏", count: 2, active: true, labels: ["主角"] },
      displayText: "林夏",
      source: {
        type: "source",
        sourceTime: "2026-07-27T11:30:00.000Z",
        sourceLocation: "消息 42",
      },
      revisionId: "revision-1" as MemoryRevisionId,
      revisionSource: "user",
      createdAt: "2026-07-28T01:02:03.000Z",
      updatedAt: "2026-07-28T01:02:03.000Z",
    };

    repository.create(record);

    expect(repository.find(space.id, table.id, record.id)).toEqual(record);
    expect(repository.list(space.id, table.id)).toEqual([record]);
  });
});
