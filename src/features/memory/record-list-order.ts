import type { MemoryField, MemoryFieldId, MemoryRecord } from "./domain/index.ts";

export interface MemoryRecordListOrder {
  readonly fieldId: MemoryFieldId | "$created_at" | "$updated_at";
  readonly direction: "asc" | "desc";
}

export const DEFAULT_RECORD_LIST_ORDER: MemoryRecordListOrder = {
  fieldId: "$created_at",
  direction: "asc",
};

export function isRecordListSortField(field: MemoryField): boolean {
  return !["short_text_list", "multi_select", "single_reference", "multi_reference"].includes(
    field.type,
  );
}

/** Sort the full matching set before paging; empty values stay last in both directions. */
export function compareRecordListRows(
  left: MemoryRecord,
  right: MemoryRecord,
  order: MemoryRecordListOrder,
): number {
  const value = (record: MemoryRecord) => {
    if (order.fieldId === "$created_at") return Date.parse(record.createdAt);
    if (order.fieldId === "$updated_at") return Date.parse(record.updatedAt);
    const stored = record.payload[order.fieldId];
    if (stored === null || stored === undefined || stored === "") return null;
    // Business date/datetime values use fixed-width, timezone-free formats.
    return stored;
  };
  const a = value(left);
  const b = value(right);
  if (a === null && b !== null) return 1;
  if (a !== null && b === null) return -1;
  const compared = a === b ? 0 : a! < b! ? -1 : 1;
  return (order.direction === "asc" ? compared : -compared) || left.id.localeCompare(right.id);
}
