import type {
  CreateMemoryTableInput,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  UpdateMemoryTableInput,
} from "@ste-memory/core";

export interface MemoryTableManager {
  create(memorySpaceId: MemorySpaceId, input: CreateMemoryTableInput): MemoryTable | undefined;
  delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): boolean;
  find(memorySpaceId: MemorySpaceId, id: MemoryTableId): MemoryTable | undefined;
  list(memorySpaceId: MemorySpaceId): MemoryTable[];
  update(
    memorySpaceId: MemorySpaceId,
    id: MemoryTableId,
    input: UpdateMemoryTableInput,
  ): MemoryTable | undefined;
}
