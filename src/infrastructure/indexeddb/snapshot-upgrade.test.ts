import "fake-indexeddb/auto";
import { Dexie } from "dexie";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "./test-support.ts";
import { DexieMemoryBackupRepository } from "./backup/memory-backup-repository.ts";
import { legacySnapshotFixture } from "../../features/memory-snapshot/snapshot-test-fixture.ts";
import { migrateMemorySpaceSnapshot } from "../../features/memory-snapshot/snapshot-migration.ts";
import { decodeBackupFile } from "../../features/backup/backup-codec.ts";
import { DexieMemorySpaceRepository } from "./memory/memory-space-repository.ts";
import type { MemorySpaceId } from "../../features/memory/index.ts";

function oldDatabase(name: string, installed: number): Dexie {
  const db = new Dexie(name);
  db.version(1).stores({
    memorySpaces: "id",
    memoryTables: "id, &[memorySpaceId+key], memorySpaceId",
    memoryFields: "id, &[memorySpaceId+tableId+key], [memorySpaceId+tableId]",
  });
  if (installed >= 2)
    db.version(2).stores({
      memoryRecords: "id, [memorySpaceId+tableId], memorySpaceId",
      memoryRecordHistory:
        "id, [memorySpaceId+tableId+recordId], [memorySpaceId+recordId], memorySpaceId",
      memoryEvidence: "id, &[memorySpaceId+source_type+source_id], memorySpaceId",
    });
  if (installed >= 3)
    db.version(3).stores({
      memoryFillTasks: "runId, [memorySpaceId+createdAt], memorySpaceId",
      floorFillLedger: "id, &[memorySpaceId+floor], memorySpaceId",
    });
  if (installed >= 4)
    db.version(4).stores({
      memoryLogs: "++id, [type+createdAt], [key+createdAt], [spaceId+createdAt]",
    });
  if (installed >= 6)
    db.version(6).stores({
      vectorTasks: "id, memorySpaceId",
      recordVectors: "id, memorySpaceId",
      vectorSuppressions: "id, memorySpaceId",
    });
  if (installed >= 9)
    db.version(9).stores({ assistantSessions: "id, spaceId, [chatKey+spaceId], updatedAt" });
  db.version(installed).stores({});
  return db;
}

describe("旧Dexie快照升级", () => {
  it.each([1, 4, 6, 7, 9, 10])("已安装v%i统一升级到当前快照并持久化版本", async (version) => {
    const name = `snapshot-upgrade-${version}`;
    const old = oldDatabase(name, version);
    const legacy = legacySnapshotFixture();
    const current = migrateMemorySpaceSnapshot({ version: "legacy-macros", snapshot: legacy });
    const space =
      version >= 8
        ? current.space
        : version >= 5
          ? { ...legacy.space, initializationSource: null }
          : legacy.space;
    const table =
      version >= 7
        ? current.tables[0]!
        : version >= 5
          ? { ...legacy.tables[0]!, position: 0 }
          : legacy.tables[0]!;
    await old.table("memorySpaces").add(space);
    await old.table("memoryTables").add(table);
    await old.table("memoryFields").bulkAdd(legacy.fields);
    if (version >= 2) {
      await old.table("memoryRecords").bulkAdd(legacy.records);
      await old.table("memoryRecordHistory").bulkAdd(legacy.history);
    }
    if (version >= 6)
      await old
        .table("recordVectors")
        .add({ id: "vector", memorySpaceId: "space", payload: "保留" });
    if (version >= 9)
      await old.table("assistantSessions").add({
        id: "session",
        spaceId: "space",
        ...(version === 10 ? { storageRevision: 7 } : {}),
      });
    old.close();
    const db = createTestDatabase(name);
    await db.open();
    const local = (await new DexieMemoryBackupRepository(db).loadSnapshot()).spaces[0]!;
    const fileSnapshot = version >= 2 ? legacy : { ...legacy, records: [], history: [] };
    const file = decodeBackupFile({
      format: "ste-memory-backup",
      version: 2,
      exportedAt: "now",
      appVersion: "test",
      data: { spaces: [fileSnapshot] },
    });
    expect(local).toEqual({ ...file.data.spaces[0], fillTasks: [], floorLedger: [] });
    expect(await db.memorySpaces.get("space" as MemorySpaceId)).toHaveProperty(
      "snapshotSchemaVersion",
      1,
    );
    expect(local.space).not.toHaveProperty("snapshotSchemaVersion");
    expect(
      await new DexieMemorySpaceRepository(db).find("space" as MemorySpaceId),
    ).not.toHaveProperty("snapshotSchemaVersion");
    if (version >= 6)
      expect(await db.recordVectors.get("vector")).toHaveProperty("payload", "保留");
    if (version >= 9)
      expect(await db.assistantSessions.get("session")).toHaveProperty(
        "storageRevision",
        version === 10 ? 7 : 0,
      );
    await new DexieMemoryBackupRepository(db).restoreSpace(local);
    db.close();
    await db.open();
    expect((await new DexieMemoryBackupRepository(db).loadSnapshot()).spaces[0]).toEqual(local);
    await db.memorySpaces.update("space" as MemorySpaceId, { macros: undefined });
    await expect(new DexieMemoryBackupRepository(db).loadSnapshot()).rejects.toThrow("macros");
  });
  it("旧本地表按创建时间赋位，旧文件按数组赋位，已有位置保留", async () => {
    const name = "snapshot-upgrade-order";
    const old = oldDatabase(name, 4);
    const legacy = legacySnapshotFixture();
    const earlier = {
      ...legacy.tables[0]!,
      id: "z-earlier",
      key: "earlier",
      createdAt: "2026-07-27",
    };
    const snapshot = { ...legacy, tables: [...legacy.tables, earlier] };
    await old.table("memorySpaces").add(legacy.space);
    await old.table("memoryTables").bulkAdd(snapshot.tables);
    await old.table("memoryFields").bulkAdd(legacy.fields);
    old.close();
    const db = createTestDatabase(name);
    const local = (await new DexieMemoryBackupRepository(db).loadSnapshot()).spaces[0]!;
    expect(local.tables.find((table) => table.id === "z-earlier")!.position).toBe(0);
    expect(local.tables.find((table) => table.id === "table")!.position).toBe(1);
    const file = migrateMemorySpaceSnapshot({ version: "legacy-macros", snapshot });
    expect(file.tables.map((table) => table.position)).toEqual([0, 1]);
    const explicit = migrateMemorySpaceSnapshot({
      version: "legacy-macros",
      snapshot: {
        ...snapshot,
        tables: snapshot.tables.map((table) => ({ ...table, position: 9 })),
      },
    });
    expect(explicit.tables.map((table) => table.position)).toEqual([9, 9]);
  });

  it.each([undefined, 999])("当前数据库版本标记 %s 不会触发旧迁移", async (version) => {
    const db = createTestDatabase();
    const repo = new DexieMemoryBackupRepository(db);
    const current = migrateMemorySpaceSnapshot({
      version: "legacy-macros",
      snapshot: legacySnapshotFixture(),
    });
    await repo.restoreSpace(current);
    await db.memorySpaces.update(current.space.id, { snapshotSchemaVersion: version });
    await expect(repo.loadSnapshot()).rejects.toThrow("快照版本不支持");
    expect((await db.memorySpaces.get(current.space.id))!.snapshotSchemaVersion).toBe(version);
  });
});
