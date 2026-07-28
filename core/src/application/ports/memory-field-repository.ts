import type {
  MemoryField,
  MemoryFieldId,
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
  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): MemoryField[];
  update(field: MemoryField): boolean;
}
