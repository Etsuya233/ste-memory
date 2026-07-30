import type { MemoryFieldValue, MemoryRecord } from "../api/memory-records.ts";

export function formatMemoryFieldValue(
  value: MemoryFieldValue | undefined,
  emptyText: string,
  referenceRecords?: readonly MemoryRecord[],
): string {
  if (value === undefined || value === null || value === "") return emptyText;
  if (referenceRecords) {
    const recordsById = new Map(referenceRecords.map((record) => [record.id, record]));
    const recordIds = Array.isArray(value) ? value : [String(value)];
    return (
      recordIds
        .map((recordId) => {
          const target = recordsById.get(recordId);
          return target ? target.displayText || "未命名记录" : recordId;
        })
        .join(", ") || emptyText
    );
  }
  if (Array.isArray(value)) return value.join(", ") || emptyText;
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}
