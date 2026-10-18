/**
 * 空间维护服务测试 —— 主接缝（行为全量）。
 *
 * 用内存 Dexie 库 + 真实表格预设初始化 + 真实填表任务/台账仓库接线（同一库）：
 * - 清除空间记录：记录派生数据消失而表格结构保留；填表任务与楼层台账被清；
 *   空间身份与初始化来源不变；
 * - 进行中填表任务在执行前被取消（cancelActiveTask 先于数据操作被调用）；
 * - 空间不存在返回 false。
 */
import { describe, expect, it, vi } from "vitest";
import type { MemorySpaceId } from "../memory/index.ts";
// fake-indexeddb 必须先于 dexie 模块求值（test-support 第一行 import "fake-indexeddb/auto"）
import {
  createServices,
  createTestDatabase,
  createTestLogDatabase,
  installDefaultPreset,
  NOW,
} from "../../infrastructure/indexeddb/test-support.ts";
import {
  DexieFillTaskRepository,
  DexieFloorLedgerRepository,
} from "../../infrastructure/indexeddb/fill-tasks/fill-task-repository.ts";
import { DexieLogRepository } from "../../infrastructure/indexeddb/logs/log-repository.ts";
import { SpaceMaintenanceService } from "./space-maintenance-service.ts";

/** 出厂 characters 表字段数（system-memory-table-definitions）。 */
const CHARACTERS_DEFAULT_FIELD_COUNT = 7;

async function setup() {
  const db = createTestDatabase();
  const services = createServices(db);
  const space = await services.spaces.create("会话");
  await installDefaultPreset(db, space.id);
  const taskRepository = new DexieFillTaskRepository(db, () => NOW);
  const ledgerRepository = new DexieFloorLedgerRepository(db, () => NOW);
  const logs = new DexieLogRepository(createTestLogDatabase(), { now: () => NOW });

  // 给表格加一条记录（含字段证据 → 证据行）+ 更新一次（→ 历史行）
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

  // 用户自行新增的表（清除记录后应原样保留）
  const custom = await services.tables.create(space.id, {
    key: "clues",
    name: "线索",
    description: "",
    prompt: "",
    position: 8,
  });
  expect(custom).toBeDefined();

  // 被修改过的表（新增字段 → 清除记录后字段原样保留）
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
    cancelActiveTask,
    clearTasks: (id) => taskRepository.clear(id),
    clearLedger: (id) => ledgerRepository.clear(id),
  });

  return {
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

describe("SpaceMaintenanceService（清除空间记录）", () => {
  it("清除空间记录：记录/历史/证据消失，表格结构保留，任务与台账清空，空间保留", async () => {
    const { db, spaces, maintenance, space, logs, taskRepository, ledgerRepository } =
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
    await logs.append({ type: "fill-task", key: "run-1", level: "info", text: "{}" });

    const existed = await maintenance.clearRecords(spaceId);
    expect(existed).toBe(true);

    // 记录派生数据消失
    expect(await db.memoryRecords.count()).toBe(0);
    expect(await db.memoryRecordHistory.count()).toBe(0);
    expect(await db.memoryEvidence.count()).toBe(0);
    // 表格结构保留（8 张预设表 + 1 张用户新增表），字段原样（含新增的 extra）
    const remaining = await db.memoryTables.toArray();
    expect(remaining).toHaveLength(9);
    expect(remaining.map((table) => table.key)).toContain("clues");
    const chars = remaining.find((table) => table.key === "characters")!;
    expect(
      await db.memoryFields.where("[memorySpaceId+tableId]").equals([spaceId, chars.id]).count(),
    ).toBe(CHARACTERS_DEFAULT_FIELD_COUNT + 1);
    // 填表任务与楼层台账清空；通用日志在独立库，不随空间维护清空（审计数据）
    expect(await db.memoryFillTasks.count()).toBe(0);
    expect(await db.floorFillLedger.count()).toBe(0);
    expect((await logs.recent(10)).map((row) => row.key)).toEqual(["run-1"]);
    // 空间身份与初始化来源保留（清除记录不套用预设、不改来源）
    const after = await spaces.find(spaceId);
    expect(after).toMatchObject({ id: spaceId, name: "会话" });
    expect(after?.initializationSource?.presetName).toBe("系统默认");
  });

  it("执行前取消进行中的填表任务（先于数据操作）", async () => {
    const { maintenance, space, cancelActiveTask } = await setup();

    await maintenance.clearRecords(space.id);
    expect(cancelActiveTask).toHaveBeenCalledWith(space.id);
  });

  it("空间不存在：清除返回 false 且不抛错", async () => {
    const { maintenance } = await setup();
    const missing = "missing-space" as MemorySpaceId;

    expect(await maintenance.clearRecords(missing)).toBe(false);
  });
});
