import type {
  MemoryField,
  MemoryFieldId,
  MemoryFieldKey,
  MemorySpaceId,
  MemoryTableId,
} from "../../domain/index.ts";

export interface MemoryFieldRepository {
  create(field: MemoryField): Promise<void>;
  delete(memorySpaceId: MemorySpaceId, tableId: MemoryTableId, id: MemoryFieldId): Promise<boolean>;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): Promise<MemoryField | undefined>;
  findByKey(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    key: MemoryFieldKey,
  ): Promise<MemoryField | undefined>;
  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<MemoryField[]>;
  update(field: MemoryField): Promise<boolean>;
}
