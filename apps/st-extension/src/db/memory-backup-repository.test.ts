import {
  createBackupFile,
  parseBackupFile,
  serializeBackupFile,
} from "@ste-memory/core/memory/export";
import type { MemoryBackupSnapshot } from "@ste-memory/core/memory/export";
import { SystemMemoryTableInstaller } from "@ste-memory/memory-host-shared";
import { describe, expect, it } from "vitest";
// 必须先于 ./database.ts 导入：dexie 在模块加载时捕获全局 indexedDB，
// fake-indexeddb 必须在它之前求值（否则 MissingAPIError）
import { createServices, createTestDatabase } from "./test-support.ts";
import type { SteMemoryDatabase } from "./database.ts";
import { DexieMemoryBackupRepository } from "./memory-backup-repository.ts";

/** 造一个带记录（含证据与修订历史）的空间。 */
async function seedDatabase(db: SteMemoryDatabase) {
  const services = createServices(db);
  const space = await services.spaces.create("会话");
  await new SystemMemoryTableInstaller(services.tables, services.fields).install(space.id);
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
    expect(unit.space).toEqual(space);
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
    await new SystemMemoryTableInstaller(services.tables, services.fields).install(other.id);
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
    await new SystemMemoryTableInstaller(services.tables, services.fields).install(other.id);
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
    await new SystemMemoryTableInstaller(services.tables, services.fields).install(other.id);
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
    let evidenceSeq = 0;
    const newSpaceId = await repo.cloneSpace(space.id, {
      space: () => `cloned-space-${++spaceSeq}` as import("@ste-memory/core/memory").MemorySpaceId,
      table: () => `cloned-table-${++tableSeq}` as import("@ste-memory/core/memory").MemoryTableId,
      field: () => `cloned-field-${++fieldSeq}` as import("@ste-memory/core/memory").MemoryFieldId,
      record: () => `cloned-record-${++recordSeq}` as import("@ste-memory/core/memory").MemoryRecordId,
      history: () => `cloned-history-${++historySeq}` as import("@ste-memory/core/memory").MemoryRecordHistoryId,
      evidence: () => `cloned-evidence-${++evidenceSeq}` as import("@ste-memory/core/memory").MemoryEvidenceId,
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
    expect(clonedUnit.tables.every((t) => !sourceUnit.tables.some((st) => st.id === t.id))).toBe(true);

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
        space: () => `fail-space-${++seq}` as import("@ste-memory/core/memory").MemorySpaceId,
        table: () => {
          const s = ++seq;
          if (s === 3) throw new Error("boom");
          return `fail-table-${s}` as import("@ste-memory/core/memory").MemoryTableId;
        },
        field: () => `fail-field-${++seq}` as import("@ste-memory/core/memory").MemoryFieldId,
        record: () => `fail-record-${++seq}` as import("@ste-memory/core/memory").MemoryRecordId,
        history: () => `fail-history-${++seq}` as import("@ste-memory/core/memory").MemoryRecordHistoryId,
        evidence: () => `fail-evidence-${++seq}` as import("@ste-memory/core/memory").MemoryEvidenceId,
      }),
    ).rejects.toThrow();

    // 整体回滚：数据库与复制前完全一致
    expect(await repo.loadSnapshot()).toEqual(before);
  });
});
