import type { MemoryFieldValue } from "../api/memory-records.ts";

export function formatMemoryFieldValue(
  value: MemoryFieldValue | undefined,
  emptyText: string,
): string {
  if (value === undefined || value === null || value === "") return emptyText;
  if (Array.isArray(value)) return value.join(", ") || emptyText;
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}
