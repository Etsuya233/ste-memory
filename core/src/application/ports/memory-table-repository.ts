import type { MemorySpaceId, MemoryTable, MemoryTableId } from "../../domain/index.ts";

export interface MemoryTableRepository {
  create(memoryTable: MemoryTable): void;
  delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): boolean;
  find(memorySpaceId: MemorySpaceId, id: MemoryTableId): MemoryTable | undefined;
  list(memorySpaceId: MemorySpaceId): MemoryTable[];
  update(memoryTable: MemoryTable): boolean;
}
