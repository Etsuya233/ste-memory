import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../indexeddb/test-support.ts";
import { createInProcessSqliteMemoryClient } from "../sqlite/node-client.ts";
import { SqliteMemoryStore, type SqliteRepositories } from "./sqlite-memory-store.ts";
import type { SqliteMemoryClient } from "../sqlite/types.ts";
import type { MemorySpaceBackup } from "../../features/backup/backup-file.ts";
import {
  MemoryRecordService,
  MemoryRecordSaveError,
  MemoryCommitPersistenceError,
  type MemoryRecord,
  type MemoryEvidenceId,
  type MemoryRecordId,
  type MemoryRecordHistoryId,
  type MemoryRevisionId,
} from "../../features/memory/index.ts";
import { VectorIndexChangeSync } from "../indexeddb/vector-index-change-sync.ts";
import type { VectorIndexService } from "../../features/vector-index/index.ts";

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

describe("SqliteMemoryStore with real SQLite and IndexedDB snapshots", () => {
  let client: SqliteMemoryClient;
  let store: SqliteMemoryStore;
  let db: ReturnType<typeof createTestDatabase>;
  let unit: MemorySpaceBackup;
  let sequence: number;
  const id = () => unit.space.id;
  const tableId = () => unit.tables[0]!.id;
  function writer(repositories: SqliteRepositories) {
    return new MemoryRecordService(
      repositories.tables,
      repositories.fields,
      repositories.records,
      () => `record-${++sequence}` as MemoryRecordId,
      () => `history-${++sequence}` as MemoryRecordHistoryId,
      () => `revision-${++sequence}` as MemoryRevisionId,
      () => stamp,
    );
  }
  beforeEach(async () => {
    client = await createInProcessSqliteMemoryClient();
    db = createTestDatabase();
    store = new SqliteMemoryStore(client, db);
    unit = fixture();
    sequence = 0;
    await store.replace(unit);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await client.close();
  });

  it("keeps the first batch committed when the next batch rolls back", async () => {
    const save = vi.fn(async () => {});
    store.onCommitted = save;
    const first = await store.begin(id());
    const created = (await writer(store.repositories("write", first)).create(id(), tableId(), {
      payload: { name: "第一批" },
    }))!;
    await store.finish(id(), first, true);
    expect(save).toHaveBeenCalledTimes(1);

    const next = await store.begin(id());
    const batch = writer(store.repositories("write", next));
    expect(
      await store.repositories("write", next).records.find(id(), tableId(), created.id),
    ).toEqual(created);
    await batch.update(id(), tableId(), created.id, {
      expectedRevisionId: created.revisionId,
      revisionSource: "agent",
      patch: { name: "未提交更新" },
    });
    await batch.create(id(), tableId(), { payload: { name: "未提交新增" } });
    expect(await store.repositories().records.list(id(), tableId())).toEqual([created]);
    await store.finish(id(), next, false);
    expect(await store.repositories().records.list(id(), tableId())).toEqual([created]);
    expect(await db.memoryRecords.toArray()).toEqual([created]);
    expect(save).toHaveBeenCalledTimes(1);
    const third = await store.begin(id());
    await store.finish(id(), third, false);
  });

  it("task create and update are visible only to the task connection until commit", async () => {
    const committed = store.repositories();
    const token = await store.begin(id());
    const task = store.repositories("write", token);
    const records = writer(task);
    const created = (await records.create(id(), tableId(), { payload: { name: "林" } }))!;
    expect(await task.records.find(id(), tableId(), created.id)).toEqual(created);
    expect(await committed.records.list(id(), tableId())).toEqual([]);
    expect(await db.memoryRecords.count()).toBe(0);
    const updated = (await records.update(id(), tableId(), created.id, {
      expectedRevisionId: created.revisionId,
      revisionSource: "agent",
      patch: { name: "林更新" },
    }))!;
    expect(updated.payload).toEqual({ name: "林更新" });
    expect(await committed.records.list(id(), tableId())).toEqual([]);
    const save = vi.fn(async (snapshot: MemorySpaceBackup) => {
      expect(snapshot.records[0]!.payload).toEqual({ name: "林更新" });
      expect(await committed.records.find(id(), tableId(), created.id)).toEqual(updated);
      await expect(store.begin(id())).rejects.toThrow("正在填写或保存");
    });
    store.onCommitted = save;
    await store.finish(id(), token, true);
    expect(save).toHaveBeenCalledOnce();
    expect(await db.memoryRecords.get(created.id)).toEqual(updated);
    expect(await committed.records.list(id(), tableId())).toEqual([updated]);
  });

  it("rollback discards all task records, history and evidence without changing the local snapshot", async () => {
    const original = row("original", "原角色");
    await store.repositories().records.create(original, []);
    const before = await store.snapshot(id());
    const token = await store.begin(id());
    const task = store.repositories("write", token);
    const records = writer(task);
    await records.update(id(), tableId(), original.id, {
      expectedRevisionId: original.revisionId,
      revisionSource: "agent",
      patch: { name: "暂存修改" },
    });
    await records.create(id(), tableId(), { payload: { name: "新角色" } });
    await task.records.create(row("evidenced", "带证据角色"), [
      {
        evidence_id: "new-evidence" as MemoryEvidenceId,
        source_type: "sync_floor",
        source_id: 2,
        storage_mode: "reference",
        extraProps: {},
      },
    ]);
    expect(await task.records.list(id(), tableId())).toHaveLength(3);
    expect(await task.records.listHistory({ memorySpaceId: id() })).toHaveLength(1);
    await store.finish(id(), token, false);
    expect(await store.snapshot(id())).toEqual(before);
    expect(await store.repositories().records.list(id(), tableId())).toEqual([original]);
    expect(await db.memoryRecords.toArray()).toEqual([original]);
    expect(await db.memoryRecordHistory.count()).toBe(0);
    expect(await db.memoryEvidence.count()).toBe(0);
  });

  it("one failed tool savepoint rolls back its writes while the task can continue", async () => {
    const token = await store.begin(id());
    const task = store.repositories("write", token);
    await task.records.create(row("first", "第一步"), []);
    await expect(
      store.write(
        id(),
        async () => {
          await client.putEntity(id(), "record", row("invalid-step", "未完成"));
          throw new Error("当前工具失败");
        },
        token,
      ),
    ).rejects.toThrow("当前工具失败");
    expect(await task.records.find(id(), tableId(), row("invalid-step", "").id)).toBeUndefined();
    expect(await task.records.list(id(), tableId())).toHaveLength(1);
    await task.records.create(row("last", "修正成功"), []);
    await store.finish(id(), token, true);
    expect(
      (await store.repositories().records.list(id(), tableId())).map((record) => record.id).sort(),
    ).toEqual(["first", "last"]);
  });

  it("database constraint failure rolls back new evidence and permits the next tool call", async () => {
    const token = await store.begin(id());
    const task = store.repositories("write", token);
    const evidence = {
      evidence_id: "evidence" as MemoryEvidenceId,
      source_type: "sync_floor",
      source_id: 1,
      storage_mode: "reference" as const,
      extraProps: {},
    };
    await expect(task.records.create(row("invalid", ""), [evidence])).rejects.toThrow();
    expect(await task.records.findEvidence(id(), "sync_floor", 1)).toBeUndefined();
    expect(await task.records.list(id(), tableId())).toEqual([]);
    await task.records.create(row("valid", "有效角色"), [evidence]);
    await store.finish(id(), token, true);
    expect(await store.repositories().records.findEvidence(id(), "sync_floor", 1)).toEqual(
      evidence,
    );
    expect(await db.memoryEvidence.count()).toBe(1);
    expect(await db.memoryRecords.count()).toBe(1);
  });

  it("save callback failure preserves committed data and releases the writer", async () => {
    const token = await store.begin(id());
    await store.repositories("write", token).records.create(row("saved", "已提交"), []);
    store.onCommitted = async () => {
      throw new Error("聊天文件保存失败");
    };
    await expect(store.finish(id(), token, true)).rejects.toThrow("聊天文件保存失败");
    expect((await store.snapshot(id()))!.records).toEqual([row("saved", "已提交")]);
    expect(await db.memoryRecords.count()).toBe(1);
    store.onCommitted = async () => {};
    await store.repositories().records.create(row("next", "下一次"), []);
    expect(await store.repositories().records.list(id(), tableId())).toHaveLength(2);
  });

  it("ordinary short writes preserve committed state when saving fails", async () => {
    store.onCommitted = async () => {
      throw new Error("保存失败");
    };
    await expect(store.repositories().records.create(row("saved", "已提交"), [])).rejects.toThrow(
      "保存失败",
    );
    expect(await store.repositories().records.list(id(), tableId())).toEqual([
      row("saved", "已提交"),
    ]);
    const next = await store.begin(id());
    await store.finish(id(), next, false);
  });

  it("retries snapshot persistence without replaying a committed record write", async () => {
    store.onCommitted = async () => {
      throw new Error("文件写回失败");
    };
    await expect(
      writer(store.repositories()).create(id(), tableId(), { payload: { name: "只创建一次" } }),
    ).rejects.toThrow("文件写回失败");
    const before = (await store.snapshot(id()))!;
    const persist = vi.fn(async () => {});
    store.onCommitted = persist;
    await store.write(id(), async () => undefined);
    const after = (await store.snapshot(id()))!;
    expect(after.records).toEqual(before.records);
    expect(after.history).toEqual(before.history);
    expect(after.records).toHaveLength(1);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(after);
  });

  it("record creation exposes its exact committed record when file persistence fails", async () => {
    const records = writer(store.repositories());
    const failure = new Error("对话文件不可写");
    store.onCommitted = async () => {
      throw failure;
    };
    let caught: unknown;
    try {
      await records.create(id(), tableId(), { payload: { name: "已创建" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MemoryRecordSaveError);
    const saved = caught as MemoryRecordSaveError;
    expect(saved.message).toBe(failure.message);
    expect(saved.cause).toBeInstanceOf(MemoryCommitPersistenceError);
    expect((saved.cause as Error).cause).toBe(failure);
    expect((await store.snapshot(id()))!.records).toEqual([saved.record]);
    expect(saved.record.payload).toEqual({ name: "已创建" });
    // Retrying persistence uses the committed snapshot and creates no second record.
    store.onCommitted = async () => {};
    await store.onCommitted((await store.snapshot(id()))!);
    expect(await store.repositories().records.list(id(), tableId())).toHaveLength(1);
  });

  it("record update carries its committed revision without reading after writer release", async () => {
    const repositories = store.repositories();
    const records = writer(repositories);
    const original = (await records.create(id(), tableId(), { payload: { name: "修改前" } }))!;
    const find = vi.spyOn(repositories.records, "find");
    store.onCommitted = async () => {
      // The host may unload this chat immediately after the writer is released.
      find.mockRejectedValue(new Error("原对话已卸载，禁止回查"));
      throw new Error("对话文件写回失败");
    };
    let caught: unknown;
    try {
      await records.update(id(), tableId(), original.id, {
        expectedRevisionId: original.revisionId,
        revisionSource: "user",
        patch: { name: "修改后" },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MemoryRecordSaveError);
    const saved = caught as MemoryRecordSaveError;
    expect(saved.message).toBe("对话文件写回失败");
    expect(saved.record.id).toBe(original.id);
    expect(saved.record.revisionId).not.toBe(original.revisionId);
    expect(saved.record.payload).toEqual({ name: "修改后" });
    const snapshot = (await store.snapshot(id()))!;
    expect(snapshot.records).toEqual([saved.record]);
    expect(snapshot.history).toHaveLength(1);
    await store.unload(id());
    expect(saved.record.payload).toEqual({ name: "修改后" });
  });

  it("a rejected optimistic lock stays a conflict when saving the unchanged snapshot fails", async () => {
    const repositories = store.repositories();
    const records = writer(repositories);
    const original = (await records.create(id(), tableId(), { payload: { name: "原值" } }))!;
    const commit = repositories.records.commit.bind(repositories.records);
    vi.spyOn(repositories.records, "commit").mockImplementation((mutations, evidence) =>
      commit(
        mutations.map((mutation) =>
          mutation.kind === "replace"
            ? {
                ...mutation,
                previous: { ...mutation.previous, revisionId: "stale" as MemoryRevisionId },
              }
            : mutation,
        ),
        evidence,
      ),
    );
    store.onCommitted = async () => {
      throw new Error("对话文件写回失败");
    };
    await expect(
      records.update(id(), tableId(), original.id, {
        expectedRevisionId: original.revisionId,
        revisionSource: "user",
        patch: { name: "未写入" },
      }),
    ).rejects.toMatchObject({ type: "memory_record_revision_conflict" });
    const snapshot = (await store.snapshot(id()))!;
    expect(snapshot.records).toEqual([original]);
    expect(snapshot.history).toHaveLength(0);
  });

  it("active task excludes ordinary writes, competing tasks, source replacement and unload", async () => {
    const token = await store.begin(id());
    await expect(
      store.repositories().records.create(row("outside", "外部修改"), []),
    ).rejects.toThrow("正在填写或保存");
    await expect(store.begin(id())).rejects.toThrow("正在填写或保存");
    await expect(store.replace(unit)).rejects.toThrow("正在填写或保存");
    await expect(store.unload(id())).rejects.toThrow("正在填写或保存");
    await expect(
      store.repositories("write", Symbol("wrong")).records.create(row("wrong", "错误令牌"), []),
    ).rejects.toThrow("会话已结束");
    await store.repositories("write", token).records.create(row("task", "任务修改"), []);
    await store.finish(id(), token, false);
    await store.repositories().records.create(row("ordinary", "普通修改"), []);
    expect(await store.repositories().records.list(id(), tableId())).toEqual([
      row("ordinary", "普通修改"),
    ]);
  });

  it("finished task repositories reject late writes even after the space becomes idle", async () => {
    const token = await store.begin(id());
    const stale = store.repositories("write", token);
    await stale.records.create(row("discarded", "已取消"), []);
    await store.finish(id(), token, false);
    await expect(stale.records.create(row("late", "迟到结果"), [])).rejects.toThrow("会话已结束");
    expect(await store.repositories().records.list(id(), tableId())).toEqual([]);
    const next = await store.begin(id());
    await expect(stale.records.create(row("late-again", "迟到结果"), [])).rejects.toThrow(
      "会话已结束",
    );
    await store.finish(id(), next, false);
  });

  it("snapshot cache preserves vectors and avoids delete hooks for surviving records", async () => {
    const original = row("original", "原角色");
    await store.repositories().records.create(original, []);
    const vector = {
      id: "vector",
      memorySpaceId: id(),
      tableId: tableId(),
      recordId: original.id,
      groupId: "group",
      fingerprint: "fingerprint",
      values: [1, 0],
      model: "test",
      version: "1",
      updatedAt: stamp,
    };
    await db.recordVectors.add(vector);
    const purge = vi.fn(async () => {});
    const sync = new VectorIndexChangeSync(
      db,
      { purge } as unknown as VectorIndexService,
      () => false,
      (error) => {
        throw error;
      },
    );
    sync.start();
    await store.cache((await store.snapshot(id()))!);
    await sync.flush();
    expect(purge).not.toHaveBeenCalled();
    const token = await store.begin(id());
    await writer(store.repositories("write", token)).update(id(), tableId(), original.id, {
      expectedRevisionId: original.revisionId,
      revisionSource: "agent",
      patch: { name: "更新角色" },
    });
    await store.finish(id(), token, true);
    await sync.flush();
    expect(purge).not.toHaveBeenCalled();
    expect(await db.recordVectors.get(vector.id)).toEqual(vector);
    expect((await db.memoryRecords.get(original.id))!.payload).toEqual({ name: "更新角色" });
  });

  it("task revisions collapse repeated updates to one baseline history and preserve prior archives", async () => {
    const original = row("original", "最初版本");
    await store.repositories().records.create(original, []);
    const ordinary = writer(store.repositories());
    const baselineRecord = (await ordinary.update(id(), tableId(), original.id, {
      expectedRevisionId: original.revisionId,
      revisionSource: "user",
      patch: { name: "任务开始版本" },
    }))!;
    const token = await store.begin(id());
    const baseline = await client.exportSpace(id(), "write");
    const task = store.repositories("write", token);
    const records = writer(task);
    const first = (await records.update(id(), tableId(), original.id, {
      expectedRevisionId: baselineRecord.revisionId,
      revisionSource: "agent",
      patch: { name: "中间版本" },
    }))!;
    await records.update(id(), tableId(), original.id, {
      expectedRevisionId: first.revisionId,
      revisionSource: "agent",
      patch: { name: "最终版本" },
    });
    const finalRevision = "task-revision" as MemoryRevisionId;
    const archivedAt = "2026-10-24T01:00:00.000Z";
    await store.consolidateTask(baseline, token, finalRevision, archivedAt);
    await store.finish(id(), token, true);
    const snapshot = (await store.snapshot(id()))!;
    expect(snapshot.history).toHaveLength(baseline.history.length + 1);
    expect(snapshot.history).toEqual(expect.arrayContaining([...baseline.history]));
    const taskHistory = snapshot.history.find((history) => history.revisionId === finalRevision)!;
    expect(taskHistory).toMatchObject({
      payload: baselineRecord.payload,
      fieldEvidence: baselineRecord.fieldEvidence,
      previousRevisionId: baselineRecord.revisionId,
      previousRevisionSource: "user",
      revisionSource: "agent",
      archivedAt,
    });
    expect(snapshot.records[0]).toMatchObject({
      payload: { name: "最终版本" },
      revisionId: finalRevision,
      revisionSource: "agent",
    });
  });

  it("new records updated repeatedly retain final task revision without intermediate history", async () => {
    const token = await store.begin(id());
    const baseline = await client.exportSpace(id(), "write");
    const task = store.repositories("write", token);
    const records = writer(task);
    const created = (await records.create(id(), tableId(), { payload: { name: "新建" } }))!;
    const updated = (await records.update(id(), tableId(), created.id, {
      expectedRevisionId: created.revisionId,
      revisionSource: "agent",
      patch: { name: "新建后修改" },
    }))!;
    await records.update(id(), tableId(), created.id, {
      expectedRevisionId: updated.revisionId,
      revisionSource: "agent",
      patch: { name: "最终状态" },
    });
    await store.consolidateTask(baseline, token, "task-new" as MemoryRevisionId, stamp);
    await store.finish(id(), token, true);
    const snapshot = (await store.snapshot(id()))!;
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({
      id: created.id,
      payload: { name: "最终状态" },
      revisionId: "task-new",
    });
    expect(snapshot.history).toEqual([]);
  });

  it("new records deleted in the task leave no records, history or orphan evidence while baseline evidence survives", async () => {
    const preserved = {
      evidence_id: "baseline-evidence" as MemoryEvidenceId,
      source_type: "sync_floor",
      source_id: 10,
      storage_mode: "reference" as const,
      extraProps: {},
    };
    await store.repositories().records.create(row("baseline", "旧角色"), [preserved]);
    const token = await store.begin(id());
    const baseline = await client.exportSpace(id(), "write");
    const task = store.repositories("write", token);
    const transientEvidence = {
      evidence_id: "transient-evidence" as MemoryEvidenceId,
      source_type: "sync_floor",
      source_id: 20,
      storage_mode: "reference" as const,
      extraProps: {},
    };
    const transient = {
      ...row("temporary", "临时角色"),
      fieldEvidence: { name: [transientEvidence] },
    };
    await task.records.create(transient, [transientEvidence]);
    const records = writer(task);
    const updated = (await records.update(id(), tableId(), transient.id, {
      expectedRevisionId: transient.revisionId,
      revisionSource: "agent",
      patch: { name: "临时修改" },
    }))!;
    await records.delete(id(), tableId(), transient.id, updated.revisionId, "agent");
    await store.consolidateTask(baseline, token, "task-delete-new" as MemoryRevisionId, stamp);
    await store.finish(id(), token, true);
    const snapshot = (await store.snapshot(id()))!;
    expect(snapshot.records).toEqual(baseline.records);
    expect(snapshot.history).toEqual(baseline.history);
    expect(snapshot.evidence).toEqual([preserved]);
  });

  it("updating an existing record back to its original value preserves original revision and timestamps", async () => {
    const original = row("original", "原值");
    await store.repositories().records.create(original, []);
    const token = await store.begin(id());
    const baseline = await client.exportSpace(id(), "write");
    const task = store.repositories("write", token);
    const records = writer(task);
    const first = (await records.update(id(), tableId(), original.id, {
      expectedRevisionId: original.revisionId,
      revisionSource: "agent",
      patch: { name: "暂存修改" },
    }))!;
    await records.update(id(), tableId(), original.id, {
      expectedRevisionId: first.revisionId,
      revisionSource: "agent",
      patch: { name: "原值" },
    });
    await store.consolidateTask(baseline, token, "unused-task-revision" as MemoryRevisionId, stamp);
    await store.finish(id(), token, true);
    const snapshot = (await store.snapshot(id()))!;
    expect(snapshot.records).toEqual([original]);
    expect(snapshot.history).toEqual([]);
  });

  it("whenIdle waits for a gated save callback before allowing session teardown", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered!: () => void;
    const saving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    store.onCommitted = async () => {
      entered();
      await gate;
    };
    const pendingWrite = store.repositories().records.create(row("saved", "已提交"), []);
    await saving;
    let idleCompleted = false;
    const idle = store.whenIdle(id()).then(() => {
      idleCompleted = true;
    });
    await Promise.resolve();
    expect(idleCompleted).toBe(false);
    expect(await store.repositories().records.list(id(), tableId())).toEqual([
      row("saved", "已提交"),
    ]);
    open();
    await pendingWrite;
    await idle;
    expect(idleCompleted).toBe(true);
    await store.unload(id());
  });

  it("persists macro writes in the committed snapshot and replaces macros with structure", async () => {
    const macros = [
      {
        id: "m1",
        name: "人物",
        enabled: true,
        expression: { language: "query" as const, query: { table: "characters" } },
        output: { format: "text" as const, maxChars: null },
      },
    ];
    const committed = vi.fn(async () => {});
    store.onCommitted = committed;
    await store.repositories().spaces.setMacros(id(), macros, stamp);
    expect((await store.snapshot(id()))!.space.macros).toEqual(macros);
    expect((await db.memorySpaces.get(id()))!.macros).toEqual(macros);
    expect(committed).toHaveBeenCalledWith(
      expect.objectContaining({ space: expect.objectContaining({ macros }) }),
    );
    await store.repositories().spaces.clearRecords(id());
    expect((await store.snapshot(id()))!.space.macros).toEqual(macros);
    await store.structureRebuild().rebuild({
      memorySpaceId: id(),
      tables: unit.tables,
      fields: unit.fields,
      macros: [],
      initializationSource: { presetId: "preset", presetName: "预设", appliedAt: stamp },
    });
    expect((await store.snapshot(id()))!.space.macros).toEqual([]);
  });

  it("structure rebuild retains the exclusive writer through its save callback", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered!: () => void;
    const saving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    store.onCommitted = async () => {
      entered();
      await gate;
    };
    const rebuild = store.structureRebuild().rebuild({
      memorySpaceId: id(),
      tables: unit.tables,
      fields: unit.fields,
      initializationSource: { presetId: "preset", presetName: "测试预设", appliedAt: stamp },
    });
    await saving;
    await expect(store.begin(id())).rejects.toThrow("正在填写或保存");
    await expect(
      store.repositories().records.create(row("concurrent", "并发修改"), []),
    ).rejects.toThrow("正在填写或保存");
    open();
    expect(await rebuild).toBe(true);
    const token = await store.begin(id());
    await store.finish(id(), token, false);
  });

  it.each(["cache", "cleanup", "onCommitted"] as const)(
    "reports the committed rebuild without replaying it when %s fails",
    async (stage) => {
      await store.repositories().records.create(row("old", "重建前的记录"), []);
      const failure = new Error(`${stage} unavailable`);
      const imported = vi.spyOn(client, "importSpace");
      if (stage === "cache") vi.spyOn(store, "cache").mockRejectedValueOnce(failure);
      else if (stage === "onCommitted")
        vi.spyOn(store, "onCommitted").mockRejectedValueOnce(failure);
      else
        vi.spyOn(db.memoryFillTasks, "where").mockImplementationOnce(() => {
          throw failure;
        });
      const operation = store.structureRebuild().rebuild({
        memorySpaceId: id(),
        tables: unit.tables,
        fields: unit.fields,
        initializationSource: { presetId: "replacement", presetName: "新预设", appliedAt: stamp },
      });
      await expect(operation).rejects.toBeInstanceOf(MemoryCommitPersistenceError);
      await expect(operation).rejects.toHaveProperty("cause", failure);
      const snapshot = (await store.snapshot(id()))!;
      expect(snapshot.records).toEqual([]);
      expect(snapshot.space.initializationSource?.presetId).toBe("replacement");
      expect(imported).toHaveBeenCalledOnce();
      if (stage !== "cache") expect(await db.memoryRecords.toArray()).toEqual([]);
      const token = await store.begin(id());
      await store.finish(id(), token, false);
    },
  );

  it("retains an import transaction error when structure replacement does not commit", async () => {
    await store.repositories().records.create(row("old", "保留记录"), []);
    const before = await store.snapshot(id());
    const failure = new Error("invalid replacement");
    vi.spyOn(client, "importSpace").mockRejectedValueOnce(failure);
    await expect(
      store.structureRebuild().rebuild({
        memorySpaceId: id(),
        tables: unit.tables,
        fields: unit.fields,
        initializationSource: { presetId: "replacement", presetName: "新预设", appliedAt: stamp },
      }),
    ).rejects.toBe(failure);
    expect(await store.snapshot(id())).toEqual(before);
  });

  it("unload and reinitialization load the latest complete local snapshot", async () => {
    await store.repositories().records.create(row("saved", "已保存"), []);
    await store.unload(id());
    expect(await store.ensure(id())).toBe(true);
    expect(await store.repositories().records.list(id(), tableId())).toEqual([
      row("saved", "已保存"),
    ]);
  });
});
