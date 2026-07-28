import {
  MemoryFieldService,
  type MemoryField,
  type MemoryFieldId,
  type MemoryFieldRepository,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
  type MemoryTableRepository,
} from "../src/index.ts";

export class FieldRepository implements MemoryFieldRepository, MemoryTableRepository {
  readonly fields = new Map<MemoryFieldId, MemoryField>();
  readonly tables = new Map<MemoryTableId, MemoryTable>();

  create(value: MemoryField | MemoryTable): void {
    if ("tableId" in value) this.fields.set(value.id, value);
    else this.tables.set(value.id, value);
  }

  delete(memorySpaceId: MemorySpaceId, tableId: MemoryTableId, id: MemoryFieldId): boolean {
    const field = this.find(memorySpaceId, tableId, id);
    return field ? this.fields.delete(field.id) : false;
  }

  find(memorySpaceId: MemorySpaceId, id: MemoryTableId): MemoryTable | undefined;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): MemoryField | undefined;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    fieldId?: MemoryFieldId,
  ): MemoryField | MemoryTable | undefined {
    const value = fieldId ? this.fields.get(fieldId) : this.tables.get(tableId);
    return value?.memorySpaceId === memorySpaceId ? value : undefined;
  }

  list(memorySpaceId: MemorySpaceId, tableId?: MemoryTableId) {
    if (tableId) {
      return [...this.fields.values()].filter(
        (field) => field.memorySpaceId === memorySpaceId && field.tableId === tableId,
      );
    }
    return [...this.tables.values()].filter((table) => table.memorySpaceId === memorySpaceId);
  }

  update(field: MemoryField | MemoryTable): boolean {
    if ("tableId" in field) {
      if (!this.fields.has(field.id)) return false;
      this.fields.set(field.id, field);
      return true;
    }
    if (!this.tables.has(field.id)) return false;
    this.tables.set(field.id, field);
    return true;
  }
}

export const memorySpaceId = "space-1" as MemorySpaceId;
export const tableId = "table-1" as MemoryTableId;
export const fieldId = "field-1" as MemoryFieldId;
export const now = "2026-07-28T00:00:00.000Z";

export function fieldService(repository: FieldRepository): MemoryFieldService {
  repository.tables.set(tableId, {
    id: tableId,
    memorySpaceId,
    kind: "custom",
    name: "线索",
    description: "",
    prompt: "",
    enabled: true,
    displayStrategy: null,
    createdAt: now,
    updatedAt: now,
  });
  return new MemoryFieldService(
    repository,
    repository,
    () => fieldId,
    () => now,
  );
}
