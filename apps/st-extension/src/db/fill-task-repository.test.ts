import { describe, expect, it } from "vitest";
import type { MemoryRecord, MemoryRecordId, MemoryTableId } from "@ste-memory/core/memory";
// fake-indexeddb 必须先于 dexie 模块求值（test-support 第一行 import "fake-indexeddb/auto"）
import { createTestDatabase } from "./test-support.ts";
import { Dexie } from "dexie";
import { DexieFillTaskRepository, DexieFloorLedgerRepository } from "./fill-task-repository.ts";
import { DexieMemorySpaceRepository } from "./memory-space-repository.ts";
import { SteMemoryDatabase } from "./database.ts";
import { isFillTaskTerminal, type FillTask, type FillTaskStatus } from "../fill-tasks/fill-task.ts";
import type { MemorySpaceId } from "@ste-memory/core/memory";

const SPACE_A = "space-a" as MemorySpaceId;
const SPACE_B = "space-b" as MemorySpaceId;
const NOW = "2026-07-28T00:00:00.000Z";

/** ticket 13 之前的 v2 schema，用于验证 v2 → v3 升级路径（新增任务表与楼层台账表）。 */
class SteMemoryDatabaseV2 extends Dexie {
  memorySpaces!: SteMemoryDatabase["memorySpaces"];
  memoryRecords!: SteMemoryDatabase["memoryRecords"];

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      memorySpaces: "id",
      memoryTables: "id, &[memorySpaceId+key], memorySpaceId",
      memoryFields: "id, &[memorySpaceId+tableId+key], [memorySpaceId+tableId]",
    });
    this.version(2).stores({
      memoryRecords: "id, [memorySpaceId+tableId], memorySpaceId",
      memoryRecordHistory:
        "id, [memorySpaceId+tableId+recordId], [memorySpaceId+recordId], memorySpaceId",
      memoryEvidence: "id, &[memorySpaceId+source_type+source_id], memorySpaceId",
    });
  }
}

function task(overrides: Partial<FillTask> = {}): FillTask {
  return {
    runId: "run-1",
    memorySpaceId: SPACE_A,
    from: 0,
    to: 9,
    blockSize: 20,
    kind: "floor",
    initText: null,
    chatId: null,
    status: "running",
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    // 测试数据构造：overrides 可覆盖 kind/initText（联合成员由调用方保证一致）
    ...overrides,
  } as FillTask;
}

describe("DexieFloorLedgerRepository（楼层进度台账，ticket 13）", () => {
  it("markProcessed 写入行；statuses 范围内补 untracked 并升序", async () => {
    const db = createTestDatabase();
    const ledger = new DexieFloorLedgerRepository(db);

    await ledger.markProcessed(SPACE_A, [1, 3]);

    expect(await ledger.statuses(SPACE_A, 0, 4)).toEqual([
      { floor: 0, status: "untracked" },
      { floor: 1, status: "processed" },
      { floor: 2, status: "untracked" },
      { floor: 3, status: "processed" },
      { floor: 4, status: "untracked" },
    ]);
    expect(await ledger.processedCount(SPACE_A, 0, 4)).toBe(2);
    // 范围外不计入
    expect(await ledger.processedCount(SPACE_A, 3, 4)).toBe(1);
  });

  it("markError 写入；error 被后续 markProcessed 覆盖（可重试语义）", async () => {
    const db = createTestDatabase();
    const ledger = new DexieFloorLedgerRepository(db);

    await ledger.markError(SPACE_A, [2, 5]);
    expect(await ledger.statuses(SPACE_A, 2, 5)).toEqual([
      { floor: 2, status: "error" },
      { floor: 3, status: "untracked" },
      { floor: 4, status: "untracked" },
      { floor: 5, status: "error" },
    ]);

    // 重跑成功：error → processed（同一行 upsert，不产生重复行）
    await ledger.markProcessed(SPACE_A, [2, 3]);
    const rows = await db.floorFillLedger.toArray();
    expect(rows.filter((row) => row.floor === 2)).toHaveLength(1);
    expect(await ledger.statuses(SPACE_A, 2, 5)).toEqual([
      { floor: 2, status: "processed" },
      { floor: 3, status: "processed" },
      { floor: 4, status: "untracked" },
      { floor: 5, status: "error" },
    ]);
    expect(await ledger.processedCount(SPACE_A, 0, 9)).toBe(2);
  });

  it("台账按记忆空间隔离：不同空间同楼层互不影响", async () => {
    const db = createTestDatabase();
    const ledger = new DexieFloorLedgerRepository(db);

    await ledger.markProcessed(SPACE_A, [0]);
    await ledger.markError(SPACE_B, [0]);

    expect(await ledger.statuses(SPACE_A, 0, 0)).toEqual([{ floor: 0, status: "processed" }]);
    expect(await ledger.statuses(SPACE_B, 0, 0)).toEqual([{ floor: 0, status: "error" }]);
  });
});

describe("DexieFillTaskRepository（任务行与状态机，ticket 13）", () => {
  it("create/find/findActive：running 占用活动名额，终态后释放", async () => {
    const db = createTestDatabase();
    const tasks = new DexieFillTaskRepository(db, () => NOW);

    await tasks.create(task());
    expect(await tasks.find("run-1")).toMatchObject({ status: "running" });
    expect(await tasks.findActive(SPACE_A)).toMatchObject({ runId: "run-1" });
    expect(await tasks.findActive(SPACE_B)).toBeUndefined();

    await tasks.markSucceeded("run-1");
    expect(await tasks.findActive(SPACE_A)).toBeUndefined();
    expect(isFillTaskTerminal("succeeded")).toBe(true);
  });

  it("终态转换带守卫：markSucceeded/markFailed/markInterrupted 仅 running 生效，否则返回 false", async () => {
    const db = createTestDatabase();
    const tasks = new DexieFillTaskRepository(db, () => NOW);

    await tasks.create(task());
    expect(await tasks.markInterrupted("run-1")).toBe(true);
    // 已中断（终态）：其余终态标记全部拒绝，行保持 interrupted
    expect(await tasks.markSucceeded("run-1")).toBe(false);
    expect(await tasks.markFailed("run-1", "失败")).toBe(false);
    expect(await tasks.markInterrupted("run-1")).toBe(false);
    expect(await tasks.find("run-1")).toMatchObject({ status: "interrupted" });

    // 已 succeeded 的任务同样拒绝其他终态标记
    await tasks.create(task({ runId: "run-2" }));
    expect(await tasks.markSucceeded("run-2")).toBe(true);
    expect(await tasks.markFailed("run-2", "失败")).toBe(false);
    expect(await tasks.find("run-2")).toMatchObject({ status: "succeeded" });

    // 不存在的任务返回 false
    expect(await tasks.markSucceeded("run-missing")).toBe(false);
  });

  it("markFailed 携带可读错误信息并刷新 updatedAt", async () => {
    const db = createTestDatabase();
    const tasks = new DexieFillTaskRepository(db, () => "2026-07-28T01:00:00.000Z");

    await tasks.create(task());
    expect(await tasks.markFailed("run-1", "消息块 [0, 19] 内没有可处理的消息")).toBe(true);
    expect(await tasks.find("run-1")).toMatchObject({
      status: "failed",
      errorMessage: "消息块 [0, 19] 内没有可处理的消息",
      updatedAt: "2026-07-28T01:00:00.000Z",
    });
  });

  it("createIfIdle：空间内已有活动任务时拒绝创建并返回该任务（并发提交守卫）", async () => {
    const db = createTestDatabase();
    const tasks = new DexieFillTaskRepository(db, () => NOW);

    await tasks.create(task());
    // 已有 running 任务：拒绝创建，返回冲突任务；新任务不落库
    const conflict = await tasks.createIfIdle(SPACE_A, task({ runId: "run-2" }));
    expect(conflict).toMatchObject({ runId: "run-1" });
    expect(await tasks.find("run-2")).toBeUndefined();
    // 其他空间不受影响
    expect(
      await tasks.createIfIdle(SPACE_B, task({ runId: "run-b", memorySpaceId: SPACE_B })),
    ).toBeUndefined();

    // 终态后活动名额释放：允许创建
    await tasks.markSucceeded("run-1");
    expect(await tasks.createIfIdle(SPACE_A, task({ runId: "run-3" }))).toBeUndefined();
    expect(await tasks.find("run-3")).toMatchObject({ status: "running" });
  });

  it("markInterruptedOnStartup：非终态全部置 interrupted，终态保持原样，不自动重放", async () => {
    const db = createTestDatabase();
    const tasks = new DexieFillTaskRepository(db, () => NOW);

    await tasks.create(task({ runId: "run-running" }));
    await tasks.create(task({ runId: "run-succeeded", status: "succeeded" }));
    await tasks.create(task({ runId: "run-failed", status: "failed", errorMessage: "旧失败" }));
    await tasks.create(task({ runId: "run-interrupted", status: "interrupted" }));

    await tasks.markInterruptedOnStartup();

    expect(await tasks.find("run-running")).toMatchObject({ status: "interrupted" });
    expect(await tasks.find("run-succeeded")).toMatchObject({ status: "succeeded" });
    expect(await tasks.find("run-failed")).toMatchObject({
      status: "failed",
      errorMessage: "旧失败",
    });
    expect(await tasks.find("run-interrupted")).toMatchObject({ status: "interrupted" });
    // 中断后不再占用活动名额
    expect(await tasks.findActive(SPACE_A)).toBeUndefined();
  });

  it("旧任务行（无 kind/initText 字段）读取时缺省视为 floor，initText 补 null", async () => {
    const db = createTestDatabase();
    const tasks = new DexieFillTaskRepository(db, () => NOW);
    // 模拟初始化填表之前写入的旧行：直接以缺字段的行形状落库（IndexedDB 行是动态对象）
    const legacy = { ...task() } as Record<string, unknown>;
    delete legacy.kind;
    delete legacy.initText;
    await db.memoryFillTasks.add(legacy as unknown as FillTask);    // find / findActive / listRecent 全部补默认（floor + null），不改变旧行数据
    expect(await tasks.find("run-1")).toMatchObject({ kind: "floor", initText: null });
    expect(await tasks.findActive(SPACE_A)).toMatchObject({ kind: "floor", initText: null });
    expect(await tasks.listRecent(SPACE_A, 5)).toMatchObject([{ kind: "floor", initText: null }]);
    // 状态转换读写不丢字段（转换后行仍可被识别为 floor 任务）
    await tasks.markSucceeded("run-1");
    expect(await tasks.find("run-1")).toMatchObject({ kind: "floor", status: "succeeded" });
  });

  it("init 任务行读写：kind/initText 原样持久化，守卫与终态转换通用", async () => {
    const db = createTestDatabase();
    const tasks = new DexieFillTaskRepository(db, () => NOW);
    const initTask = task({
      runId: "run-init",
      from: 0,
      to: 0,
      blockSize: 1,
      kind: "init",
      initText: "爱丽丝是咖啡店店员，故事发生在雨城",
    });

    await tasks.create(initTask);
    expect(await tasks.find("run-init")).toEqual(initTask);
    expect(await tasks.findActive(SPACE_A)).toMatchObject({ runId: "run-init", kind: "init" });

    // 终态转换与楼层任务同语义（仅 running 生效）
    expect(await tasks.markSucceeded("run-init")).toBe(true);
    expect(await tasks.find("run-init")).toMatchObject({ kind: "init", status: "succeeded" });
    expect(await tasks.findActive(SPACE_A)).toBeUndefined();
  });

  it("listRecent：按 createdAt 倒序（id 兜底）并截断 limit", async () => {
    const db = createTestDatabase();
    const tasks = new DexieFillTaskRepository(db, () => NOW);

    const statuses: readonly FillTaskStatus[] = [
      "succeeded",
      "succeeded",
      "failed",
      "running",
      "interrupted",
    ];
    for (const [index, status] of statuses.entries()) {
      await tasks.create(
        task({
          runId: `run-${index}`,
          status,
          errorMessage: status === "failed" ? "模型炸了" : null,
          createdAt: `2026-07-28T00:00:0${index}.000Z`,
        }),
      );
    }

    const recent = await tasks.listRecent(SPACE_A, 3);
    expect(recent.map((row) => row.runId)).toEqual(["run-4", "run-3", "run-2"]);
    expect(recent[0]).toMatchObject({ status: "interrupted" });
    expect(recent[2]).toMatchObject({ status: "failed", errorMessage: "模型炸了" });
    // 空间隔离
    expect(await tasks.listRecent(SPACE_B, 10)).toEqual([]);
  });

  it("空间删除级联清理任务行与楼层台账（与表格/记录同语义）", async () => {
    const db = createTestDatabase();
    const tasks = new DexieFillTaskRepository(db, () => NOW);
    const ledger = new DexieFloorLedgerRepository(db);

    await tasks.create(task());
    await tasks.create(task({ runId: "run-2", memorySpaceId: SPACE_B }));
    await ledger.markProcessed(SPACE_A, [0, 1]);
    await ledger.markError(SPACE_B, [2]);

    const spaces = new DexieMemorySpaceRepository(db);
    await spaces.create({ id: SPACE_A, name: "会话", createdAt: NOW, updatedAt: NOW });
    await spaces.create({ id: SPACE_B, name: "其他", createdAt: NOW, updatedAt: NOW });

    expect(await spaces.delete(SPACE_A)).toBe(true);
    // 空间 A 的任务与台账行被清掉；空间 B 不受影响
    expect(await tasks.find("run-1")).toBeUndefined();
    expect(await tasks.find("run-2")).toMatchObject({ status: "running" });
    expect(await ledger.statuses(SPACE_A, 0, 1)).toEqual([
      { floor: 0, status: "untracked" },
      { floor: 1, status: "untracked" },
    ]);
    expect(await ledger.statuses(SPACE_B, 2, 2)).toEqual([{ floor: 2, status: "error" }]);
  });

  it("upgrades an existing v2 database to v3 without data loss（任务表/台账表新增，旧数据保留）", async () => {
    const name = "ste-memory-test-fill-upgrade";
    const v2 = new SteMemoryDatabaseV2(name);
    await v2.open();
    await v2.memorySpaces.add({
      id: SPACE_A,
      name: "会话",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const record: MemoryRecord = {
      id: "record-1" as MemoryRecordId,
      memorySpaceId: SPACE_A,
      tableId: "table-1" as MemoryTableId,
      payload: {},
      fieldEvidence: {},
      displayText: "旧记录",
      source: { type: "manual" },
      revisionId: "revision-1" as MemoryRecord["revisionId"],
      revisionSource: "user",
      createdAt: NOW,
      updatedAt: NOW,
    };
    await v2.memoryRecords.add(record);
    v2.close();

    const upgraded = new SteMemoryDatabase(name);
    try {
      // v2 数据在升级后仍在
      expect((await upgraded.memorySpaces.get(SPACE_A))?.name).toBe("会话");
      expect((await upgraded.memoryRecords.get("record-1" as MemoryRecordId))?.displayText).toBe(
        "旧记录",
      );
      // v3 新增的表可用：任务行 + 楼层台账
      await upgraded.memoryFillTasks.add({
        runId: "run-upgraded",
        memorySpaceId: SPACE_A,
        from: 0,
        to: 1,
        kind: "floor",
        initText: null,
        blockSize: 20,
        chatId: null,
        status: "succeeded",
        errorMessage: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await upgraded.floorFillLedger.add({
        id: `${SPACE_A}:0`,
        memorySpaceId: SPACE_A,
        floor: 0,
        status: "processed",
        updatedAt: NOW,
      });
      expect(await upgraded.memoryFillTasks.count()).toBe(1);
      expect(await upgraded.floorFillLedger.count()).toBe(1);
    } finally {
      await upgraded.delete();
    }
  });
});
