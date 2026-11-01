import { copyMemoryMacros } from "../macros/macro-expression.ts";
import {
  remapMemoryTableDisplayStrategy,
  remapVectorIndexConfiguration,
  type MemoryEvidence,
  type MemoryFieldValue,
  type MemoryRecordPayload,
  type MemoryRecordId,
} from "../memory/index.ts";
import type { BackupIdFactory } from "../backup/backup-port.ts";
import type { MemorySpaceBackup } from "./snapshot.ts";
import { migrateMemorySpaceSnapshot } from "./snapshot-migration.ts";

/** 校验源快照后，一次分配新身份，再复制结构和内容；不写SQLite、文件或辅助数据。 */
export function cloneMemorySnapshot(
  unit: MemorySpaceBackup,
  ids: BackupIdFactory,
  name: string,
  at: string,
): MemorySpaceBackup {
  migrateMemorySpaceSnapshot({ version: unit.schemaVersion, snapshot: unit });
  const copy = new SnapshotIdentityCopy(unit, ids);
  return {
    schemaVersion: unit.schemaVersion,
    space: {
      ...unit.space,
      id: copy.spaceId,
      name,
      createdAt: at,
      updatedAt: at,
      macros: copyMemoryMacros(unit.space.macros, ids.macro),
    },
    ...copy.structure(),
    ...copy.content(),
  };
}

/** 一次副本转换的身份映射及字段引用规则集中在此，历史删记录身份也只分配一次。 */
class SnapshotIdentityCopy {
  readonly spaceId;
  private readonly unit: MemorySpaceBackup;
  private readonly ids: BackupIdFactory;
  private readonly tables;
  private readonly fields;
  private readonly records;
  private readonly evidence;
  private readonly definitions;
  constructor(unit: MemorySpaceBackup, ids: BackupIdFactory) {
    this.unit = unit;
    this.ids = ids;
    this.spaceId = ids.space();
    this.tables = new Map(unit.tables.map((table) => [table.id, ids.table()]));
    this.fields = new Map(unit.fields.map((field) => [field.id, ids.field()]));
    this.records = new Map<string, MemoryRecordId>(
      unit.records.map((record) => [record.id, ids.record()]),
    );
    this.evidence = new Map(unit.evidence.map((item) => [item.evidence_id, ids.evidence()]));
    this.definitions = new Map<string, MemorySpaceBackup["fields"][number]>(
      unit.fields.map((field) => [field.id, field]),
    );
  }
  structure(): Pick<MemorySpaceBackup, "tables" | "fields"> {
    return {
      tables: this.unit.tables.map((table) => ({
        ...table,
        id: this.tables.get(table.id)!,
        memorySpaceId: this.spaceId,
        displayStrategy: remapMemoryTableDisplayStrategy(table.displayStrategy, this.fields),
        vectorIndex: remapVectorIndexConfiguration(table.vectorIndex, this.fields, this.ids.group),
      })),
      fields: this.unit.fields.map((field) => ({
        ...field,
        id: this.fields.get(field.id)!,
        memorySpaceId: this.spaceId,
        tableId: this.tables.get(field.tableId)!,
        referenceTableId:
          field.referenceTableId === null ? null : this.tables.get(field.referenceTableId)!,
      })),
    };
  }
  content(): Pick<MemorySpaceBackup, "records" | "history" | "evidence"> {
    return {
      records: this.unit.records.map((record) => ({
        ...record,
        id: this.recordId(record.id),
        memorySpaceId: this.spaceId,
        tableId: this.tables.get(record.tableId)!,
        payload: this.payload(record.payload),
        fieldEvidence: this.fieldEvidence(record.fieldEvidence),
      })),
      history: this.unit.history.map((item) => ({
        ...item,
        id: this.ids.history(),
        recordId: this.recordId(item.recordId),
        memorySpaceId: this.spaceId,
        tableId: this.tables.get(item.tableId)!,
        payload: this.payload(item.payload),
        fieldEvidence: this.fieldEvidence(item.fieldEvidence),
      })),
      evidence: this.unit.evidence.map((item) => ({
        ...item,
        evidence_id: this.evidence.get(item.evidence_id)!,
      })),
    };
  }
  private recordId(oldId: string): MemoryRecordId {
    const existing = this.records.get(oldId);
    if (existing) return existing;
    const allocated = this.ids.record();
    this.records.set(oldId, allocated);
    return allocated;
  }
  private payload(old: MemoryRecordPayload): MemoryRecordPayload {
    const payload: Record<string, MemoryFieldValue> = {};
    for (const [key, value] of Object.entries(old)) {
      const field = this.definitions.get(key);
      if (!field) continue; // 历史已删除字段沿用副本投影语义，不生成悬挂的新字段身份。
      let next = value;
      if (field.type === "single_reference" && typeof value === "string")
        next = this.recordId(value);
      if (field.type === "multi_reference" && Array.isArray(value))
        next = value.map((id) => this.recordId(id));
      payload[this.fields.get(field.id)!] = next;
    }
    return payload;
  }
  private fieldEvidence(
    old: MemorySpaceBackup["records"][number]["fieldEvidence"],
  ): MemorySpaceBackup["records"][number]["fieldEvidence"] {
    const result: Record<string, MemoryEvidence[]> = {};
    for (const [key, values] of Object.entries(old)) {
      const field = this.definitions.get(key);
      if (!field) continue;
      result[this.fields.get(field.id)!] = values
        .filter((item) => this.evidence.has(item.evidence_id))
        .map((item) => ({ ...item, evidence_id: this.evidence.get(item.evidence_id)! }));
    }
    return result;
  }
}
