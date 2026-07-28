import type {
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  MemoryTableKey,
} from "../../domain/index.ts";

export interface MemoryTableRepository {
  create(memoryTable: MemoryTable): void;
  delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): boolean;
  find(memorySpaceId: MemorySpaceId, id: MemoryTableId): MemoryTable | undefined;
  findByKey(memorySpaceId: MemorySpaceId, key: MemoryTableKey): MemoryTable | undefined;
  list(memorySpaceId: MemorySpaceId): MemoryTable[];
  update(memoryTable: MemoryTable): boolean;
}
