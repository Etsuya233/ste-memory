import {
  MemoryFieldService,
  type MemoryField,
  type MemoryFieldId,
  type MemoryFieldKey,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
  type MemoryTableKey,
} from "../src/memory/index.ts";
import type { MemoryFieldRepository, MemoryTableRepository } from "../src/memory/adapter.ts";

export class FieldRepository implements MemoryFieldRepository, MemoryTableRepository {
  readonly fields = new Map<MemoryFieldId, MemoryField>();
  readonly tables = new Map<MemoryTableId, MemoryTable>();

  async create(value: MemoryField | MemoryTable): Promise<void> {
    if ("tableId" in value) this.fields.set(value.id, value);
    else this.tables.set(value.id, value);
  }

  delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<boolean>;
  delete(memorySpaceId: MemorySpaceId, tableId: MemoryTableId, id: MemoryFieldId): Promise<boolean>;
  async delete(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id?: MemoryFieldId,
  ): Promise<boolean> {
    if (!id) {
      const table = this.tables.get(tableId);
      return table?.memorySpaceId === memorySpaceId ? this.tables.delete(tableId) : false;
    }
    const field = this.fields.get(id);
    return field?.memorySpaceId === memorySpaceId && field.tableId === tableId
      ? this.fields.delete(id)
      : false;
  }

  find(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<MemoryTable | undefined>;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): Promise<MemoryField | undefined>;
  async find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    fieldId?: MemoryFieldId,
  ): Promise<MemoryField | MemoryTable | undefined> {
    const value = fieldId ? this.fields.get(fieldId) : this.tables.get(tableId);
    return value?.memorySpaceId === memorySpaceId ? value : undefined;
  }

  findByKey(memorySpaceId: MemorySpaceId, key: MemoryTableKey): Promise<MemoryTable | undefined>;
  findByKey(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    key: MemoryFieldKey,
  ): Promise<MemoryField | undefined>;
  async findByKey(
    memorySpaceId: MemorySpaceId,
    tableIdOrKey: MemoryTableId | MemoryTableKey,
    fieldKey?: MemoryFieldKey,
  ): Promise<MemoryField | MemoryTable | undefined> {
    if (fieldKey !== undefined) {
      return [...this.fields.values()].find(
        (field) =>
          field.memorySpaceId === memorySpaceId &&
          field.tableId === tableIdOrKey &&
          field.key === fieldKey,
      );
    }
    return [...this.tables.values()].find(
      (table) => table.memorySpaceId === memorySpaceId && table.key === tableIdOrKey,
    );
  }

  list(memorySpaceId: MemorySpaceId): Promise<MemoryTable[]>;
  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<MemoryField[]>;
  async list(memorySpaceId: MemorySpaceId, tableId?: MemoryTableId) {
    if (tableId) {
      return [...this.fields.values()].filter(
        (field) => field.memorySpaceId === memorySpaceId && field.tableId === tableId,
      );
    }
    return [...this.tables.values()].filter((table) => table.memorySpaceId === memorySpaceId);
  }

  async update(field: MemoryField | MemoryTable): Promise<boolean> {
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
    key: "clues" as MemoryTableKey,
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
