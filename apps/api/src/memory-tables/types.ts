import type {
  CreateCustomMemoryTableInput,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  UpdateMemoryTableInput,
} from "@ste-memory/core";

export interface MemoryTableManager {
  createCustom(
    memorySpaceId: MemorySpaceId,
    input: CreateCustomMemoryTableInput,
  ): MemoryTable | undefined;
  delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): boolean;
  find(memorySpaceId: MemorySpaceId, id: MemoryTableId): MemoryTable | undefined;
  list(memorySpaceId: MemorySpaceId): MemoryTable[];
  update(
    memorySpaceId: MemorySpaceId,
    id: MemoryTableId,
    input: UpdateMemoryTableInput,
  ): MemoryTable | undefined;
}
