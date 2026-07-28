import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemorySpaceService,
  type MemoryField,
  type MemoryFieldId,
  type MemoryFieldKey,
  type MemoryRecord,
  type MemoryRecordHistory,
  type MemoryRecordHistoryId,
  type MemoryRecordId,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
  type MemoryTableKey,
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
      () => "2026-07-28T00:00:00.000Z",
    );
    const space = spaces.create("会话");
    const tables = new SqliteMemoryTableRepository(databaseUrl);
    const table = memoryTable(space.id, "table-1", "characters");
    tables.create(table);
    const fields = new SqliteMemoryFieldRepository(databaseUrl);
    const field = memoryField(space.id, table.id, "field-1", "name");
    fields.create(field);
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

  it("commits updates and physical deletes atomically while preserving filterable history", () => {
    const databaseUrl = `sqlite:${join(mkdtempSync(join(tmpdir(), "history-")), "core.sqlite")}`;
    migrateCoreDatabase(databaseUrl);
    const spaces = new MemorySpaceService(
      new SqliteMemorySpaceRepository(databaseUrl),
      () => "space-1" as MemorySpaceId,
      () => "2026-07-28T00:00:00.000Z",
    );
    const space = spaces.create("会话");
    const tableRepository = new SqliteMemoryTableRepository(databaseUrl);
    const tables = [
      memoryTable(space.id, "table-1", "characters"),
      memoryTable(space.id, "table-2", "locations"),
    ];
    tables.forEach((table) => tableRepository.create(table));
    const repository = new SqliteMemoryRecordRepository(databaseUrl);
    const first = record(space.id, tables[0]!.id, "record-1", "revision-1", "林夏");
    const second = record(space.id, tables[1]!.id, "record-2", "revision-2", "港口");
    repository.create(first);
    repository.create(second);
    const updated = {
      ...first,
      payload: { name: "周遥" },
      displayText: "周遥",
      revisionId: "revision-batch" as MemoryRevisionId,
      updatedAt: "2026-07-28T02:00:00.000Z",
    };

    expect(
      repository.commit([
        mutation(first, updated, "history-1"),
        mutation(second, undefined, "history-2"),
      ]),
    ).toBe(true);
    expect(repository.find(space.id, first.tableId, first.id)).toEqual(updated);
    expect(repository.find(space.id, second.tableId, second.id)).toBeUndefined();
    expect(
      repository.listHistory({
        memorySpaceId: space.id,
        tableId: first.tableId,
        recordId: first.id,
        revisionId: "revision-batch" as MemoryRevisionId,
        archivedFrom: "2026-07-28T01:00:00.000Z",
        archivedTo: "2026-07-28T03:00:00.000Z",
      }),
    ).toEqual([expect.objectContaining({ id: "history-1", payload: { name: "林夏" } })]);
  });

  it("rolls back every history and current-row change when one revision is stale", () => {
    const databaseUrl = `sqlite:${join(mkdtempSync(join(tmpdir(), "conflict-")), "core.sqlite")}`;
    migrateCoreDatabase(databaseUrl);
    const spaces = new MemorySpaceService(
      new SqliteMemorySpaceRepository(databaseUrl),
      () => "space-1" as MemorySpaceId,
      () => "2026-07-28T00:00:00.000Z",
    );
    const space = spaces.create("会话");
    const table = memoryTable(space.id, "table-1", "characters");
    new SqliteMemoryTableRepository(databaseUrl).create(table);
    const repository = new SqliteMemoryRecordRepository(databaseUrl);
    const first = record(space.id, table.id, "record-1", "revision-1", "林夏");
    const stale = record(space.id, table.id, "record-2", "stale", "周遥");
    repository.create(first);
    repository.create({ ...stale, revisionId: "actual" as MemoryRevisionId });

    expect(
      repository.commit([
        mutation(first, { ...first, displayText: "changed" }, "history-1"),
        mutation(stale, undefined, "history-2"),
      ]),
    ).toBe(false);
    expect(repository.find(space.id, table.id, first.id)).toEqual(first);
    expect(repository.listHistory({ memorySpaceId: space.id })).toEqual([]);
  });
});

function memoryTable(memorySpaceId: MemorySpaceId, id: string, key: string): MemoryTable {
  return {
    id: id as MemoryTableId,
    memorySpaceId,
    key: key as MemoryTableKey,
    kind: "custom",
    name: key,
    description: "",
    prompt: "",
    enabled: true,
    displayStrategy: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function memoryField(
  memorySpaceId: MemorySpaceId,
  tableId: MemoryTableId,
  id: string,
  key: string,
): MemoryField {
  return {
    id: id as MemoryFieldId,
    memorySpaceId,
    tableId,
    key: key as MemoryFieldKey,
    name: key,
    type: "short_text",
    required: true,
    prompt: "",
    enabled: true,
    position: 0,
    options: [],
    referenceTableId: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function record(
  memorySpaceId: MemorySpaceId,
  tableId: MemoryTableId,
  id: string,
  revisionId: string,
  displayText: string,
): MemoryRecord {
  return {
    id: id as MemoryRecordId,
    memorySpaceId,
    tableId,
    payload: { name: displayText },
    displayText,
    source: { type: "manual" },
    revisionId: revisionId as MemoryRevisionId,
    revisionSource: "user",
    createdAt: "2026-07-28T01:00:00.000Z",
    updatedAt: "2026-07-28T01:00:00.000Z",
  };
}

function mutation(previous: MemoryRecord, current: MemoryRecord | undefined, id: string) {
  const history: MemoryRecordHistory = {
    id: id as MemoryRecordHistoryId,
    recordId: previous.id,
    memorySpaceId: previous.memorySpaceId,
    tableId: previous.tableId,
    payload: previous.payload,
    displayText: previous.displayText,
    source: previous.source,
    previousRevisionId: previous.revisionId,
    previousRevisionSource: previous.revisionSource,
    revisionId: "revision-batch" as MemoryRevisionId,
    revisionSource: "agent",
    createdAt: previous.createdAt,
    updatedAt: previous.updatedAt,
    archivedAt: "2026-07-28T02:00:00.000Z",
  };
  return { previous, current, history };
}
