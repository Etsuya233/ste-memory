import {
  DEFAULT_RECORD_LIST_ORDER,
  isRecordListSortField,
  type MemoryField,
  type MemoryRecordListOrder,
} from "../../../features/memory/index.ts";

export function recordSortOptions(fields: readonly MemoryField[]) {
  return [
    { fieldId: "$created_at" as const, label: "创建时间" },
    { fieldId: "$updated_at" as const, label: "更新时间" },
    ...fields.filter(isRecordListSortField).map((field) => ({
      fieldId: field.id,
      label: field.name,
    })),
  ];
}

function storageKey(spaceId: string, tableId: string): string {
  return `ste-memory:record-sort:v1:${JSON.stringify([spaceId, tableId])}`;
}

/** A removed or newly unsortable field also removes its saved preference. */
export function loadRecordSort(
  spaceId: string,
  tableId: string,
  fields: readonly MemoryField[],
  storage: Pick<Storage, "getItem" | "removeItem"> = localStorage,
): MemoryRecordListOrder {
  const key = storageKey(spaceId, tableId);
  const saved = storage.getItem(key);
  if (saved === null) return DEFAULT_RECORD_LIST_ORDER;
  const order = JSON.parse(saved) as MemoryRecordListOrder;
  if (recordSortOptions(fields).some((option) => option.fieldId === order.fieldId)) return order;
  storage.removeItem(key);
  return DEFAULT_RECORD_LIST_ORDER;
}

export function saveRecordSort(
  spaceId: string,
  tableId: string,
  order: MemoryRecordListOrder,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(storageKey(spaceId, tableId), JSON.stringify(order));
}

export function nextRecordSort(
  current: MemoryRecordListOrder,
  fieldId: MemoryRecordListOrder["fieldId"],
): MemoryRecordListOrder {
  return {
    fieldId,
    direction: current.fieldId === fieldId && current.direction === "asc" ? "desc" : "asc",
  };
}
