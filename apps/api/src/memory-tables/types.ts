import type {
  CreateMemoryTableInput,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  UpdateMemoryTableInput,
} from "@ste-memory/core";

export interface MemoryTableManager {
  create(
    memorySpaceId: MemorySpaceId,
    input: CreateMemoryTableInput,
  ): Promise<MemoryTable | undefined>;
  delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<boolean>;
  find(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<MemoryTable | undefined>;
  list(memorySpaceId: MemorySpaceId): Promise<MemoryTable[]>;
  update(
    memorySpaceId: MemorySpaceId,
    id: MemoryTableId,
    input: UpdateMemoryTableInput,
  ): Promise<MemoryTable | undefined>;
}
