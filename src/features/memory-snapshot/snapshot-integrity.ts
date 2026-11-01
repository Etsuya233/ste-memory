import { parseMemoryMacros } from "../macros/macro-expression.ts";
import type { MemorySpaceBackup } from "./snapshot.ts";
import { snapshotInvalid } from "./snapshot-errors.ts";

/** 备份文件中的各空间共用物理 ID 域；单空间来源独立建一组。 */
export interface SnapshotSeenIds {
  readonly space: Set<string>;
  readonly table: Set<string>;
  readonly field: Set<string>;
  readonly record: Set<string>;
  readonly history: Set<string>;
  readonly evidence: Set<string>;
}

export function createSnapshotSeenIds(): SnapshotSeenIds {
  return {
    space: new Set(),
    table: new Set(),
    field: new Set(),
    record: new Set(),
    history: new Set(),
    evidence: new Set(),
  };
}

/** 当前快照校验遵循所属空间 → 结构 → 内容 → 任务进度的阅读顺序。 */
export function validateSnapshotIntegrity(unit: MemorySpaceBackup, seen: SnapshotSeenIds): void {
  parseMemoryMacros(unit.space.macros);
  const spaceId = unit.space.id;
  if (seen.space.has(spaceId)) snapshotInvalid(`记忆空间 id 重复：${spaceId}`);
  seen.space.add(spaceId);
  const tableIds = validateTableOwnership(unit, seen);
  const fieldsByTable = validateFieldOwnership(unit, seen, tableIds);
  const evidenceIds = new Set<string>();
  for (const evidence of unit.evidence) {
    if (seen.evidence.has(evidence.evidence_id))
      snapshotInvalid(`证据 id 重复：${evidence.evidence_id}`);
    seen.evidence.add(evidence.evidence_id);
    evidenceIds.add(evidence.evidence_id);
  }
  validateCurrentRecords(unit, seen, tableIds, fieldsByTable, evidenceIds);
  validateArchivedRecords(unit, seen, tableIds);
  validateTaskProgress(unit);
}

function validateTableOwnership(unit: MemorySpaceBackup, seen: SnapshotSeenIds): Set<string> {
  const tableIds = new Set<string>();
  for (const table of unit.tables) {
    if (table.memorySpaceId !== unit.space.id)
      snapshotInvalid(
        `表格 ${table.id} 不属于空间 ${unit.space.id}（实际 ${table.memorySpaceId}）`,
      );
    if (seen.table.has(table.id)) snapshotInvalid(`表格 id 重复：${table.id}`);
    seen.table.add(table.id);
    tableIds.add(table.id);
  }
  return tableIds;
}

function validateFieldOwnership(
  unit: MemorySpaceBackup,
  seen: SnapshotSeenIds,
  tableIds: ReadonlySet<string>,
): Map<string, Set<string>> {
  const fieldsByTable = new Map<string, Set<string>>();
  for (const field of unit.fields) {
    if (field.memorySpaceId !== unit.space.id)
      snapshotInvalid(
        `字段 ${field.id} 不属于空间 ${unit.space.id}（实际 ${field.memorySpaceId}）`,
      );
    if (!tableIds.has(field.tableId))
      snapshotInvalid(`字段 ${field.id} 指向不存在的表格 ${field.tableId}`);
    if (field.referenceTableId !== null && !tableIds.has(field.referenceTableId))
      snapshotInvalid(`字段 ${field.id} 的引用目标表 ${field.referenceTableId} 不在单元内`);
    if (seen.field.has(field.id)) snapshotInvalid(`字段 id 重复：${field.id}`);
    seen.field.add(field.id);
    const fieldIds = fieldsByTable.get(field.tableId) ?? new Set<string>();
    fieldIds.add(field.id);
    fieldsByTable.set(field.tableId, fieldIds);
  }
  return fieldsByTable;
}

function validateCurrentRecords(
  unit: MemorySpaceBackup,
  seen: SnapshotSeenIds,
  tableIds: ReadonlySet<string>,
  fieldsByTable: ReadonlyMap<string, ReadonlySet<string>>,
  evidenceIds: ReadonlySet<string>,
): void {
  for (const record of unit.records) {
    if (record.memorySpaceId !== unit.space.id)
      snapshotInvalid(
        `记录 ${record.id} 不属于空间 ${unit.space.id}（实际 ${record.memorySpaceId}）`,
      );
    if (!tableIds.has(record.tableId))
      snapshotInvalid(`记录 ${record.id} 指向不存在的表格 ${record.tableId}`);
    if (seen.record.has(record.id)) snapshotInvalid(`记录 id 重复：${record.id}`);
    seen.record.add(record.id);
    const fieldIds = fieldsByTable.get(record.tableId);
    const unknownPayloadKey = Object.keys(record.payload).find((id) => !fieldIds?.has(id));
    if (unknownPayloadKey !== undefined)
      snapshotInvalid(`记录 ${record.id} 的字段值引用了不存在的字段 ${unknownPayloadKey}`);
    const unknownEvidenceKey = Object.keys(record.fieldEvidence).find((id) => !fieldIds?.has(id));
    if (unknownEvidenceKey !== undefined)
      snapshotInvalid(`记录 ${record.id} 的字段证据引用了不存在的字段 ${unknownEvidenceKey}`);
    const missingEvidence = Object.values(record.fieldEvidence)
      .flat()
      .find((entry) => !evidenceIds.has(entry.evidence_id));
    if (missingEvidence)
      snapshotInvalid(`记录 ${record.id} 引用了不存在的证据 ${missingEvidence.evidence_id}`);
  }
}

function validateArchivedRecords(
  unit: MemorySpaceBackup,
  seen: SnapshotSeenIds,
  tableIds: ReadonlySet<string>,
): void {
  // 历史字段由归档时的结构解释；允许过去的字段键和已经删除的 recordId。
  for (const history of unit.history) {
    if (history.memorySpaceId !== unit.space.id)
      snapshotInvalid(
        `历史记录 ${history.id} 不属于空间 ${unit.space.id}（实际 ${history.memorySpaceId}）`,
      );
    if (!tableIds.has(history.tableId))
      snapshotInvalid(`历史记录 ${history.id} 指向不存在的表格 ${history.tableId}`);
    if (seen.history.has(history.id)) snapshotInvalid(`历史记录 id 重复：${history.id}`);
    seen.history.add(history.id);
  }
}

function validateTaskProgress(unit: MemorySpaceBackup): void {
  for (const task of unit.fillTasks ?? []) {
    if (task.memorySpaceId !== unit.space.id)
      snapshotInvalid(`填表任务 ${task.runId} 不属于空间 ${unit.space.id}`);
  }
  const floors = new Set<number>();
  for (const entry of unit.floorLedger ?? []) {
    if (!Number.isInteger(entry.floor) || entry.floor < 0)
      snapshotInvalid(`楼层进度条目的楼层无效：${entry.floor}`);
    if (floors.has(entry.floor)) snapshotInvalid(`楼层进度条目重复：${entry.floor}`);
    floors.add(entry.floor);
  }
}
