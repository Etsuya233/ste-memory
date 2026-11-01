import "fake-indexeddb/auto";
import { Dexie } from "dexie";
import { expect, it } from "vitest";
import { createTestDatabase } from "./test-support.ts";

it("旧库损坏空间内容不参与辅助DB启动，原任务与向量保持", async () => {
  const name = "sqlite-only-abandoned-content";
  const old = new Dexie(name);
  old.version(11).stores({
    memorySpaces: "id",
    memoryTables: "id",
    memoryFields: "id",
    memoryRecords: "id",
    memoryRecordHistory: "id",
    memoryEvidence: "id",
    memoryFillTasks: "runId, [memorySpaceId+createdAt], memorySpaceId",
    floorFillLedger: "id, &[memorySpaceId+floor], memorySpaceId",
    vectorTasks:
      "id, memorySpaceId, [memorySpaceId+tableId], [memorySpaceId+tableId+recordId], [status+createdAt]",
    recordVectors: "id, memorySpaceId, [memorySpaceId+tableId], [memorySpaceId+tableId+recordId]",
    vectorSuppressions: "id, memorySpaceId",
    assistantSessions: "id, spaceId, [chatKey+spaceId], updatedAt",
    memoryLogs: "++id",
  });
  await old
    .table("memorySpaces")
    .add({ id: "broken", macros: "corrupt", snapshotSchemaVersion: 999 });
  await old
    .table("memoryRecords")
    .add({ id: "bad-record", memorySpaceId: "missing", fieldEvidence: { unknown: "broken" } });
  await old
    .table("memoryFillTasks")
    .add({ runId: "task", memorySpaceId: "space", status: "queued" });
  await old.table("recordVectors").add({ id: "vector", memorySpaceId: "space" });
  old.close();
  const db = createTestDatabase(name);
  await db.open();
  expect(db.tables.map((table) => table.name)).not.toContain("memorySpaces");
  expect(db.tables.map((table) => table.name)).not.toContain("memoryRecords");
  expect(await db.memoryFillTasks.get("task")).toMatchObject({ status: "queued" });
  expect(await db.recordVectors.get("vector")).toMatchObject({ memorySpaceId: "space" });
});
