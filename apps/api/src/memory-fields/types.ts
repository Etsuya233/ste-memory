import type {
  CreateMemoryFieldInput,
  MemoryField,
  MemoryFieldId,
  MemoryFieldUpdateResult,
  MemorySpaceId,
  MemoryTable,
  MemoryTableDisplayStrategy,
  MemoryTableId,
  UpdateMemoryFieldInput,
} from "@ste-memory/core";

export interface MemoryFieldManager {
  create(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    input: CreateMemoryFieldInput,
  ): Promise<MemoryField | undefined>;
  delete(memorySpaceId: MemorySpaceId, tableId: MemoryTableId, id: MemoryFieldId): Promise<boolean>;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): Promise<MemoryField | undefined>;
  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<MemoryField[]>;
  setDisplayStrategy(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    strategy: MemoryTableDisplayStrategy,
  ): Promise<MemoryTable | undefined>;
  update(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
    input: UpdateMemoryFieldInput,
  ): Promise<MemoryFieldUpdateResult | undefined>;
}
