/**
 * 空间维护服务（spec reset-space）测试 —— 主接缝（行为全量）。
 *
 * 用内存 Dexie 库 + 真实系统表安装器 + 真实填表任务/台账仓库接线（同一库）：
 * - 清除空间记录：记录派生数据消失而表格结构保留；填表任务与楼层台账被清；
 *   空间身份不变；
 * - 重置空间：表格归零并重装出 8 张出厂系统表（自定义表不重装、被修改的系统表
 *   回默认）；记录/历史/证据消失；空间身份不变；
 * - 进行中填表任务在执行前被取消（cancelActiveTask 先于数据操作被调用）；
 * - 重装失败上抛、空间保持无表状态；空间不存在返回 false。
 */
import { describe, expect, it, vi } from "vitest";
import { SystemMemoryTableInstaller } from "@ste-memory/memory-host-shared";
import type { MemorySpaceId } from "@ste-memory/core/memory";
// fake-indexeddb 必须先于 dexie 模块求值（test-support 第一行 import "fake-indexeddb/auto"）
import { createServices, createTestDatabase, NOW } from "../db/test-support.ts";
import { DexieFillTaskRepository, DexieFloorLedgerRepository } from "../db/fill-task-repository.ts";
import { DexieLogRepository } from "../db/log-repository.ts";
import { SpaceMaintenanceService } from "./space-maintenance-service.ts";

/** 出厂 characters 表字段数（system-memory-table-definitions）。 */
const CHARACTERS_DEFAULT_FIELD_COUNT = 7;

async function setup(overrides: { readonly installThrows?: boolean } = {}) {
  const db = createTestDatabase();
  const services = createServices(db);
  const space = await services.spaces.create("会话");
  const installer = new SystemMemoryTableInstaller(services.tables, services.fields);
  await installer.install(space.id);
  const taskRepository = new DexieFillTaskRepository(db, () => NOW);
  const ledgerRepository = new DexieFloorLedgerRepository(db, () => NOW);
  const logs = new DexieLogRepository(db, { now: () => NOW });

  // 给系统表加一条记录（含字段证据 → 证据行）+ 更新一次（→ 历史行）
  const characters = (await services.tableRepository.list(space.id)).find(
    (table) => table.key === "characters",
  )!;
  const fields = await services.fieldRepository.list(space.id, characters.id);
  const name = fields.find((field) => field.name === "名称")!;
  const identity = fields.find((field) => field.name === "身份/定位")!;
  const created = await services.records.create(space.id, characters.id, {
    payload: { [name.id]: "林夏", [identity.id]: "调查员" },
    fieldEvidence: {
      [name.id]: [
        {
          source_type: "message",
          source_id: 42,
          storage_mode: "reference",
        },
      ],
    },
  });
  expect(created).toBeDefined();
  await services.records.update(space.id, characters.id, created!.id, {
    expectedRevisionId: created!.revisionId,
    revisionSource: "user",
    patch: { [name.id]: "林夏（改）" },
  });

  // 自定义表（重置后不应重装）
  const custom = await services.tables.create(space.id, {
    key: "clues",
    kind: "custom",
    name: "线索",
    description: "",
    prompt: "",
  });
  expect(custom).toBeDefined();

  // 系统表被修改过（新增字段 → 重置后应回到出厂字段数）
  await services.fields.create(space.id, characters.id, {
    key: "extra",
    name: "附加",
    type: "short_text",
    required: false,
    prompt: "",
    enabled: true,
    position: 0,
  });

  const cancelActiveTask = vi.fn(async () => {});
  const maintenance = new SpaceMaintenanceService({
    clearRecords: (id) => services.spaces.clearRecords(id),
    deleteAllTables: (id) => services.spaces.deleteAllTables(id),
    cancelActiveTask,
    clearTasks: (id) => taskRepository.clear(id),
    clearLedger: (id) => ledgerRepository.clear(id),
    installSystemTables: async (id) => {
      if (overrides.installThrows) {
        // 模拟安装器中途失败留下的半初始化状态（安装器非事务，逐表创建）
        await services.tables.create(id, {
          key: "half-1",
          kind: "system",
          name: "半装表 1",
          description: "",
          prompt: "",
        });
        await services.tables.create(id, {
          key: "half-2",
          kind: "system",
          name: "半装表 2",
          description: "",
          prompt: "",
        });
        throw new Error("重装失败");
      }
      await installer.install(id);
    },
  });

  return {
    db,
    ...services,
    space,
    characters,
    logs,
    taskRepository,
    ledgerRepository,
    cancelActiveTask,
    maintenance,
  };
}

describe("SpaceMaintenanceService（spec reset-space）", () => {
  it("清除空间记录：记录/历史/证据消失，表格结构保留，任务与台账清空，空间保留", async () => {
    const { db, spaces, maintenance, space, characters, logs, taskRepository, ledgerRepository } =
      await setup();
    const spaceId = space.id;

    await taskRepository.create({
      runId: "task-1",
      memorySpaceId: spaceId,
      from: 0,
      to: 5,
      blockSize: 20,
      kind: "floor",
      initText: null,
      chatId: null,
      status: "succeeded",
      errorMessage: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ledgerRepository.markProcessed(spaceId, [0, 1, 2]);
    await logs.append({ type: "fill-run", key: "run-1", spaceId, level: "info", data: {} });

    const existed = await maintenance.clearRecords(spaceId);
    expect(existed).toBe(true);

    // 记录派生数据消失
    expect(await db.memoryRecords.count()).toBe(0);
    expect(await db.memoryRecordHistory.count()).toBe(0);
    expect(await db.memoryEvidence.count()).toBe(0);
    // 表格结构保留（8 张系统表 + 1 张自定义表），字段原样（含新增的 extra）
    const remaining = await db.memoryTables.toArray();
    expect(remaining).toHaveLength(9);
    expect(remaining.map((table) => table.key)).toContain("clues");
    const chars = remaining.find((table) => table.key === "characters")!;
    expect(
      await db.memoryFields.where("[memorySpaceId+tableId]").equals([spaceId, chars.id]).count(),
    ).toBe(CHARACTERS_DEFAULT_FIELD_COUNT + 1);
    // 填表任务与楼层台账清空，通用日志保留（审计数据）
    expect(await db.memoryFillTasks.count()).toBe(0);
    expect(await db.floorFillLedger.count()).toBe(0);
    expect(await db.memoryLogs.where("spaceId").equals(spaceId).count()).toBe(1);
    // 空间身份保留
    expect(await spaces.find(spaceId)).toMatchObject({ id: spaceId, name: "会话" });
  });

  it("重置空间：表格归零并重装出厂系统表，自定义表消失、被修改的系统表回默认", async () => {
    const { db, maintenance, space } = await setup();

    const existed = await maintenance.reset(space.id);
    expect(existed).toBe(true);

    const tables = await db.memoryTables.toArray();
    expect(tables).toHaveLength(8);
    expect(tables.every((table) => table.kind === "system" && table.enabled)).toBe(true);
    expect(tables.map((table) => table.key)).toEqual([
      "characters",
      "relationships",
      "locations",
      "items",
      "plots",
      "foreshadowing",
      "todos",
      "story_state",
    ]);
    // 记录/历史/证据消失
    expect(await db.memoryRecords.count()).toBe(0);
    expect(await db.memoryRecordHistory.count()).toBe(0);
    expect(await db.memoryEvidence.count()).toBe(0);
    // 被修改过的系统表回到出厂字段数
    const characters = tables.find((table) => table.key === "characters")!;
    expect(
      await db.memoryFields
        .where("[memorySpaceId+tableId]")
        .equals([space.id, characters.id])
        .count(),
    ).toBe(CHARACTERS_DEFAULT_FIELD_COUNT);
    // 空间身份保留
    expect(await db.memorySpaces.get(space.id)).toMatchObject({ id: space.id, name: "会话" });
  });

  it("重置空间同时清空填表任务与楼层台账", async () => {
    const { db, maintenance, space, taskRepository, ledgerRepository } = await setup();

    await taskRepository.create({
      runId: "task-2",
      memorySpaceId: space.id,
      from: 0,
      to: 3,
      blockSize: 20,
      kind: "floor",
      initText: null,
      chatId: null,
      status: "failed",
      errorMessage: "boom",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ledgerRepository.markProcessed(space.id, [4, 5]);

    await maintenance.reset(space.id);
    expect(await db.memoryFillTasks.count()).toBe(0);
    expect(await db.floorFillLedger.count()).toBe(0);
  });

  it("执行前取消进行中的填表任务（先于数据操作）", async () => {
    const { maintenance, space, cancelActiveTask } = await setup();

    await maintenance.clearRecords(space.id);
    expect(cancelActiveTask).toHaveBeenCalledWith(space.id);
  });

  it("重置重装失败：清理半初始化表格后上抛，空间保持无表状态", async () => {
    const { db, maintenance, space } = await setup({ installThrows: true });

    await expect(maintenance.reset(space.id)).rejects.toThrow("重装失败");
    // 半初始化表格（安装器中途失败留下的）也被清理：无表状态承诺成立，可重试
    expect(await db.memoryTables.count()).toBe(0);
    expect(await db.memoryFields.count()).toBe(0);
    expect(await db.memorySpaces.get(space.id)).toBeDefined();
  });

  it("空间不存在：清除/重置返回 false 且不抛错", async () => {
    const { maintenance } = await setup();
    const missing = "missing-space" as MemorySpaceId;

    expect(await maintenance.clearRecords(missing)).toBe(false);
    expect(await maintenance.reset(missing)).toBe(false);
  });
});
