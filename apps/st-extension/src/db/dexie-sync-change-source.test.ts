import type {
  MemoryEvidenceId,
  MemoryFieldId,
  MemoryFieldKey,
  MemoryRecordId,
  MemoryRevisionId,
  MemorySpaceId,
  MemoryTableId,
  MemoryTableKey,
} from "@ste-memory/core/memory";
import { describe, expect, it } from "vitest";
import { DexieSyncChangeSource } from "./dexie-sync-change-source.ts";
import { createTestDatabase } from "./test-support.ts";

/**
 * 云同步变更来源（Dexie 实现）测试：指纹 = 行数 + 最大 updatedAt，
 * 任何增删改（含记录提交）都反映到指纹；多空间互不污染。
 */

const NOW = "2026-07-28T00:00:00.000Z";

function insertSpace(db: ReturnType<typeof createTestDatabase>, spaceId: string): void {
  void db.memorySpaces.add({
    id: spaceId as MemorySpaceId,
    name: `空间-${spaceId}`,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe("DexieSyncChangeSource（空间指纹）", () => {
  it("初始空间：各表行数 0，updatedAt = 空间更新时间", async () => {
    const db = createTestDatabase();
    insertSpace(db, "space-1");
    const source = new DexieSyncChangeSource(db);

    expect(await source.listSpaceIds()).toEqual(["space-1"]);
    expect(await source.fingerprint("space-1")).toEqual({
      tables: 0,
      fields: 0,
      records: 0,
      history: 0,
      evidence: 0,
      updatedAt: NOW,
    });
  });

  it("表格/字段/记录/证据写入后：行数与最大 updatedAt 同步变化", async () => {
    const db = createTestDatabase();
    insertSpace(db, "space-1");
    const source = new DexieSyncChangeSource(db);

    await db.memoryTables.add({
      id: "table-1" as MemoryTableId,
      memorySpaceId: "space-1" as MemorySpaceId,
      key: "characters" as MemoryTableKey,
      kind: "system",
      name: "人物",
      description: "",
      prompt: "",
      enabled: true,
      displayStrategy: null,
      createdAt: NOW,
      updatedAt: "2026-07-28T01:00:00.000Z",
    });
    await db.memoryFields.add({
      id: "field-1" as MemoryFieldId,
      memorySpaceId: "space-1" as MemorySpaceId,
      tableId: "table-1" as MemoryTableId,
      key: "name" as MemoryFieldKey,
      name: "名称",
      type: "short_text",
      required: false,
      prompt: "",
      enabled: true,
      position: 0,
      options: [],
      referenceTableId: null,
      maxChars: null,
      valuePattern: null,
      valuePatternMessage: null,
      createdAt: NOW,
      updatedAt: "2026-07-28T02:00:00.000Z",
    });
    await db.memoryRecords.add({
      id: "record-1" as MemoryRecordId,
      memorySpaceId: "space-1" as MemorySpaceId,
      tableId: "table-1" as MemoryTableId,
      payload: { "field-1": "林夏" },
      fieldEvidence: {},
      displayText: "林夏",
      source: { type: "manual" },
      revisionId: "revision-1" as MemoryRevisionId,
      revisionSource: "user",
      createdAt: NOW,
      updatedAt: "2026-07-28T03:00:00.000Z",
    });
    await db.memoryEvidence.add({
      id: "evidence-1" as MemoryEvidenceId,
      memorySpaceId: "space-1" as MemorySpaceId,
      source_type: "message",
      source_id: 1,
      storage_mode: "snapshot",
      content: "「你好」",
      extraProps: {},
    });

    expect(await source.fingerprint("space-1")).toEqual({
      tables: 1,
      fields: 1,
      records: 1,
      history: 0,
      evidence: 1,
      updatedAt: "2026-07-28T03:00:00.000Z",
    });
  });

  it("记录删除：行数回落（删除也被指纹捕获）", async () => {
    const db = createTestDatabase();
    insertSpace(db, "space-1");
    await db.memoryRecords.add({
      id: "record-1" as MemoryRecordId,
      memorySpaceId: "space-1" as MemorySpaceId,
      tableId: "table-1" as MemoryTableId,
      payload: {},
      fieldEvidence: {},
      displayText: "x",
      source: { type: "manual" },
      revisionId: "revision-1" as MemoryRevisionId,
      revisionSource: "user",
      createdAt: NOW,
      updatedAt: "2026-07-28T01:00:00.000Z",
    });
    const source = new DexieSyncChangeSource(db);
    expect((await source.fingerprint("space-1")).records).toBe(1);

    await db.memoryRecords.delete("record-1" as MemoryRecordId);
    expect((await source.fingerprint("space-1")).records).toBe(0);
  });

  it("多空间互不污染（行数与时间各自独立）", async () => {
    const db = createTestDatabase();
    insertSpace(db, "space-1");
    insertSpace(db, "space-2");
    await db.memoryTables.add({
      id: "table-1" as MemoryTableId,
      memorySpaceId: "space-2" as MemorySpaceId,
      key: "characters" as MemoryTableKey,
      kind: "system",
      name: "人物",
      description: "",
      prompt: "",
      enabled: true,
      displayStrategy: null,
      createdAt: NOW,
      updatedAt: "2026-07-28T05:00:00.000Z",
    });
    const source = new DexieSyncChangeSource(db);

    expect(await source.listSpaceIds()).toEqual(["space-1", "space-2"]);
    expect((await source.fingerprint("space-1")).tables).toBe(0);
    expect((await source.fingerprint("space-2")).tables).toBe(1);
    expect((await source.fingerprint("space-1")).updatedAt).toBe(NOW);
    expect((await source.fingerprint("space-2")).updatedAt).toBe("2026-07-28T05:00:00.000Z");
  });
});
