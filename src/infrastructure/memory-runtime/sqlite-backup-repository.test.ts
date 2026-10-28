import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../indexeddb/test-support.ts";
import { createInProcessSqliteMemoryClient } from "../sqlite/node-client.ts";
import { SqliteMemoryStore } from "./sqlite-memory-store.ts";
import { SqliteMemoryBackupRepository } from "./sqlite-backup-repository.ts";
import { DexieMemoryBackupRepository } from "../indexeddb/backup/memory-backup-repository.ts";
import { MemoryCommitPersistenceError } from "../../features/memory/index.ts";
import type { SqliteMemoryClient } from "../sqlite/types.ts";
import type { MemorySpaceBackup } from "../../features/backup/backup-file.ts";
import type { MemoryRecord, MemorySpaceId } from "../../features/memory/index.ts";

const stamp = "2026-10-24T00:00:00.000Z";
function fixture(): MemorySpaceBackup {
  return {
    space: {
      id: "space",
      name: "空间",
      initializationSource: null,
      createdAt: stamp,
      updatedAt: stamp,
    },
    tables: [
      {
        id: "characters",
        memorySpaceId: "space",
        key: "characters",
        name: "角色",
        description: "",
        prompt: "",
        enabled: true,
        position: 0,
        displayStrategy: { type: "field", fieldId: "name" },
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    fields: [
      {
        id: "name",
        memorySpaceId: "space",
        tableId: "characters",
        key: "name",
        name: "姓名",
        type: "short_text",
        required: true,
        prompt: "",
        enabled: true,
        position: 0,
        options: [],
        referenceTableId: null,
        maxChars: 20,
        valuePattern: null,
        valuePatternMessage: null,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    records: [],
    history: [],
    evidence: [],
  } as unknown as MemorySpaceBackup;
}
function row(id: string, name: string): MemoryRecord {
  return {
    id,
    memorySpaceId: "space",
    tableId: "characters",
    payload: { name },
    fieldEvidence: {},
    displayText: name,
    source: { type: "manual" },
    revisionId: `revision-${id}`,
    revisionSource: "user",
    createdAt: stamp,
    updatedAt: stamp,
  } as unknown as MemoryRecord;
}

describe("SqliteMemoryBackupRepository restores live SQLite and local snapshots", () => {
  let client: SqliteMemoryClient;
  let store: SqliteMemoryStore;
  let db: ReturnType<typeof createTestDatabase>;
  let backup: SqliteMemoryBackupRepository;
  let original: MemorySpaceBackup;
  beforeEach(async () => {
    client = await createInProcessSqliteMemoryClient();
    db = createTestDatabase();
    store = new SqliteMemoryStore(client, db);
    original = { ...fixture(), records: [row("old", "原内容")] };
    await store.replace(original);
    backup = new SqliteMemoryBackupRepository(db, store, createInProcessSqliteMemoryClient);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await client.close();
  });
  const replacement = (): MemorySpaceBackup => ({
    ...fixture(),
    records: [row("new", "恢复内容")],
  });

  it("restoreSpace replaces a loaded database before subsequent reads and saves the restored unit", async () => {
    const incoming = replacement();
    const saved = vi.fn(async () => {});
    store.onCommitted = saved;
    await backup.restoreSpace(incoming);
    expect(
      await store.repositories().records.list(incoming.space.id, incoming.tables[0]!.id),
    ).toEqual(incoming.records);
    expect(await db.memoryRecords.toArray()).toEqual(incoming.records);
    expect(saved).toHaveBeenCalledWith(incoming);
    await store.unload(incoming.space.id);
    expect((await store.snapshot(incoming.space.id))!.records).toEqual(incoming.records);
  });

  it("restoreSnapshot invalidates all loaded databases, including spaces absent from the new snapshot", async () => {
    const removedId = "obsolete" as MemorySpaceId;
    await store
      .repositories()
      .spaces.create({ ...original.space, id: removedId, name: "将删除的空间" });
    expect(await store.ensure(removedId)).toBe(true);
    const incoming = replacement();
    const saved = vi.fn(async () => {});
    store.onCommitted = saved;
    await backup.restoreSnapshot({ spaces: [incoming] });
    expect(await store.repositories().spaces.find(removedId)).toBeUndefined();
    expect(await store.ensure(removedId)).toBe(false);
    expect((await store.snapshot(incoming.space.id))!.records).toEqual(incoming.records);
    expect(await db.memoryRecords.toArray()).toEqual(incoming.records);
    expect(saved).toHaveBeenCalledWith(incoming);
  });

  it.each(["unload", "ensure", "onCommitted"] as const)(
    "marks a single-space restore committed when %s fails after replacing the local snapshot",
    async (stage) => {
      const incoming = replacement();
      const failure = new Error(`${stage} unavailable`);
      const restored = vi.spyOn(DexieMemoryBackupRepository.prototype, "restoreSpace");
      vi.spyOn(store, stage).mockRejectedValueOnce(failure);
      const operation = backup.restoreSpace(incoming);
      await expect(operation).rejects.toBeInstanceOf(MemoryCommitPersistenceError);
      await expect(operation).rejects.toHaveProperty("cause", failure);
      expect(await db.memoryRecords.toArray()).toEqual(incoming.records);
      expect(restored).toHaveBeenCalledOnce();
    },
  );

  it.each(["discardLoaded", "onCommitted"] as const)(
    "marks a full restore committed when %s fails after replacing all local data",
    async (stage) => {
      const incoming = replacement();
      const failure = new Error(`${stage} unavailable`);
      const restored = vi.spyOn(DexieMemoryBackupRepository.prototype, "restoreSnapshot");
      vi.spyOn(store, stage).mockRejectedValueOnce(failure);
      const operation = backup.restoreSnapshot({ spaces: [incoming] });
      await expect(operation).rejects.toBeInstanceOf(MemoryCommitPersistenceError);
      await expect(operation).rejects.toHaveProperty("cause", failure);
      expect(await db.memoryRecords.toArray()).toEqual(incoming.records);
      expect(restored).toHaveBeenCalledOnce();
    },
  );

  it("retains the original transaction error when replacing local data never commits", async () => {
    const before = await backup.loadSnapshot();
    const failure = new Error("transaction unavailable");
    vi.spyOn(DexieMemoryBackupRepository.prototype, "restoreSpace").mockRejectedValueOnce(failure);
    await expect(backup.restoreSpace(replacement())).rejects.toBe(failure);
    expect(await backup.loadSnapshot()).toEqual(before);
    expect((await store.snapshot(original.space.id))!.records).toEqual(original.records);
  });

  it("restoreSpace rejects SQLite constraint violations before changing local or live data", async () => {
    const before = await backup.loadSnapshot();
    const invalid = { ...replacement(), records: [row("invalid", "")] };
    await expect(backup.restoreSpace(invalid)).rejects.toThrow();
    expect(await backup.loadSnapshot()).toEqual(before);
    expect((await store.snapshot(original.space.id))!.records).toEqual(original.records);
  });

  it("restoreSnapshot validates every unit before replacing any local data", async () => {
    const before = await backup.loadSnapshot();
    const invalid = {
      ...replacement(),
      space: { ...fixture().space, id: "invalid-space" as MemorySpaceId },
      records: [row("invalid", "")],
    };
    await expect(backup.restoreSnapshot({ spaces: [replacement(), invalid] })).rejects.toThrow();
    expect(await backup.loadSnapshot()).toEqual(before);
    expect((await store.snapshot(original.space.id))!.records).toEqual(original.records);
  });

  it("restoring during an active task is rejected without changing its transaction or local snapshot", async () => {
    const before = await backup.loadSnapshot();
    const token = await store.begin(original.space.id);
    await store.repositories("write", token).records.create(row("task", "暂存角色"), []);
    await expect(backup.restoreSpace(replacement())).rejects.toThrow("正在填写或保存");
    await expect(backup.restoreSnapshot({ spaces: [replacement()] })).rejects.toThrow(
      "正在填写或保存",
    );
    expect(await backup.loadSnapshot()).toEqual(before);
    expect(
      await store
        .repositories("write", token)
        .records.list(original.space.id, original.tables[0]!.id),
    ).toHaveLength(2);
    await store.finish(original.space.id, token, false);
  });
});
