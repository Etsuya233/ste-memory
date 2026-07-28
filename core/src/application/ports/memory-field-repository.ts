import type {
  MemoryField,
  MemoryFieldId,
  MemoryFieldKey,
  MemorySpaceId,
  MemoryTableId,
} from "../../domain/index.ts";

export interface MemoryFieldRepository {
  create(field: MemoryField): void;
  delete(memorySpaceId: MemorySpaceId, tableId: MemoryTableId, id: MemoryFieldId): boolean;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): MemoryField | undefined;
  findByKey(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    key: MemoryFieldKey,
  ): MemoryField | undefined;
  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): MemoryField[];
  update(field: MemoryField): boolean;
}
