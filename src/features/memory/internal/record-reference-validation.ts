import {
  DomainError,
  type MemoryField,
  type MemoryFieldId,
  type MemoryRecord,
  type MemoryRecordId,
  type MemoryRecordPayload,
  type MemoryTableId,
} from "../domain/index.ts";

export interface MemoryRecordReferenceLocation {
  readonly tableId: MemoryTableId;
  readonly recordId: MemoryRecordId;
  readonly fieldId: MemoryFieldId;
}

export async function validateMemoryRecordReferences(
  fields: readonly MemoryField[],
  payload: MemoryRecordPayload,
  findTarget: (
    tableId: MemoryTableId,
    recordId: MemoryRecordId,
  ) => Promise<MemoryRecord | undefined>,
): Promise<void> {
  for (const field of fields) {
    if (!field.referenceTableId) continue;
    const value = payload[field.id];
    const recordIds = Array.isArray(value)
      ? value
      : value === null || value === undefined
        ? []
        : [value];
    const targets = await Promise.all(
      recordIds.map((recordId) =>
        typeof recordId === "string"
          ? findTarget(field.referenceTableId!, recordId as MemoryRecordId)
          : undefined,
      ),
    );
    if (targets.some((target) => !target)) {
      throw new DomainError({
        type: "memory_record_reference_invalid",
        param: { fieldId: field.id },
        humanMsg: `字段“${field.name}”引用的记录不存在于目标表格`,
      });
    }
  }
}

export function findMemoryRecordReferenceLocations(
  records: readonly MemoryRecord[],
  fieldsByTable: ReadonlyMap<MemoryTableId, readonly MemoryField[]>,
  targetTableId: MemoryTableId,
  targetRecordId: MemoryRecordId,
): readonly MemoryRecordReferenceLocation[] {
  const locations: MemoryRecordReferenceLocation[] = [];
  for (const record of records) {
    for (const field of fieldsByTable.get(record.tableId)!) {
      if (field.referenceTableId !== targetTableId) continue;
      const value = record.payload[field.id];
      if (value === targetRecordId || (Array.isArray(value) && value.includes(targetRecordId))) {
        locations.push({ tableId: record.tableId, recordId: record.id, fieldId: field.id });
      }
    }
  }
  return locations;
}
