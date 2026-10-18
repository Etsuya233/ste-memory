import {
  createBackupFile,
  parseBackupFile,
  serializeBackupFile,
} from "../../../features/backup/index.ts";
import type { MemoryBackupSnapshot } from "../../../features/backup/index.ts";
import type {
  MemoryEvidenceId,
  MemoryField,
  MemoryFieldId,
  MemoryRecordHistoryId,
  MemoryRecordId,
  MemorySpaceId,
  MemoryTableId,
} from "../../../features/memory/index.ts";
import { memoryTableDisplayFieldIds } from "../../../features/memory/index.ts";
import { describe, expect, it } from "vitest";
// 必须先于 ./database.ts 导入：dexie 在模块加载时捕获全局 indexedDB，
// fake-indexeddb 必须在它之前求值（否则 MissingAPIError）
import { createServices, createTestDatabase, installDefaultPreset, NOW } from "../test-support.ts";
import type { SteMemoryDatabase } from "../database.ts";
import {
  DexieFillTaskRepository,
  DexieFloorLedgerRepository,
} from "../fill-tasks/fill-task-repository.ts";
import { DexieMemoryBackupRepository } from "./memory-backup-repository.ts";

/** 克隆单元里每张表的显示策略字段 ID 必须全部落在克隆后的字段集合中（field 策略的 fieldId、template 策略的占位符）。 */
function expectStrategiesPointIntoClonedFields(
  sourceUnit: MemoryBackupSnapshot["spaces"][number],
  clonedUnit: MemoryBackupSnapshot["spaces"][number],
): void {
  const clonedFieldIds = new Set(clonedUnit.fields.map((field) => field.id));
  const sourceFieldIds = new Set(sourceUnit.fields.map((field) => field.id));
  for (const table of clonedUnit.tables) {
    if (!table.displayStrategy) continue;
    const ids = memoryTableDisplayFieldIds(table.displayStrategy);
    // 策略字段必须重映射（克隆后旧字段 ID 已不存在）；残留旧 ID = 克隆 bug
    expect(ids.every((id) => clonedFieldIds.has(id))).toBe(true);
    expect(ids.some((id) => sourceFieldIds.has(id))).toBe(false);
  }
  // field 策略显式断言一次：characters 的 name 字段被重映射
  const clonedCharacters = clonedUnit.tables.find((table) => table.key === "characters")!;
  const clonedCharactersFields = clonedUnit.fields.filter(
    (field: MemoryField) => field.tableId === clonedCharacters.id,
  );
  const sourceCharacters = sourceUnit.tables.find((table) => table.key === "characters")!;
  const sourceCharactersFields = sourceUnit.fields.filter(
    (field: MemoryField) => field.tableId === sourceCharacters.id,
  );
  const sourceNameId = sourceCharactersFields.find((field) => field.key === "name")!.id;
  const clonedNameId = clonedCharactersFields.find((field) => field.key === "name")!.id;
  expect(clonedCharacters.displayStrategy).toEqual({ type: "field", fieldId: clonedNameId });
  expect(clonedNameId).not.toBe(sourceNameId);
}

/** 造一个带记录（含证据与修订历史）的空间。 */
async function seedDatabase(db: SteMemoryDatabase) {
  const services = createServices(db);
  const space = await services.spaces.create("会话");
  await installDefaultPreset(db, space.id);
  const table = (await services.tableRepository.list(space.id)).find(
    (item) => item.key === "characters",
  )!;
  const fields = await services.fieldRepository.list(space.id, table.id);
  const name = fields.find((field) => field.name === "名称")!;
  const identity = fields.find((field) => field.name === "身份/定位")!;
  const record = await services.records.create(space.id, table.id, {
    payload: { [name.id]: "林夏", [identity.id]: "调查员" },
    fieldEvidence: {
      [name.id]: [
        {
          source_type: "message",
          source_id: 42,
          storage_mode: "snapshot",
          content: "「我叫林夏。」",
        },
      ],
    },
  });
  // 一次修订：产生一条历史记录（修订批次归档旧状态）
  await services.records.update(space.id, table.id, record!.id, {
    expectedRevisionId: record!.revisionId,
    patch: { [identity.id]: "调查员/线人" },
    revisionSource: "user",
  });
  return { services, space, table, fields, record, name, identity };
}

describe("Dexie memory backup repository", () => {
  it("loadSnapshot 返回按空间分组、排序确定的全库数据", async () => {
    const db = createTestDatabase();
    const { services, space, table, record, name, identity } = await seedDatabase(db);
    const repo = new DexieMemoryBackupRepository(db);

    const snapshot = await repo.loadSnapshot();
    expect(snapshot.spaces).toHaveLength(1);
    const unit = snapshot.spaces[0]!;
    // 空间行原样序列化：含表格预设写入的初始化来源
    expect(unit.space).toEqual(await services.spaces.find(space.id));
    expect(unit.space.initializationSource).toMatchObject({ presetId: "systemDefault" });
    expect(unit.tables.map((item) => item.id)).toContain(table.id);
    expect(unit.tables).toHaveLength((await services.tableRepository.list(space.id)).length);
    // 单元内字段：包含字符表字段，且全部归属单元内表格
    const tableIds = new Set(unit.tables.map((item) => item.id));
    expect(unit.fields.map((item) => item.id)).toContain(name.id);
    expect(unit.fields.map((item) => item.id)).toContain(identity.id);
    expect(unit.fields.every((item) => tableIds.has(item.tableId))).toBe(true);
    expect(unit.records.map((item) => item.id)).toEqual([record!.id]);
    // 记录携带字段证据；历史记录保留修订批次
    expect(unit.records[0]!.fieldEvidence).not.toEqual({});
    expect(unit.history).toHaveLength(1);
    expect(unit.evidence.map((item) => item.evidence_id)).toHaveLength(1);
  });

  it("loadSnapshot 把证据行还原为领域对象（evidence_id / 无 memorySpaceId）", async () => {
    const db = createTestDatabase();
    await seedDatabase(db);
    const repo = new DexieMemoryBackupRepository(db);

    const snapshot = await repo.loadSnapshot();
    const evidence = snapshot.spaces[0]!.evidence[0]!;
    expect(evidence).toMatchObject({
      evidence_id: expect.any(String),
      source_type: "message",
      source_id: 42,
      storage_mode: "snapshot",
      content: "「我叫林夏。」",
    });
    expect("memorySpaceId" in evidence).toBe(false);
    expect("id" in evidence).toBe(false);
  });

  it("多空间时各自带回自己的表格与记录", async () => {
    const db = createTestDatabase();
    const { services } = await seedDatabase(db);
    const other = await services.spaces.create("另一会话");
    await installDefaultPreset(services.db, other.id);
    const repo = new DexieMemoryBackupRepository(db);

    const snapshot = await repo.loadSnapshot();
    expect(snapshot.spaces).toHaveLength(2);
    for (const unit of snapshot.spaces) {
      expect(unit.tables.every((table) => table.memorySpaceId === unit.space.id)).toBe(true);
      expect(unit.fields.every((field) => field.memorySpaceId === unit.space.id)).toBe(true);
      expect(unit.records.every((record) => record.memorySpaceId === unit.space.id)).toBe(true);
      expect(unit.evidence.every((evidence) => evidence.evidence_id.length > 0)).toBe(true);
    }
  });

  it("导出 → 导入到新库 → 数据一致（含记录/修订/证据）", async () => {
    const db1 = createTestDatabase();
    await seedDatabase(db1);
    const repo1 = new DexieMemoryBackupRepository(db1);

    // 全链路：快照 → 信封 → JSON → 解析 → 还原到全新库
    const file = createBackupFile(await repo1.loadSnapshot(), "0.2.0", "2026-08-05T10:00:00.000Z");
    const text = serializeBackupFile(file);
    const decoded = parseBackupFile(text);

    const db2 = createTestDatabase();
    const repo2 = new DexieMemoryBackupRepository(db2);
    await repo2.restoreSnapshot(decoded.data);

    expect(await repo2.loadSnapshot()).toEqual(await repo1.loadSnapshot());
  });

  it("restoreSnapshot 整体替换现有数据（旧内容被清空）", async () => {
    const db = createTestDatabase();
    await seedDatabase(db);
    const repo = new DexieMemoryBackupRepository(db);
    const snapshot = await repo.loadSnapshot();

    await repo.restoreSnapshot({
      spaces: [
        {
          space: snapshot.spaces[0]!.space,
          tables: [],
          fields: [],
          records: [],
          history: [],
          evidence: [],
        },
      ],
    });

    const after = await repo.loadSnapshot();
    expect(after.spaces).toHaveLength(1);
    expect(after.spaces[0]!.tables).toEqual([]);
    expect(after.spaces[0]!.records).toEqual([]);
    expect(after.spaces[0]!.history).toEqual([]);
  });

  it("restoreSpace 只替换目标空间：其他空间六表数据不受影响", async () => {
    const db = createTestDatabase();
    const { services, space } = await seedDatabase(db);
    const other = await services.spaces.create("另一会话");
    await installDefaultPreset(services.db, other.id);
    const repo = new DexieMemoryBackupRepository(db);

    const before = await repo.loadSnapshot();
    const otherUnit = before.spaces.find((unit) => unit.space.id === other.id)!;

    // 目标空间整体替换为空结构（只有空间行）——镜像恢复的语义
    await repo.restoreSpace({
      ...before.spaces.find((unit) => unit.space.id === space.id)!,
      tables: [],
      fields: [],
      records: [],
      history: [],
      evidence: [],
    });

    const after = await repo.loadSnapshot();
    expect(after.spaces).toHaveLength(2);
    const afterTarget = after.spaces.find((unit) => unit.space.id === space.id)!;
    expect(afterTarget.tables).toEqual([]);
    expect(afterTarget.records).toEqual([]);
    expect(afterTarget.history).toEqual([]);
    expect(afterTarget.evidence).toEqual([]);
    // 其他空间完全不受影响
    expect(after.spaces.find((unit) => unit.space.id === other.id)).toEqual(otherUnit);
  });

  it("restoreSpace 恢复完整单元（含记录/历史/证据）后与快照一致", async () => {
    const db = createTestDatabase();
    await seedDatabase(db);
    const repo = new DexieMemoryBackupRepository(db);
    const unit = (await repo.loadSnapshot()).spaces[0]!;

    // 先破坏（清空该空间），再整体恢复
    await repo.restoreSpace({
      ...unit,
      tables: [],
      fields: [],
      records: [],
      history: [],
      evidence: [],
    });
    expect((await repo.loadSnapshot()).spaces[0]!.records).toEqual([]);

    await repo.restoreSpace(unit);
    expect(await repo.loadSnapshot()).toEqual({ spaces: [unit] });
  });

  it("restoreSpace 失败时原子回滚（不产生半恢复状态，其他空间不受伤）", async () => {
    const db = createTestDatabase();
    const { services, space } = await seedDatabase(db);
    const other = await services.spaces.create("另一会话");
    await installDefaultPreset(services.db, other.id);
    const repo = new DexieMemoryBackupRepository(db);
    const before = await repo.loadSnapshot();
    const target = before.spaces.find((unit) => unit.space.id === space.id)!;

    // 绕过 codec 校验的损坏单元：同一条记录出现两次（id 撞主键）
    const corrupt = { ...target, records: [target.records[0]!, target.records[0]!] };
    await expect(repo.restoreSpace(corrupt)).rejects.toThrow();

    // 整体回滚：数据库与恢复前完全一致（无半恢复残留）
    expect(await repo.loadSnapshot()).toEqual(before);
  });

  it("restoreSnapshot 失败时原子回滚（不产生半导入状态）", async () => {
    const db = createTestDatabase();
    await seedDatabase(db);
    const repo = new DexieMemoryBackupRepository(db);
    const before = await repo.loadSnapshot();

    // 绕过 codec 校验的损坏快照：同一条记录出现两次（id 撞主键）
    const corrupt: MemoryBackupSnapshot = {
      spaces: [
        {
          ...before.spaces[0]!,
          records: [before.spaces[0]!.records[0]!, before.spaces[0]!.records[0]!],
        },
      ],
    };
    await expect(repo.restoreSnapshot(corrupt)).rejects.toThrow();

    // 整体回滚：数据库与导入前完全一致（无半导入残留）
    expect(await repo.loadSnapshot()).toEqual(before);
  });

  it("任务与楼层进度随单元携带：快照读取、按空间恢复、缺省不涉及（spec 表格预设 6.3）", async () => {
    const db = createTestDatabase();
    const { space } = await seedDatabase(db);
    const tasks = new DexieFillTaskRepository(db, () => NOW);
    const ledger = new DexieFloorLedgerRepository(db, () => NOW);
    await tasks.create({
      runId: "run-1",
      memorySpaceId: space.id,
      from: 0,
      to: 3,
      blockSize: 20,
      kind: "floor",
      initText: null,
      chatId: "story",
      status: "succeeded",
      errorMessage: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ledger.markProcessed(space.id, [0, 1]);

    const repo = new DexieMemoryBackupRepository(db);
    const snapshot = await repo.loadSnapshot();
    const unit = snapshot.spaces[0]!;
    // 快照带上任务与进度（导出即包含，供恢复）
    expect(unit.fillTasks?.map((task) => task.runId)).toEqual(["run-1"]);
    expect(unit.floorLedger).toEqual([
      { floor: 0, status: "processed", updatedAt: NOW },
      { floor: 1, status: "processed", updatedAt: NOW },
    ]);

    // 单元带任务/进度 → 恢复时替换该空间的对应行
    await tasks.clear(space.id);
    await ledger.clear(space.id);
    await repo.restoreSpace(unit);
    expect((await tasks.listRecent(space.id, 10)).map((task) => task.runId)).toEqual(["run-1"]);
    expect(await ledger.processedCount(space.id, 0, 3)).toBe(2);

    // 缺省（镜像与旧文件形态）→ 保持目标原有任务与进度
    const { fillTasks, floorLedger, ...withoutRuntimeRows } = unit;
    expect(fillTasks).toBeDefined();
    expect(floorLedger).toBeDefined();
    await repo.restoreSpace(withoutRuntimeRows);
    expect((await tasks.listRecent(space.id, 10)).map((task) => task.runId)).toEqual(["run-1"]);
    expect(await ledger.processedCount(space.id, 0, 3)).toBe(2);
  });

  it("cloneSpace 克隆任务与进度：任务换新 runId、进度归属新空间（不与源空间相撞）", async () => {
    const db = createTestDatabase();
    const { space } = await seedDatabase(db);
    const tasks = new DexieFillTaskRepository(db, () => NOW);
    const ledger = new DexieFloorLedgerRepository(db, () => NOW);
    await tasks.create({
      runId: "run-1",
      memorySpaceId: space.id,
      from: 0,
      to: 3,
      blockSize: 20,
      kind: "floor",
      initText: null,
      chatId: "story",
      status: "failed",
      errorMessage: "boom",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ledger.markError(space.id, [2]);

    const repo = new DexieMemoryBackupRepository(db);
    let seq = 0;
    const newSpaceId = await repo.cloneSpace(space.id, {
      space: () => `cloned-space-${++seq}` as MemorySpaceId,
      table: () => `cloned-table-${++seq}` as MemoryTableId,
      field: () => `cloned-field-${++seq}` as MemoryFieldId,
      record: () => `cloned-record-${++seq}` as MemoryRecordId,
      history: () => `cloned-history-${++seq}` as MemoryRecordHistoryId,
      task: () => `cloned-task-${++seq}`,
      evidence: () => `cloned-evidence-${++seq}` as MemoryEvidenceId,
    });

    const clonedTasks = await tasks.listRecent(newSpaceId, 10);
    expect(clonedTasks).toHaveLength(1);
    expect(clonedTasks[0]!.runId).not.toBe("run-1");
    expect(clonedTasks[0]!.memorySpaceId).toBe(newSpaceId);
    expect(clonedTasks[0]).toMatchObject({ status: "failed", errorMessage: "boom" });
    expect(await ledger.statuses(newSpaceId, 0, 3)).toEqual([
      { floor: 0, status: "untracked" },
      { floor: 1, status: "untracked" },
      { floor: 2, status: "error" },
      { floor: 3, status: "untracked" },
    ]);
    // 源空间任务原样保留
    expect((await tasks.listRecent(space.id, 10)).map((task) => task.runId)).toEqual(["run-1"]);
  });

  it("cloneSpace 全量复制 + ID 重生成 + 外键重映射", async () => {
    const db = createTestDatabase();
    const { space } = await seedDatabase(db);
    const repo = new DexieMemoryBackupRepository(db);
    const before = await repo.loadSnapshot();
    const sourceUnit = before.spaces[0]!;

    let spaceSeq = 0;
    let tableSeq = 0;
    let fieldSeq = 0;
    let recordSeq = 0;
    let historySeq = 0;
    let taskSeq = 0;
    let evidenceSeq = 0;
    const newSpaceId = await repo.cloneSpace(space.id, {
      space: () => `cloned-space-${++spaceSeq}` as MemorySpaceId,
      table: () => `cloned-table-${++tableSeq}` as MemoryTableId,
      field: () => `cloned-field-${++fieldSeq}` as MemoryFieldId,
      record: () => `cloned-record-${++recordSeq}` as MemoryRecordId,
      history: () => `cloned-history-${++historySeq}` as MemoryRecordHistoryId,
      task: () => `cloned-task-${++taskSeq}`,
      evidence: () => `cloned-evidence-${++evidenceSeq}` as MemoryEvidenceId,
    });

    const after = await repo.loadSnapshot();
    expect(after.spaces).toHaveLength(2);
    const clonedUnit = after.spaces.find((u) => u.space.id === newSpaceId)!;
    expect(clonedUnit).toBeDefined();

    // 新空间 ID 与原空间不同
    expect(newSpaceId).not.toBe(space.id);

    // 表格数量相同，且所有表格的 memorySpaceId 指向新空间
    expect(clonedUnit.tables).toHaveLength(sourceUnit.tables.length);
    expect(clonedUnit.tables.every((t) => t.memorySpaceId === newSpaceId)).toBe(true);
    expect(clonedUnit.tables.every((t) => !sourceUnit.tables.some((st) => st.id === t.id))).toBe(
      true,
    );

    // 字段外键重映射
    expect(clonedUnit.fields).toHaveLength(sourceUnit.fields.length);
    expect(clonedUnit.fields.every((f) => f.memorySpaceId === newSpaceId)).toBe(true);
    const clonedTableIds = new Set(clonedUnit.tables.map((t) => t.id));
    expect(clonedUnit.fields.every((f) => clonedTableIds.has(f.tableId))).toBe(true);

    // 记录外键重映射
    expect(clonedUnit.records).toHaveLength(sourceUnit.records.length);
    expect(clonedUnit.records.every((r) => r.memorySpaceId === newSpaceId)).toBe(true);

    // 历史记录外键重映射
    expect(clonedUnit.history).toHaveLength(sourceUnit.history.length);
    expect(clonedUnit.history.every((h) => h.memorySpaceId === newSpaceId)).toBe(true);
    const clonedRecordIds = new Set(clonedUnit.records.map((r) => r.id));
    expect(clonedUnit.history.every((h) => clonedRecordIds.has(h.recordId))).toBe(true);

    // 证据外键重映射
    expect(clonedUnit.evidence).toHaveLength(sourceUnit.evidence.length);

    // 显示策略重映射（field 策略 + template 占位符指向克隆后的字段 ID）
    expectStrategiesPointIntoClonedFields(sourceUnit, clonedUnit);
  });

  it("cloneSpace 失败时原子回滚（无半复制状态）", async () => {
    const db = createTestDatabase();
    const { space } = await seedDatabase(db);
    const repo = new DexieMemoryBackupRepository(db);
    const before = await repo.loadSnapshot();

    let seq = 0;
    // table 工厂在第三次调用时抛错，导致事务回滚
    await expect(
      repo.cloneSpace(space.id, {
        space: () => `fail-space-${++seq}` as MemorySpaceId,
        table: () => {
          const s = ++seq;
          if (s === 3) throw new Error("boom");
          return `fail-table-${s}` as MemoryTableId;
        },
        field: () => `fail-field-${++seq}` as MemoryFieldId,
        record: () => `fail-record-${++seq}` as MemoryRecordId,
        history: () => `fail-history-${++seq}` as MemoryRecordHistoryId,
        task: () => `cloned-task-${++seq}`,
        evidence: () => `fail-evidence-${++seq}` as MemoryEvidenceId,
      }),
    ).rejects.toThrow();

    // 整体回滚：数据库与复制前完全一致
    expect(await repo.loadSnapshot()).toEqual(before);
  });

  it("cloneSpaceFromUnit 克隆备份单元为全新空间（数据库里无源空间，issue 26）", async () => {
    const db = createTestDatabase();
    await seedDatabase(db);
    const repo = new DexieMemoryBackupRepository(db);
    const before = await repo.loadSnapshot();
    const sourceUnit = before.spaces[0]!;

    let spaceSeq = 0;
    let tableSeq = 0;
    let fieldSeq = 0;
    let recordSeq = 0;
    let historySeq = 0;
    let taskSeq = 0;
    let evidenceSeq = 0;
    const newSpaceId = await repo.cloneSpaceFromUnit(sourceUnit, {
      space: () => `cloned-unit-space-${++spaceSeq}` as MemorySpaceId,
      table: () => `cloned-unit-table-${++tableSeq}` as MemoryTableId,
      field: () => `cloned-unit-field-${++fieldSeq}` as MemoryFieldId,
      record: () => `cloned-unit-record-${++recordSeq}` as MemoryRecordId,
      history: () => `cloned-unit-history-${++historySeq}` as MemoryRecordHistoryId,
      task: () => `cloned-task-${++taskSeq}`,
      evidence: () => `cloned-unit-evidence-${++evidenceSeq}` as MemoryEvidenceId,
    });

    const after = await repo.loadSnapshot();
    // 源空间原样保留（cloneSpaceFromUnit 不动源数据，符合 ADR 0012「保留原空间」）
    expect(after.spaces).toHaveLength(2);
    expect(after.spaces.find((u) => u.space.id === sourceUnit.space.id)).toEqual(sourceUnit);
    const clonedUnit = after.spaces.find((u) => u.space.id === newSpaceId)!;
    expect(clonedUnit).toBeDefined();
    expect(newSpaceId).not.toBe(sourceUnit.space.id);

    // 全部实体新 ID（与源无交集），外键重映射指向新空间
    expect(clonedUnit.tables).toHaveLength(sourceUnit.tables.length);
    expect(clonedUnit.fields).toHaveLength(sourceUnit.fields.length);
    expect(clonedUnit.records).toHaveLength(sourceUnit.records.length);
    expect(clonedUnit.history).toHaveLength(sourceUnit.history.length);
    expect(clonedUnit.evidence).toHaveLength(sourceUnit.evidence.length);
    const allClonedIds = [
      ...clonedUnit.tables.map((t) => t.id),
      ...clonedUnit.fields.map((f) => f.id),
      ...clonedUnit.records.map((r) => r.id),
      ...clonedUnit.history.map((h) => h.id),
    ];
    const sourceIds = [
      ...sourceUnit.tables.map((t) => t.id),
      ...sourceUnit.fields.map((f) => f.id),
      ...sourceUnit.records.map((r) => r.id),
      ...sourceUnit.history.map((h) => h.id),
    ];
    expect(allClonedIds.some((id) => sourceIds.includes(id))).toBe(false);
    expect(clonedUnit.tables.every((t) => t.memorySpaceId === newSpaceId)).toBe(true);
    expect(clonedUnit.fields.every((f) => f.memorySpaceId === newSpaceId)).toBe(true);
    expect(clonedUnit.records.every((r) => r.memorySpaceId === newSpaceId)).toBe(true);
    expect(clonedUnit.history.every((h) => h.memorySpaceId === newSpaceId)).toBe(true);
    const clonedTableIds = new Set(clonedUnit.tables.map((t) => t.id));
    expect(clonedUnit.fields.every((f) => clonedTableIds.has(f.tableId))).toBe(true);
    const clonedRecordIds = new Set(clonedUnit.records.map((r) => r.id));
    expect(clonedUnit.history.every((h) => clonedRecordIds.has(h.recordId))).toBe(true);

    // 显示策略重映射（导入同克隆：字段全新 ID，策略必须跟着重映射）
    expectStrategiesPointIntoClonedFields(sourceUnit, clonedUnit);
  });

  it("cloneSpaceFromUnit 失败时原子回滚（无半复制状态）", async () => {
    const db = createTestDatabase();
    await seedDatabase(db);
    const repo = new DexieMemoryBackupRepository(db);
    const before = await repo.loadSnapshot();
    const sourceUnit = before.spaces[0]!;

    let seq = 0;
    await expect(
      repo.cloneSpaceFromUnit(sourceUnit, {
        space: () => `fail-unit-space-${++seq}` as MemorySpaceId,
        table: () => {
          const s = ++seq;
          if (s === 3) throw new Error("boom");
          return `fail-unit-table-${s}` as MemoryTableId;
        },
        field: () => `fail-unit-field-${++seq}` as MemoryFieldId,
        record: () => `fail-unit-record-${++seq}` as MemoryRecordId,
        history: () => `fail-unit-history-${++seq}` as MemoryRecordHistoryId,
        task: () => `cloned-task-${++seq}`,
        evidence: () => `fail-unit-evidence-${++seq}` as MemoryEvidenceId,
      }),
    ).rejects.toThrow();

    // 整体回滚：数据库与复制前完全一致
    expect(await repo.loadSnapshot()).toEqual(before);
  });

  it("克隆完整重映射 payload 字段键/引用、字段证据键与证据引用，且已删记录的归档历史保留记录归属", async () => {
    const db = createTestDatabase();
    const { services, space, name, identity, record, table } = await seedDatabase(db);

    // 创建 → 更新 → 删除一条记录：留下两条 recordId 指向已删记录的归档历史（合法遗留）
    const doomed = (await services.records.create(space.id, table.id, {
      payload: { [name.id]: "临时记录" },
    }))!;
    const doomedUpdated = (await services.records.update(space.id, table.id, doomed.id, {
      expectedRevisionId: doomed.revisionId,
      patch: { [identity.id]: "临时身份" },
      revisionSource: "user",
    }))!;
    await services.records.delete(space.id, table.id, doomed.id, doomedUpdated.revisionId, "user");

    // 一条带引用字段的记录（single_reference → 现存记录）：克隆后引用必须指向克隆后的目标 ID
    const relationships = (await services.tableRepository.list(space.id)).find(
      (item) => item.key === "relationships",
    )!;
    const relationshipFields = await services.fieldRepository.list(space.id, relationships.id);
    const characterA = relationshipFields.find((field) => field.key === "character_a")!;
    const characterB = relationshipFields.find((field) => field.key === "character_b")!;
    await services.records.create(space.id, relationships.id, {
      payload: { [characterA.id]: record!.id, [characterB.id]: record!.id },
    });

    const repo = new DexieMemoryBackupRepository(db);
    let seq = 0;
    const newSpaceId = await repo.cloneSpace(space.id, {
      space: () => `cloned-space-${++seq}` as MemorySpaceId,
      table: () => `cloned-table-${++seq}` as MemoryTableId,
      field: () => `cloned-field-${++seq}` as MemoryFieldId,
      record: () => `cloned-record-${++seq}` as MemoryRecordId,
      history: () => `cloned-history-${++seq}` as MemoryRecordHistoryId,
      task: () => `cloned-task-${++seq}`,
      evidence: () => `cloned-evidence-${++seq}` as MemoryEvidenceId,
    });
    const clonedUnit = (await repo.loadSnapshot()).spaces.find(
      (unit) => unit.space.id === newSpaceId,
    )!;

    // 已删记录的归档历史：归属是可用字符串（绝不 undefined）、共享同一个全新身份、不引用源空间 ID
    const clonedRecordIds = new Set(clonedUnit.records.map((item) => item.id));
    const orphanHistory = clonedUnit.history.filter((item) => !clonedRecordIds.has(item.recordId));
    expect(orphanHistory).toHaveLength(2);
    expect(new Set(orphanHistory.map((item) => item.recordId)).size).toBe(1);
    expect(
      orphanHistory.every((item) => typeof item.recordId === "string" && item.recordId !== ""),
    ).toBe(true);
    expect(orphanHistory.some((item) => item.recordId === doomed.id)).toBe(false);

    // 字段证据键必须落在克隆字段集内；证据引用必须落在克隆证据行内；历史 payload 键同理
    const clonedFieldIdsByTable = new Map<string, Set<string>>();
    for (const field of clonedUnit.fields) {
      const bucket = clonedFieldIdsByTable.get(field.tableId) ?? new Set<string>();
      bucket.add(field.id);
      clonedFieldIdsByTable.set(field.tableId, bucket);
    }
    const clonedEvidenceIds = new Set(clonedUnit.evidence.map((item) => item.evidence_id));
    for (const row of [...clonedUnit.records, ...clonedUnit.history]) {
      const fieldIds = clonedFieldIdsByTable.get(row.tableId) ?? new Set<string>();
      for (const [fieldId, entries] of Object.entries(row.fieldEvidence)) {
        expect(fieldIds.has(fieldId)).toBe(true);
        expect(entries.every((entry) => clonedEvidenceIds.has(entry.evidence_id))).toBe(true);
      }
      expect(Object.keys(row.payload).every((fieldId) => fieldIds.has(fieldId))).toBe(true);
    }

    // 存活记录：证据挂到克隆后的字段 ID，且引用克隆后的证据行
    const clonedCharacters = clonedUnit.tables.find((item) => item.key === "characters")!;
    const clonedName = clonedUnit.fields.find(
      (field) => field.tableId === clonedCharacters.id && field.key === "name",
    )!;
    const clonedRole = clonedUnit.fields.find(
      (field) => field.tableId === clonedCharacters.id && field.key === "role",
    )!;
    const clonedCharacter = clonedUnit.records.find(
      (item) => item.tableId === clonedCharacters.id,
    )!;
    expect(Object.keys(clonedCharacter.fieldEvidence)).toEqual([clonedName.id, clonedRole.id]);
    expect(clonedCharacter.fieldEvidence[clonedName.id]![0]!.evidence_id).toBe(
      clonedUnit.evidence[0]!.evidence_id,
    );

    // payload 引用值：关系记录的两个引用都指向克隆后的记录 ID
    const clonedRelationships = clonedUnit.tables.find((item) => item.key === "relationships")!;
    const clonedRelationshipFields = clonedUnit.fields.filter(
      (field) => field.tableId === clonedRelationships.id,
    );
    const clonedCharacterA = clonedRelationshipFields.find((field) => field.key === "character_a")!;
    const clonedCharacterB = clonedRelationshipFields.find((field) => field.key === "character_b")!;
    const clonedRelationship = clonedUnit.records.find(
      (item) => item.tableId === clonedRelationships.id,
    )!;
    expect(clonedRelationship.payload[clonedCharacterA.id]).toBe(clonedCharacter.id);
    expect(clonedRelationship.payload[clonedCharacterB.id]).toBe(clonedCharacter.id);

    // 克隆单元必须直接通过备份文件编解码（导出即可被导入的结构与完整性校验接受）
    const text = serializeBackupFile(
      createBackupFile({ spaces: [clonedUnit] }, "test", "2026-07-28T00:00:00.000Z"),
    );
    expect(() => parseBackupFile(text)).not.toThrow();
  });

  it("克隆带旧版损坏残留的空间（缺 recordId 的历史 / 悬挂字段证据键）产出干净单元", async () => {
    const db = createTestDatabase();
    await seedDatabase(db);
    const repo = new DexieMemoryBackupRepository(db);
    const unit = (await repo.loadSnapshot()).spaces[0]!;

    // 模拟旧版克隆留在库里的损坏形态：历史行缺 recordId（undefined）+ 字段证据键指向不存在的字段
    const poisoned: MemoryBackupSnapshot = {
      spaces: [
        {
          ...unit,
          history: [
            {
              ...unit.history[0]!,
              id: "poisoned-history" as MemoryRecordHistoryId,
              recordId: undefined as unknown as MemoryRecordId,
            },
            ...unit.history,
          ],
          records: unit.records.map((record) => ({
            ...record,
            fieldEvidence: { ...record.fieldEvidence, ["ghost-field" as MemoryFieldId]: [] },
          })),
        },
      ],
    };
    await repo.restoreSpace(poisoned.spaces[0]!);

    // 先确认这份库数据确实是坏的：直接导出通不过导入校验（旧版克隆的产物形态）
    const poisonedText = serializeBackupFile(
      createBackupFile(
        { spaces: [(await repo.loadSnapshot()).spaces[0]!] },
        "test",
        "2026-07-28T00:00:00.000Z",
      ),
    );
    expect(() => parseBackupFile(poisonedText)).toThrow();

    // 再克隆一次：缺 recordId 的历史补全新归属、悬挂字段证据键丢弃 → 产出干净单元
    let seq = 0;
    const newSpaceId = await repo.cloneSpace(unit.space.id, {
      space: () => `repaired-space-${++seq}` as MemorySpaceId,
      table: () => `repaired-table-${++seq}` as MemoryTableId,
      field: () => `repaired-field-${++seq}` as MemoryFieldId,
      record: () => `repaired-record-${++seq}` as MemoryRecordId,
      history: () => `repaired-history-${++seq}` as MemoryRecordHistoryId,
      task: () => `cloned-task-${++seq}`,
      evidence: () => `repaired-evidence-${++seq}` as MemoryEvidenceId,
    });
    const clonedUnit = (await repo.loadSnapshot()).spaces.find(
      (space) => space.space.id === newSpaceId,
    )!;

    const clonedRecordIds = new Set(clonedUnit.records.map((item) => item.id));
    expect(
      clonedUnit.history.every((item) => typeof item.recordId === "string" && item.recordId !== ""),
    ).toBe(true);
    // 缺 recordId 的那条历史拿到全新归属（不属于任何克隆记录），存活记录的归档历史仍归其名下
    expect(clonedUnit.history.filter((item) => !clonedRecordIds.has(item.recordId))).toHaveLength(
      1,
    );
    const clonedFieldIds = new Set<string>(clonedUnit.fields.map((field) => field.id));
    expect(
      [...clonedUnit.records, ...clonedUnit.history].every((row) =>
        Object.keys(row.fieldEvidence).every((fieldId) => clonedFieldIds.has(fieldId)),
      ),
    ).toBe(true);

    const repairedText = serializeBackupFile(
      createBackupFile({ spaces: [clonedUnit] }, "test", "2026-07-28T00:00:00.000Z"),
    );
    expect(() => parseBackupFile(repairedText)).not.toThrow();
  });
});
