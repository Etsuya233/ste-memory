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
  ): MemoryField | undefined;
  delete(memorySpaceId: MemorySpaceId, tableId: MemoryTableId, id: MemoryFieldId): boolean;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): MemoryField | undefined;
  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): MemoryField[];
  setDisplayStrategy(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    strategy: MemoryTableDisplayStrategy,
  ): MemoryTable | undefined;
  update(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
    input: UpdateMemoryFieldInput,
  ): MemoryFieldUpdateResult | undefined;
}
