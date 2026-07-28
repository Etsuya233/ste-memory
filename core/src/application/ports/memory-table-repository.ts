import type {
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  MemoryTableKey,
} from "../../domain/index.ts";

export interface MemoryTableRepository {
  create(memoryTable: MemoryTable): Promise<void>;
  delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<boolean>;
  find(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<MemoryTable | undefined>;
  findByKey(memorySpaceId: MemorySpaceId, key: MemoryTableKey): Promise<MemoryTable | undefined>;
  list(memorySpaceId: MemorySpaceId): Promise<MemoryTable[]>;
  update(memoryTable: MemoryTable): Promise<boolean>;
}
