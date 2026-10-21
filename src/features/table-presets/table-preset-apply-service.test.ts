import { STORY_MEMORY_PRESET } from "./story-memory-preset.ts";
import { captureSpaceStructure } from "./space-structure-capture.ts";
import { buildMemorySpaceTableDigest } from "../agent/digest.ts";
import { describe, expect, it, vi } from "vitest";
import type { MemoryFieldId, MemorySpaceId, MemoryTableId } from "../memory/index.ts";
import type { ResolvedTablePreset } from "./preset-model.ts";
import { SYSTEM_TABLE_PRESET } from "./system-preset.ts";
import { TablePresetApplyService } from "./table-preset-apply-service.ts";
import {
  createServices,
  createTestDatabase,
  installDefaultPreset,
  NOW,
} from "../../infrastructure/indexeddb/test-support.ts";
import {
  DexieFillTaskRepository,
  DexieFloorLedgerRepository,
} from "../../infrastructure/indexeddb/fill-tasks/fill-task-repository.ts";
import { DexieMemorySpaceRepository } from "../../infrastructure/indexeddb/memory/memory-space-repository.ts";
import { DexieSpaceStructureRebuild } from "../../infrastructure/indexeddb/space/space-structure-rebuild-repository.ts";

/** 应用目标预设：两张表（人物 ← 引用；关系用模板显示策略），含停用字段。 */
const TARGET_PRESET: ResolvedTablePreset = {
  id: "preset-1",
  name: "我的结构",
  description: "两表结构",
  builtIn: false,
  tables: [
    {
      key: "people",
      name: "人物",
      description: "",
      prompt: "只记人物",
      enabled: true,
      displayStrategy: { type: "field", fieldKey: "name" },
      fields: [
        {
          key: "name",
          name: "名称",
          type: "short_text",
          required: true,
          prompt: "",
          enabled: true,
          options: [],
          referenceTableKey: null,
          maxChars: 30,
          valuePattern: null,
          valuePatternMessage: null,
        },
        {
          key: "secret",
          name: "秘闻",
          type: "long_text",
          required: false,
          prompt: "",
          enabled: false,
          options: [],
          referenceTableKey: null,
          maxChars: null,
          valuePattern: null,
          valuePatternMessage: null,
        },
      ],
    },
    {
      key: "relations",
      name: "关系",
      description: "",
      prompt: "",
      enabled: true,
      displayStrategy: { type: "template", template: "{from} -> {to}" },
      fields: [
        {
          key: "from",
          name: "从",
          type: "single_reference",
          required: true,
          prompt: "",
          enabled: true,
          options: [],
          referenceTableKey: "people",
          maxChars: null,
          valuePattern: null,
          valuePatternMessage: null,
        },
        {
          key: "to",
          name: "到",
          type: "single_reference",
          required: true,
          prompt: "",
          enabled: true,
          options: [],
          referenceTableKey: "people",
          maxChars: null,
          valuePattern: null,
          valuePatternMessage: null,
        },
      ],
    },
  ],
};

/** 建库 + 空间 + 系统默认结构；返回接线好的服务与端口。 */
async function setup() {
  const db = createTestDatabase();
  const services = createServices(db);
  const space = await services.spaces.create("会话");
  await installDefaultPreset(db, space.id);
  const spaceRepository = new DexieMemorySpaceRepository(db);
  const rebuild = new DexieSpaceStructureRebuild(db, spaceRepository);
  const taskRepository = new DexieFillTaskRepository(db, () => NOW);
  const ledgerRepository = new DexieFloorLedgerRepository(db, () => NOW);
  let tableSeq = 0;
  let fieldSeq = 0;
  const apply = new TablePresetApplyService({
    cancelActiveTask: async (id) => {
      const active = await taskRepository.findActive(id);
      if (active) await taskRepository.markInterrupted(active.runId);
    },
    rebuild,
    defaultPreset: () => SYSTEM_TABLE_PRESET,
    currentChatIdentity: () => "char:3:story",
    clearChatScopeMacros: () => undefined,
    createIds: {
      table: () => `applied-table-${++tableSeq}` as MemoryTableId,
      field: () => `applied-field-${++fieldSeq}` as MemoryFieldId,
    },
    now: () => "2026-10-18T12:00:00.000Z",
  });
  return { db, services, space, spaceRepository, taskRepository, ledgerRepository, apply };
}

describe("TablePresetApplyService（应用预设）", () => {
  it("确认后切换对话：在任何重建和宏清理之前拒绝操作", async () => {
    const rebuild = vi.fn(async () => true);
    const clearChatScopeMacros = vi.fn();
    const syncMirror = vi.fn(async () => undefined);
    const apply = new TablePresetApplyService({
      cancelActiveTask: async () => undefined,
      rebuild: { rebuild },
      defaultPreset: () => SYSTEM_TABLE_PRESET,
      currentChatIdentity: () => "char:9:other",
      clearChatScopeMacros,
      createIds: { table: () => "unused" as MemoryTableId, field: () => "unused" as MemoryFieldId },
      now: () => NOW,
    });
    await expect(
      apply.applyPreset("space-A" as MemorySpaceId, TARGET_PRESET, {
        chatIdentity: "char:3:story",
        refreshMacros: async () => undefined,
        syncMirror,
      }),
    ).rejects.toThrow("对话已切换");
    expect(rebuild).not.toHaveBeenCalled();
    expect(clearChatScopeMacros).not.toHaveBeenCalled();
    expect(syncMirror).not.toHaveBeenCalled();
  });

  it("首次创建：按默认预设写结构并记录初始化来源", async () => {
    const { db, services } = await setup();
    const fresh = await services.spaces.create("新空间");
    const apply = new TablePresetApplyService({
      cancelActiveTask: async () => undefined,
      rebuild: new DexieSpaceStructureRebuild(db, new DexieMemorySpaceRepository(db)),
      defaultPreset: () => TARGET_PRESET,
      currentChatIdentity: () => undefined,
      clearChatScopeMacros: () => undefined,
      createIds: {
        table: () => `init-table-${Math.random().toString(36).slice(2)}` as MemoryTableId,
        field: () => `init-field-${Math.random().toString(36).slice(2)}` as MemoryFieldId,
      },
      now: () => "2026-10-18T09:00:00.000Z",
    });

    await apply.installDefaultStructure(fresh.id);

    const tables = await db.memoryTables.where("memorySpaceId").equals(fresh.id).toArray();
    expect(tables.map((table) => table.key).sort()).toEqual(["people", "relations"]);
    const stored = await services.spaces.find(fresh.id);
    expect(stored?.initializationSource).toEqual({
      presetId: "preset-1",
      presetName: "我的结构",
      appliedAt: "2026-10-18T09:00:00.000Z",
    });
  });

  it("应用预设：结构重建、记录/历史/证据/任务/进度清空、空间身份保留（AC-08）", async () => {
    const { db, services, space, taskRepository, ledgerRepository, apply } = await setup();
    // 原空间内容：一条记录 + 一次修订（历史）+ 证据 + 任务 + 台账
    const characters = (await services.tableRepository.list(space.id)).find(
      (table) => table.key === "characters",
    )!;
    const fields = await services.fieldRepository.list(space.id, characters.id);
    const name = fields[0]!;
    const record = await services.records.create(space.id, characters.id, {
      payload: { [name.id]: "林夏" },
      fieldEvidence: {
        [name.id]: [{ source_type: "message", source_id: 7, storage_mode: "reference" }],
      },
    });
    await services.records.update(space.id, characters.id, record!.id, {
      expectedRevisionId: record!.revisionId,
      revisionSource: "user",
      patch: { [name.id]: "林夏（改）" },
    });
    await taskRepository.create({
      runId: "run-1",
      memorySpaceId: space.id,
      from: 0,
      to: 3,
      blockSize: 20,
      kind: "floor",
      initText: null,
      chatId: "story",
      status: "running",
      errorMessage: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ledgerRepository.markProcessed(space.id, [0, 1]);
    const other = await services.spaces.create("另一个空间");
    await installDefaultPreset(db, other.id);

    const clearedChatScopeMacros = vi.fn();
    const refreshMacros = vi.fn(async () => undefined);
    const syncMirror = vi.fn(async () => undefined);
    const outcome = await apply.applyPreset(space.id, TARGET_PRESET, {
      chatIdentity: "char:3:story",
      refreshMacros,
      syncMirror,
    });

    expect(outcome).toEqual({ kind: "applied" });
    expect(refreshMacros).toHaveBeenCalledTimes(1);
    expect(syncMirror).toHaveBeenCalledTimes(1);
    expect(clearedChatScopeMacros).not.toHaveBeenCalled();

    // 结构替换：旧表（含记录/历史/证据）全部消失，新结构就位
    const tables = (await services.tables.list(space.id)).map((table) => table.key);
    expect(tables).toEqual(["people", "relations"]);
    expect(await db.memoryRecords.where("memorySpaceId").equals(space.id).count()).toBe(0);
    expect(await db.memoryRecordHistory.where("memorySpaceId").equals(space.id).count()).toBe(0);
    expect(await db.memoryEvidence.where("memorySpaceId").equals(space.id).count()).toBe(0);
    // 任务与楼层进度清空
    expect(await db.memoryFillTasks.where("memorySpaceId").equals(space.id).count()).toBe(0);
    expect(await db.floorFillLedger.where("memorySpaceId").equals(space.id).count()).toBe(0);
    // 空间身份保留、来源更新为本次预设
    const stored = await services.spaces.find(space.id);
    expect(stored).toMatchObject({ id: space.id, name: "会话" });
    expect(stored?.initializationSource).toEqual({
      presetId: "preset-1",
      presetName: "我的结构",
      appliedAt: "2026-10-18T12:00:00.000Z",
    });
    // 其他空间不受影响
    expect((await services.tables.list(other.id)).length).toBe(8);
  });

  it("应用后新结构可用：引用与显示策略按新 ID 建立、停用字段保留（AC-16）", async () => {
    const { db, services, space, apply } = await setup();
    await apply.applyPreset(space.id, TARGET_PRESET, {
      chatIdentity: "char:3:story",
      refreshMacros: async () => undefined,
      syncMirror: async () => undefined,
    });

    const tables = await db.memoryTables.where("memorySpaceId").equals(space.id).toArray();
    const people = tables.find((table) => table.key === "people")!;
    const relations = tables.find((table) => table.key === "relations")!;
    const peopleFields = await db.memoryFields
      .where("[memorySpaceId+tableId]")
      .equals([space.id, people.id])
      .toArray();
    const relationFields = await db.memoryFields
      .where("[memorySpaceId+tableId]")
      .equals([space.id, relations.id])
      .toArray();
    expect(people.displayStrategy).toEqual({ type: "field", fieldId: peopleFields[0]!.id });
    expect(peopleFields[1]!.enabled).toBe(false);
    expect(relations.displayStrategy).toEqual({
      type: "template",
      template: `{${relationFields[0]!.id}} -> {${relationFields[1]!.id}}`,
    });
    expect(relationFields.map((field) => field.referenceTableId)).toEqual([people.id, people.id]);

    // 新结构可以写入记录（显示策略可用）
    const created = await services.records.create(space.id, people.id, {
      payload: { [peopleFields[0]!.id]: "林夏" },
    });
    expect(created?.displayText).toBe("林夏");
    expect(await services.spaces.find(space.id)).toBeDefined();
  });

  it("同一预设重新初始化：可执行且记录换新初始化来源（AC-09）", async () => {
    const { services, space, apply } = await setup();
    const sync = {
      chatIdentity: "char:3:story",
      refreshMacros: async () => undefined,
      syncMirror: async () => undefined,
    };
    await apply.applyPreset(space.id, TARGET_PRESET, sync);
    const first = await services.spaces.find(space.id);
    const outcome = await apply.applyPreset(space.id, TARGET_PRESET, sync);

    expect(outcome).toEqual({ kind: "applied" });
    const second = await services.spaces.find(space.id);
    expect(second?.initializationSource).toEqual(first?.initializationSource);
    expect((await services.tableRepository.list(space.id)).map((table) => table.key)).toEqual([
      "people",
      "relations",
    ]);
  });

  it("停止写入：进行中任务被置为 interrupted（备份必须在停止之后）", async () => {
    const { space, taskRepository, apply } = await setup();
    await taskRepository.create({
      runId: "run-2",
      memorySpaceId: space.id,
      from: 0,
      to: 3,
      blockSize: 20,
      kind: "floor",
      initText: null,
      chatId: null,
      status: "running",
      errorMessage: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await apply.stopSpaceWrites(space.id);

    expect((await taskRepository.find("run-2"))?.status).toBe("interrupted");
  });

  it("重建中途失败：原结构、记录与任务保留，来源未更新（AC-13）", async () => {
    const { db, services, space, taskRepository, apply } = await setup();
    const characters = (await services.tableRepository.list(space.id)).find(
      (table) => table.key === "characters",
    )!;
    const fields = await services.fieldRepository.list(space.id, characters.id);
    await services.records.create(space.id, characters.id, {
      payload: { [fields[0]!.id]: "林夏" },
    });
    await taskRepository.create({
      runId: "run-3",
      memorySpaceId: space.id,
      from: 0,
      to: 1,
      blockSize: 20,
      kind: "floor",
      initText: null,
      chatId: null,
      status: "failed",
      errorMessage: "boom",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const before = await services.spaces.find(space.id);
    // 让新结构与另一空间的表格 ID 相撞：事务写表时触发约束错误
    const collision = (await services.tables.list(space.id)).length;
    const conflictingId = "applied-table-1" as MemoryTableId;
    await db.memoryTables.add({
      ...(await db.memoryTables.toArray())[0]!,
      id: conflictingId,
      memorySpaceId: "space-other" as MemorySpaceId,
      key: "clash" as never,
    });
    expect(collision).toBe(8);

    await expect(
      apply.applyPreset(space.id, TARGET_PRESET, {
        chatIdentity: "char:3:story",
        refreshMacros: async () => undefined,
        syncMirror: async () => undefined,
      }),
    ).rejects.toThrowError();

    // 原持久化内容保留（结构 / 记录 / 任务 / 来源）
    expect(await services.tables.list(space.id)).toHaveLength(8);
    expect(await db.memoryRecords.where("memorySpaceId").equals(space.id).count()).toBe(1);
    expect(await taskRepository.find("run-3")).toBeDefined();
    expect(await services.spaces.find(space.id)).toEqual(before);
  });

  it("空间不存在：应用抛错、不产生任何写入", async () => {
    const { db, apply } = await setup();
    const missing = "missing-space" as MemorySpaceId;

    await expect(
      apply.applyPreset(missing, TARGET_PRESET, {
        chatIdentity: "char:3:story",
        refreshMacros: async () => undefined,
        syncMirror: async () => undefined,
      }),
    ).rejects.toThrowError(/记忆空间不存在/);
    expect(await db.memoryTables.where("memorySpaceId").equals(missing).count()).toBe(0);
  });

  it("重建后同步失败：明确回报同步失败，空间保持已重建状态（AC-15）", async () => {
    const { services, space, apply } = await setup();

    const outcome = await apply.applyPreset(space.id, TARGET_PRESET, {
      chatIdentity: "char:3:story",
      refreshMacros: async () => {
        throw new Error("宏炸了");
      },
      syncMirror: async () => {
        throw new Error("镜像炸了");
      },
    });

    expect(outcome.kind).toBe("applied-with-sync-issue");
    if (outcome.kind !== "applied-with-sync-issue") return;
    expect(outcome.message).toContain("宏快照重建失败");
    expect(outcome.message).toContain("记忆镜像同步失败");
    // 已提交的重建不回滚、不再清空
    expect((await services.tables.list(space.id)).map((table) => table.key)).toEqual([
      "people",
      "relations",
    ]);
  });

  it("对话已切换：不清理新对话的对话级宏，并回报（AC-14）", async () => {
    const db = createTestDatabase();
    const services = createServices(db);
    const space = await services.spaces.create("会话");
    await installDefaultPreset(db, space.id);
    let identity = "char:3:story";
    const clearChatScopeMacros = vi.fn();
    const rebuild = new DexieSpaceStructureRebuild(db, new DexieMemorySpaceRepository(db));
    const apply = new TablePresetApplyService({
      cancelActiveTask: async () => undefined,
      // 重建期间切走对话：重建提交后当前对话身份已不同
      rebuild: {
        rebuild: async (input) => {
          const rebuilt = await rebuild.rebuild(input);
          identity = "char:9:other";
          return rebuilt;
        },
      },
      defaultPreset: () => SYSTEM_TABLE_PRESET,
      currentChatIdentity: () => identity,
      clearChatScopeMacros,
      createIds: {
        table: () => `swap-table-${Math.random().toString(36).slice(2)}` as MemoryTableId,
        field: () => `swap-field-${Math.random().toString(36).slice(2)}` as MemoryFieldId,
      },
      now: () => NOW,
    });

    const outcome = await apply.applyPreset(space.id, TARGET_PRESET, {
      chatIdentity: "char:3:story",
      refreshMacros: async () => undefined,
      syncMirror: async () => undefined,
    });

    expect(outcome.kind).toBe("applied-with-sync-issue");
    if (outcome.kind !== "applied-with-sync-issue") return;
    expect(outcome.message).toContain("对话已切换");
    expect(clearChatScopeMacros).not.toHaveBeenCalled();
    // 目标空间仍按预设重建（只作用原空间）
    expect((await services.tableRepository.list(space.id)).map((table) => table.key)).toEqual([
      "people",
      "relations",
    ]);
  });

  it("对话未切换：清除本次操作所属对话的对话级宏", async () => {
    const db = createTestDatabase();
    const services = createServices(db);
    const space = await services.spaces.create("会话");
    await installDefaultPreset(db, space.id);
    const clearChatScopeMacros = vi.fn();
    const apply = new TablePresetApplyService({
      cancelActiveTask: async () => undefined,
      rebuild: new DexieSpaceStructureRebuild(db, new DexieMemorySpaceRepository(db)),
      defaultPreset: () => SYSTEM_TABLE_PRESET,
      currentChatIdentity: () => "char:3:story",
      clearChatScopeMacros,
      createIds: {
        table: () => `keep-table-${Math.random().toString(36).slice(2)}` as MemoryTableId,
        field: () => `keep-field-${Math.random().toString(36).slice(2)}` as MemoryFieldId,
      },
      now: () => NOW,
    });

    const outcome = await apply.applyPreset(space.id, TARGET_PRESET, {
      chatIdentity: "char:3:story",
      refreshMacros: async () => undefined,
      syncMirror: async () => undefined,
    });

    expect(outcome).toEqual({ kind: "applied" });
    expect(clearChatScopeMacros).toHaveBeenCalledTimes(1);
  });
});

it("新预设保留共用规则与纪要归属引用，另存可往返，已有其他空间保持原样", async () => {
  const { db, services, space, apply } = await setup();
  const oldTables = await services.tables.list(space.id);
  const fresh = await services.spaces.create("新预设空间");
  await apply.applyPreset(fresh.id, STORY_MEMORY_PRESET, {
    chatIdentity: "char:3:story",
    refreshMacros: async () => undefined,
    syncMirror: async () => undefined,
  });
  const stored = (await services.spaces.find(fresh.id))!;
  expect(stored.prompt).toBe(STORY_MEMORY_PRESET.prompt);
  expect(stored.summaryRules).toEqual(STORY_MEMORY_PRESET.summaryRules);
  const tables = await services.tables.list(fresh.id);
  const fields = await db.memoryFields.where("memorySpaceId").equals(fresh.id).toArray();
  expect(tables).toHaveLength(8);
  expect(fields).toHaveLength(44);
  const chronicle = tables.find((table) => table.key === "chronicle")!;
  const summary = tables.find((table) => table.key === "plot_summaries")!;
  expect(
    fields.find((field) => field.tableId === chronicle.id && field.key === "plot_summary")
      ?.referenceTableId,
  ).toBe(summary.id);
  expect(fields.filter((field) => field.type === "datetime")).toHaveLength(7);
  const reader = {
    getSpace: (id: typeof fresh.id) => services.spaces.find(id),
    listTables: services.tables.list.bind(services.tables),
    listFields: services.fields.list.bind(services.fields),
  };
  const captured = await captureSpaceStructure(
    reader,
    fresh.id,
    stored.prompt,
    stored.summaryRules,
  );
  expect(captured).toEqual({
    prompt: STORY_MEMORY_PRESET.prompt,
    summaryRules: STORY_MEMORY_PRESET.summaryRules,
    tables: STORY_MEMORY_PRESET.tables,
  });
  const digest = await buildMemorySpaceTableDigest(
    {
      ...reader,
      queryRecords: async () => {
        throw new Error("不应查询记录");
      },
    },
    fresh.id,
  );
  expect(digest.prompt).toBe(STORY_MEMORY_PRESET.prompt);
  expect(digest.summaryRules).toEqual(STORY_MEMORY_PRESET.summaryRules);
  expect(digest.tables[0]!.prompt).toBe(STORY_MEMORY_PRESET.tables[0]!.prompt);
  expect(digest.tables[0]!.fields[0]!.prompt).toBe(
    STORY_MEMORY_PRESET.tables[0]!.fields[0]!.prompt,
  );
  expect(await services.tables.list(space.id)).toEqual(oldTables);
});
